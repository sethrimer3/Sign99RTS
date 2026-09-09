/**
 * Nebula background layer for Sign99.
 *
 * Overlapping radial-gradient clouds are baked into a small screen-space canvas
 * whenever the viewport changes. The cached layer is stretched over the full
 * viewport every frame, preserving the soft faction-colored ambience without
 * exposing edges from a finite non-tileable world texture.
 *
 * Color scheme mirrors the two-faction world layout:
 *   - Left half: cool blue / teal (player territory)
 *   - Center: deep purple (contested border)
 *   - Right half: warm red / orange (enemy territory)
 */

import { Camera } from './camera.js';
import { getCinematicLevel } from './cinematic.js';

interface ScreenCloudDef {
  x: number;
  y: number;
  radius: number;
  stops: Array<[number, string]>;
}

const SCREEN_CLOUDS: ScreenCloudDef[] = [
  {
    x: 0.22,
    y: 0.36,
    radius: 0.82,
    stops: [
      [0, 'rgba(20,95,210,0.28)'],
      [0.48, 'rgba(0,135,185,0.11)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
  {
    x: 0.08,
    y: 0.72,
    radius: 0.62,
    stops: [
      [0, 'rgba(0,160,200,0.12)'],
      [0.58, 'rgba(40,30,170,0.08)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
  {
    x: 0.52,
    y: 0.56,
    radius: 0.72,
    stops: [
      [0, 'rgba(65,0,115,0.16)'],
      [0.62, 'rgba(90,35,145,0.07)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
  {
    x: 0.54,
    y: 0.34,
    radius: 0.48,
    stops: [
      [0, 'rgba(145,95,15,0.10)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
  {
    x: 0.82,
    y: 0.34,
    radius: 0.74,
    stops: [
      [0, 'rgba(205,55,25,0.21)'],
      [0.55, 'rgba(185,80,0,0.10)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
  {
    x: 0.94,
    y: 0.76,
    radius: 0.58,
    stops: [
      [0, 'rgba(205,30,60,0.14)'],
      [0.62, 'rgba(180,80,0,0.08)'],
      [1, 'rgba(0,0,0,0)'],
    ],
  },
];

export class Nebula {
  private screenWisps: HTMLCanvasElement;
  private screenW = 0;
  private screenH = 0;
  private cachedCinematicLevel = -1;

  constructor() {
    this.screenWisps = document.createElement('canvas');
  }

  /**
   * Draw the cached screen-space nebula.
   * Must be called after the solid background fill and before the starfield.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    _camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    this.drawScreenWisps(ctx, screenW, screenH);
  }

  private drawScreenWisps(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    const cinematicLevel = getCinematicLevel();
    if (this.screenW !== screenW || this.screenH !== screenH || this.cachedCinematicLevel !== cinematicLevel) {
      this.screenW = screenW;
      this.screenH = screenH;
      this.cachedCinematicLevel = cinematicLevel;
      const scale = 0.35;
      this.screenWisps.width = Math.max(1, Math.ceil(screenW * scale));
      this.screenWisps.height = Math.max(1, Math.ceil(screenH * scale));
      const wctx = this.screenWisps.getContext('2d');
      if (!wctx) return;
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.clearRect(0, 0, this.screenWisps.width, this.screenWisps.height);
      const w = this.screenWisps.width;
      const h = this.screenWisps.height;

      const base = wctx.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, 'rgba(4,21,45,0.55)');
      base.addColorStop(1, 'rgba(18,7,37,0.42)');
      wctx.fillStyle = base;
      wctx.fillRect(0, 0, w, h);

      wctx.globalCompositeOperation = 'screen';
      const radiusBase = Math.max(w, h);
      for (const cloud of SCREEN_CLOUDS) {
        const cx = w * cloud.x;
        const cy = h * cloud.y;
        const grad = wctx.createRadialGradient(cx, cy, 0, cx, cy, radiusBase * cloud.radius);
        for (const [offset, color] of cloud.stops) {
          grad.addColorStop(offset, color);
        }
        wctx.fillStyle = grad;
        wctx.fillRect(0, 0, w, h);
      }

      if (cinematicLevel >= 2) {
        const copper = wctx.createRadialGradient(w * 0.70, h * 0.42, 0, w * 0.70, h * 0.42, radiusBase * 0.78);
        copper.addColorStop(0, 'rgba(227,138,74,0.16)');
        copper.addColorStop(0.34, 'rgba(198,90,46,0.09)');
        copper.addColorStop(0.72, 'rgba(107,58,34,0.045)');
        copper.addColorStop(1, 'rgba(0,0,0,0)');
        wctx.fillStyle = copper;
        wctx.fillRect(0, 0, w, h);

        wctx.globalCompositeOperation = 'multiply';
        const contrast = wctx.createLinearGradient(0, 0, w, h);
        contrast.addColorStop(0, 'rgba(24,15,12,0.05)');
        contrast.addColorStop(0.55, 'rgba(255,255,255,0)');
        contrast.addColorStop(1, 'rgba(24,15,12,0.10)');
        wctx.fillStyle = contrast;
        wctx.fillRect(0, 0, w, h);
        wctx.globalCompositeOperation = 'screen';
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.screenWisps, 0, 0, screenW, screenH);
    ctx.restore();

    if (cinematicLevel >= 3) {
      this.drawAuroraOverlay(ctx, screenW, screenH);
    }
    if (cinematicLevel >= 4) {
      this.drawNebulaStreamer(ctx, screenW, screenH);
    }
    if (cinematicLevel >= 5) {
      this.drawAuroraCurtains(ctx, screenW, screenH);
    }
  }

  /**
   * Animated aurora shimmer overlay — slowly drifting radial color washes that
   * create organic background movement absent from levels 1 and 2.
   * Drawn every frame (not baked) using performance.now() as a time source.
   * At level 4 the auroras are denser and a fourth golden wash is added.
   */
  private drawAuroraOverlay(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    const t = performance.now() / 1000;
    const radiusBase = Math.max(screenW, screenH);
    const level = getCinematicLevel();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // Alpha multiplier: level 4 auroras are stronger.
    const am = level >= 4 ? 1.45 : 1.0;

    // Teal-green aurora — drifts slowly toward the top-left quadrant.
    const ta = (0.028 + 0.012 * Math.sin(t * 0.23)) * am;
    const tg = ctx.createRadialGradient(
      screenW * (0.26 + 0.11 * Math.sin(t * 0.14)),
      screenH * (0.28 + 0.09 * Math.sin(t * 0.17 + 1.1)),
      0,
      screenW * (0.26 + 0.11 * Math.sin(t * 0.14)),
      screenH * (0.28 + 0.09 * Math.sin(t * 0.17 + 1.1)),
      radiusBase * (0.52 + 0.06 * Math.sin(t * 0.09)),
    );
    tg.addColorStop(0, `rgba(0,255,175,${ta.toFixed(3)})`);
    tg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(0, 0, screenW, screenH);

    // Magenta aurora — slowly wanders near the center.
    const ma = (0.020 + 0.009 * Math.sin(t * 0.19 + 0.8)) * am;
    const mg = ctx.createRadialGradient(
      screenW * (0.56 + 0.09 * Math.sin(t * 0.11 + 2.3)),
      screenH * (0.44 + 0.07 * Math.sin(t * 0.13 + 0.5)),
      0,
      screenW * (0.56 + 0.09 * Math.sin(t * 0.11 + 2.3)),
      screenH * (0.44 + 0.07 * Math.sin(t * 0.13 + 0.5)),
      radiusBase * (0.38 + 0.05 * Math.sin(t * 0.07 + 1.0)),
    );
    mg.addColorStop(0, `rgba(220,55,220,${ma.toFixed(3)})`);
    mg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mg;
    ctx.fillRect(0, 0, screenW, screenH);

    // Soft blue aurora — drifts in the lower-right region.
    const ba = (0.026 + 0.011 * Math.sin(t * 0.21 + 1.5)) * am;
    const bg = ctx.createRadialGradient(
      screenW * (0.76 + 0.08 * Math.sin(t * 0.16 + 1.7)),
      screenH * (0.70 + 0.06 * Math.sin(t * 0.12 + 3.1)),
      0,
      screenW * (0.76 + 0.08 * Math.sin(t * 0.16 + 1.7)),
      screenH * (0.70 + 0.06 * Math.sin(t * 0.12 + 3.1)),
      radiusBase * (0.44 + 0.04 * Math.sin(t * 0.10 + 2.0)),
    );
    bg.addColorStop(0, `rgba(35,140,255,${ba.toFixed(3)})`);
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, screenW, screenH);

    // Level 4 only: fourth golden-amber aurora that drifts across the upper-center,
    // adding a warm accent absent from all lower cinematic levels.
    if (level >= 4) {
      const ga = (0.022 + 0.010 * Math.sin(t * 0.16 + 3.4)) * am;
      const gg = ctx.createRadialGradient(
        screenW * (0.48 + 0.12 * Math.sin(t * 0.09 + 0.7)),
        screenH * (0.18 + 0.08 * Math.sin(t * 0.13 + 2.1)),
        0,
        screenW * (0.48 + 0.12 * Math.sin(t * 0.09 + 0.7)),
        screenH * (0.18 + 0.08 * Math.sin(t * 0.13 + 2.1)),
        radiusBase * (0.46 + 0.06 * Math.sin(t * 0.11 + 1.3)),
      );
      gg.addColorStop(0, `rgba(255,185,40,${ga.toFixed(3)})`);
      gg.addColorStop(0.55, `rgba(200,120,20,${(ga * 0.38).toFixed(3)})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(0, 0, screenW, screenH);
    }

    ctx.restore();
  }

  /**
   * Level 4 only: a slow diagonal nebula streamer — a faint luminous ribbon
   * that drifts across the screen using a tilted linear gradient.  This adds
   * a structural, directional quality to the background not present at level 3,
   * making the space feel like light is propagating from a distant source.
   */
  private drawNebulaStreamer(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    const t = performance.now() / 1000;

    // The streamer shifts very slowly diagonally.
    const drift = (t * 0.018) % 1;
    const ox = screenW * drift * 0.3;
    const oy = screenH * drift * 0.15;

    // Tilt the gradient across the screen (top-right → bottom-left axis).
    const x0 = screenW * 0.65 + ox;
    const y0 = -screenH * 0.10 + oy;
    const x1 = screenW * 0.25 + ox;
    const y1 = screenH * 1.10 + oy;

    const alpha = 0.028 + 0.010 * Math.sin(t * 0.07 + 1.8);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0.00, 'rgba(0,0,0,0)');
    grad.addColorStop(0.35, `rgba(140,80,200,${alpha.toFixed(3)})`);
    grad.addColorStop(0.50, `rgba(180,120,255,${(alpha * 1.6).toFixed(3)})`);
    grad.addColorStop(0.65, `rgba(140,80,200,${alpha.toFixed(3)})`);
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, screenW, screenH);
    ctx.restore();
  }

  /**
   * Level 5 only: faint flowing aurora curtains made of multiple soft ribbons.
   * This adds layered structure and motion detail without increasing brightness.
   */
  private drawAuroraCurtains(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    const t = performance.now() / 1000;
    const ribbons = [
      { x: 0.20, y: 0.18, dx: 0.10, speed: 0.12, hue: '90,180,255', alpha: 0.018 },
      { x: 0.52, y: 0.14, dx: 0.12, speed: 0.10, hue: '120,255,180', alpha: 0.014 },
      { x: 0.78, y: 0.22, dx: 0.08, speed: 0.14, hue: '255,155,90', alpha: 0.013 },
    ];

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const r of ribbons) {
      const sx = screenW * (r.x + Math.sin(t * r.speed + r.x * 8) * r.dx);
      const sy = screenH * r.y;
      const ex = sx + screenW * (0.06 + 0.03 * Math.sin(t * (r.speed * 0.7) + r.y * 5));
      const grad = ctx.createLinearGradient(sx, sy, ex, screenH * 1.08);
      const a = r.alpha + 0.004 * Math.sin(t * (r.speed * 2.6) + r.x * 11);
      grad.addColorStop(0.00, `rgba(${r.hue},${(a * 0.25).toFixed(3)})`);
      grad.addColorStop(0.26, `rgba(${r.hue},${a.toFixed(3)})`);
      grad.addColorStop(0.68, `rgba(${r.hue},${(a * 0.55).toFixed(3)})`);
      grad.addColorStop(1.00, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, screenW, screenH);
    }
    ctx.restore();
  }

}
