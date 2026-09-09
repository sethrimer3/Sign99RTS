/**
 * High-performance glowing projectile-trail renderer.
 *
 * Draws a soft, luminous, tapered ribbon behind a projectile using 1–3
 * overlapping translucent additive strokes rather than any real blur pass.
 * The trail is brightest and widest near the projectile head and fades to
 * near-zero width / opacity at the oldest sample.
 *
 * Coordinate-space contract: this renderer is handed the projectile's
 * world-space position history (`ProjectileBase.trail`) plus the live head
 * position, and projects every vertex through the SAME `Camera` transform the
 * projectile art uses (`camera.screenX/screenY`, which already fold in pan,
 * zoom and shake).  It never approximates the camera itself, so the ribbon
 * stays welded to the projectile through zooming, panning and resizing.
 * Widths are multiplied by `camera.zoom`, matching the projectile art's
 * "scales with world zoom" convention.
 *
 * Cost: ~1–3 strokes per trail segment, ~6–8 segments per projectile, no
 * per-projectile canvases / textures / filters, and no per-frame allocation
 * (screen-space scratch buffers are reused).
 *
 * Reusability: appearance is fully data-driven via {@link ProjectileTrailStyle}
 * — colour, width, taper, per-layer alpha and layer count can all be set per
 * projectile type, per weapon, or overridden per projectile / gameplay state
 * without touching this file.
 */

import type { Camera } from './camera.js';
import type { Vec2 } from './math.js';
import { getCinematicLevel } from './cinematic.js';

export interface TrailSample {
  pos: Vec2;
  age: number;
}

export interface ProjectileTrailStyle {
  /** CSS colour for the outer + inner glow layers. */
  color: string;
  /** CSS colour for the bright core layer (defaults to soft white). */
  coreColor?: string;

  /** Seconds a sample stays visible before it has fully faded from the tail. */
  fadeTime?: number;
  /** Base ribbon width near the head, in world units (scaled by camera.zoom). */
  width?: number;

  outerWidthMultiplier?: number;
  outerAlpha?: number;
  innerWidthMultiplier?: number;
  innerAlpha?: number;
  coreWidthMultiplier?: number;
  coreAlpha?: number;

  /** Width taper curve toward the tail (higher = narrows faster). */
  taperExponent?: number;
  /** Opacity fade curve toward the tail (higher = fades faster). */
  opacityExponent?: number;
}

const DEFAULTS = {
  coreColor: 'rgba(255,255,255,0.95)',
  fadeTime: 0.28,
  width: 7,
  outerWidthMultiplier: 2.4,
  outerAlpha: 0.14,
  innerWidthMultiplier: 1.0,
  innerAlpha: 0.36,
  coreWidthMultiplier: 0.4,
  coreAlpha: 0.7,
  taperExponent: 1.0,
  opacityExponent: 1.35,
};

/**
 * Number of glow layers to draw (3 = outer+inner+core, 2 = outer+inner,
 * 1 = inner only).  Driven by the graphics-quality tier from game.ts so the
 * trail scales down cheaply on low-end settings.
 */
let qualityLayers = 3;

/** High: 3, Medium: 2, Low / ultraLow: 1. Called from Game.applyVisualQuality(). */
export function setProjectileTrailLayers(layers: number): void {
  qualityLayers = Math.max(1, Math.min(3, layers | 0));
}

// Reused screen-space scratch buffers — grown on demand, never freed.
let sx = new Float32Array(32);
let sy = new Float32Array(32);
let sw = new Float32Array(32); // per-vertex width
let sa = new Float32Array(32); // per-vertex alpha
function ensureCapacity(n: number): void {
  if (sx.length >= n) return;
  let cap = sx.length;
  while (cap < n) cap *= 2;
  sx = new Float32Array(cap);
  sy = new Float32Array(cap);
  sw = new Float32Array(cap);
  sa = new Float32Array(cap);
}

/**
 * Render a tapered, glowing trail.
 *
 * @param trail    Oldest-first world-space samples (`ProjectileBase.trail`).
 * @param headPos  Live projectile world position (appended as the bright tip).
 * @param style    Appearance overrides; any omitted field uses a sensible default.
 */
export function renderProjectileTrail(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  trail: readonly TrailSample[],
  headPos: Vec2,
  style: ProjectileTrailStyle,
): void {
  const n = trail.length;
  if (n < 1) return;

  const fadeTime = style.fadeTime ?? DEFAULTS.fadeTime;
  const baseWidth = style.width ?? DEFAULTS.width;
  const taperExp = style.taperExponent ?? DEFAULTS.taperExponent;
  const opacityExp = style.opacityExponent ?? DEFAULTS.opacityExponent;
  const coreColor = style.coreColor ?? DEFAULTS.coreColor;

  const count = n + 1; // + head
  ensureCapacity(count);

  const cine = getCinematicLevel() >= 2 ? 1.32 : 1;

  for (let i = 0; i < count; i++) {
    const isHead = i === n;
    const wx = isHead ? headPos.x : trail[i].pos.x;
    const wy = isHead ? headPos.y : trail[i].pos.y;
    sx[i] = camera.screenX(wx);
    sy[i] = camera.screenY(wy);

    // head = 1 at the projectile, 0 at the oldest sample.
    const head = count > 1 ? i / (count - 1) : 1;
    const age = isHead ? 0 : trail[i].age;
    const ageFade = fadeTime > 0 ? Math.max(0, 1 - age / fadeTime) : 1;
    sa[i] = Math.pow(head, opacityExp) * ageFade;
    sw[i] = baseWidth * Math.pow(head, taperExp);
  }

  if (count < 2) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Outer glow → inner glow → bright core.  Layers share the same geometry;
  // the overlap of translucent additive strokes fakes a soft blurred edge.
  const layerW = [
    style.outerWidthMultiplier ?? DEFAULTS.outerWidthMultiplier,
    style.innerWidthMultiplier ?? DEFAULTS.innerWidthMultiplier,
    style.coreWidthMultiplier ?? DEFAULTS.coreWidthMultiplier,
  ];
  const layerA = [
    style.outerAlpha ?? DEFAULTS.outerAlpha,
    style.innerAlpha ?? DEFAULTS.innerAlpha,
    style.coreAlpha ?? DEFAULTS.coreAlpha,
  ];

  // qualityLayers 1 → inner only, 2 → outer+inner, 3 → all three.
  const first = qualityLayers >= 2 ? 0 : 1;
  const last = qualityLayers >= 3 ? 2 : 1;

  for (let layer = first; layer <= last; layer++) {
    ctx.strokeStyle = layer === 2 ? coreColor : style.color;
    const wMul = layerW[layer] * camera.zoom * cine;
    const aMul = layerA[layer] * cine;
    for (let i = 1; i < count; i++) {
      const a = sa[i - 1];
      const b = sa[i];
      const segAlpha = (a + b) * 0.5 * aMul;
      if (segAlpha <= 0.004) continue;
      const lw = (sw[i - 1] + sw[i]) * 0.5 * wMul;
      if (lw <= 0.35) continue;
      ctx.globalAlpha = segAlpha > 1 ? 1 : segAlpha;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(sx[i - 1], sy[i - 1]);
      ctx.lineTo(sx[i], sy[i]);
      ctx.stroke();
    }
  }

  ctx.restore();
}
