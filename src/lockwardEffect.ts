/**
 * Lockward-style effect renderer for Sign99.
 *
 * Inspired by Leo L. Schwab's "Lockward" screensaver (2007): a stack of
 * concentric, translucent "combination-lock wards" — annular sectors with
 * missing teeth — that each spin at their own randomised speed and direction,
 * blink independently, and overlap like a polarized backlit display.
 *
 * In-game every ward uses a single base colour; only the shade (brightness
 * multiplier) and opacity vary between teeth, so overlapping sectors build up
 * into the layered, shifting look from the screensaver.
 *
 * Pure function, no allocations retained between frames. `seed` makes the
 * layout stable for a given caller (per waypoint marker / per base) while
 * differing between callers.
 */

import { Color, colorToCSS } from './colors.js';

export interface LockwardStyle {
  /** Base colour shared by every ward tooth. */
  color: Color;
  /** Outer radius in screen pixels (caller applies camera zoom). */
  radiusPx: number;
  /** Overall opacity multiplier, 0..1. Default 1. */
  opacity?: number;
  /** Number of concentric ward rings. Default 5. */
  rings?: number;
  /** Canvas composite op for the wards. Default 'lighter' (additive glow). */
  composite?: GlobalCompositeOperation;
}

/** Cheap deterministic hash → [0, 1). */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Draw a Lockward effect centred at (cx, cy) in screen space.
 *
 * @param timeSec  monotonically increasing seconds (drives rotation + blink)
 * @param seed     stable per-caller integer; varies the ward layout
 */
export function renderLockward(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  timeSec: number,
  seed: number,
  style: LockwardStyle,
): void {
  const outer = style.radiusPx;
  if (outer < 4) return;
  const rings = style.rings ?? 5;
  const opacity = style.opacity ?? 1;
  const innerHole = outer * 0.14;
  const col = style.color;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = style.composite ?? 'lighter';

  for (let r = 0; r < rings; r++) {
    const h0 = hash(seed * 13.13 + r * 7.7);
    const h1 = hash(seed * 4.21 + r * 19.3);
    const h2 = hash(seed * 8.88 + r * 2.9);

    // Random spin: direction from h0, speed 0.10–0.65 rad/s, random phase.
    const dir = h0 < 0.5 ? -1 : 1;
    const rot = timeSec * (0.10 + h1 * 0.55) * dir + h2 * Math.PI * 2;

    // Concentric band bounds, with a little per-ring slop so bands overlap.
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    const bandInner = innerHole + (outer - innerHole) * t0 * (0.90 + h1 * 0.16);
    const bandOuter = innerHole + (outer - innerHole) * t1 * (0.92 + h2 * 0.18);

    const segs = 5 + Math.floor(hash(seed + r * 3.1) * 9); // 5..13 teeth
    for (let s = 0; s < segs; s++) {
      const sa = hash(seed * 2.7 + r * 17.1 + s * 5.5);
      if (sa < 0.24) continue; // missing ward tooth → gap
      const sb = hash(seed * 6.3 + r * 3.7 + s * 11.9);

      // Independent blink for this tooth.
      const blink = 0.55 + 0.45 * Math.sin(timeSec * (0.6 + sb * 2.4) + sa * 12.0);
      const shade = 0.45 + sb * 0.55;                       // brightness of tooth
      const alpha = (0.10 + sa * 0.30) * blink * opacity;   // translucency
      if (alpha <= 0.012) continue;

      const step = (Math.PI * 2) / segs;
      const gap = (0.12 + sb * 0.22) * step;
      const a0 = rot + s * step;
      const a1 = a0 + step - gap;

      // Radial jitter so overlapping teeth don't align into clean rings.
      const ji = bandInner * (0.98 + sa * 0.06);
      const jo = bandOuter * (0.97 + sb * 0.10);

      ctx.fillStyle = colorToCSS(
        { r: col.r, g: col.g, b: col.b, intensity: col.intensity * shade },
        alpha,
      );
      ctx.beginPath();
      ctx.arc(0, 0, jo, a0, a1);
      ctx.arc(0, 0, ji, a1, a0, true);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
}
