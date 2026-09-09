/**
 * Distant Suns / Solar Backdrop for Sign99.
 *
 * Renders one enormous warm sun far behind the battlefield, bathing the
 * scene in golden-orange solar light — molten gold core, amber halo,
 * deep red outer glow, soft violet-pink fringe where it fades into the nebula.
 *
 * Draw order: after the deep-space background fill, before the baked nebula.
 *
 * Performance design:
 * - The main radial glow is baked once into an offscreen canvas sized to the
 *   screen.  It is rebuilt only on resize (same pattern as Nebula.screenWisps).
 * - Volumetric light rays are thin tapered triangles — no blur, no getImageData.
 * - Atomic orbit lines are bright partial ellipses with animated length/alpha.
 * - Glints are tiny cross / dot primitives with a per-instance alpha ramp.
 * - Quality-scaled through four new VisualQualityPreset fields:
 *     Low    → glow only, no rays, no corona, no glints.
 *     Medium → glow + 5 subtle rays.
 *     High   → glow + 8 rays + atomic orbit lines + rare warm glints.
 */

import { Camera } from './camera.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from './constants.js';
import type { VisualQualityPreset } from './visualquality.js';
import { getCinematicLevel } from './cinematic.js';
import { isLegacyGraphics } from './graphicsmode.js';

// ---------------------------------------------------------------------------
// Sun placement (one randomized screen-fraction anchor per game load)
// ---------------------------------------------------------------------------

interface SunPlacement {
  /** Horizontal screen fraction for the sun center (0 = left, 1 = right). */
  cx: number;
  /** Vertical screen fraction for the sun center (0 = top, 1 = bottom). */
  cy: number;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createSunPlacement(): SunPlacement {
  const side = Math.floor(Math.random() * 4);
  switch (side) {
    case 0:
      return { cx: randomRange(0.14, 0.86), cy: randomRange(0.08, 0.24) };
    case 1:
      return { cx: randomRange(0.14, 0.86), cy: randomRange(0.76, 0.92) };
    case 2:
      return { cx: randomRange(0.08, 0.24), cy: randomRange(0.16, 0.84) };
    default:
      return { cx: randomRange(0.76, 0.92), cy: randomRange(0.16, 0.84) };
  }
}

const SUN_PLACEMENT = createSunPlacement();

/**
 * Anchor point in an adjacent corner from the primary sun, used to place the
 * faint level-5 quaternary dust band.
 */
const THIRD_STAR_PLACEMENT: SunPlacement = {
  cx: 1 - SUN_PLACEMENT.cx,
  cy: SUN_PLACEMENT.cy,
};

/**
 * Parallax shift per world-unit of camera displacement.
 * Increased for a stronger sense of depth when the camera pans.
 */
const PARALLAX_X = 0.036;
const PARALLAX_Y = 0.036;

/**
 * Largest parallax offset (px) the sun center can ever be pushed from its
 * screen-fraction anchor, reached when the camera sits against a world edge.
 * The baked glow canvas is padded by this much on every side so the parallax
 * blit never exposes an uncovered strip at the screen border.
 */
const PARALLAX_MAX_X = Math.ceil(WORLD_WIDTH  * 0.5 * PARALLAX_X);
const PARALLAX_MAX_Y = Math.ceil(WORLD_HEIGHT * 0.5 * PARALLAX_Y);

export function getDistantSunScreenPosition(camera: Camera, screenW: number, screenH: number): { x: number; y: number } {
  const dx = (camera.position.x - WORLD_WIDTH  * 0.5) * PARALLAX_X;
  const dy = (camera.position.y - WORLD_HEIGHT * 0.5) * PARALLAX_Y;
  return {
    x: screenW * SUN_PLACEMENT.cx - dx,
    y: screenH * SUN_PLACEMENT.cy - dy,
  };
}

// ---------------------------------------------------------------------------
// Ray counts per quality tier
// ---------------------------------------------------------------------------

const RAY_COUNT_MEDIUM = 8;
const RAY_COUNT_HIGH   = 14;

// ---------------------------------------------------------------------------
// Glint pool
// ---------------------------------------------------------------------------

interface Glint {
  /** Screen-fraction X center. */
  x: number;
  /** Screen-fraction Y center. */
  y: number;
  life: number;
  maxLife: number;
  /** Half-size (px) for the cross arms. */
  size: number;
}

// ---------------------------------------------------------------------------
// DistantSuns
// ---------------------------------------------------------------------------

export class DistantSuns {
  /** Pre-baked radial glow canvas (screen-sized, rebuilt on resize). */
  private glowCanvas: HTMLCanvasElement;
  private screenW = 0;
  private screenH = 0;
  private bakedCinematicLevel = -1;

  /**
   * Offscreen light buffer for volumetric rays — rendered at half resolution,
   * then composited back with a blur filter to eliminate hard polygon edges and
   * overlap seam artifacts.  Cached and resized only when the screen changes.
   */
  private lightCanvas: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D | null = null;
  private lightW = 0;
  private lightH = 0;

  /** Accumulated time for shimmer / ray / corona animation. */
  private time = 0;

  // Quality flags (set by configure())
  private enabled   = true;
  private raysEnabled   = false;
  private coronaEnabled = false;
  private glintsEnabled = false;

  // Glint pool
  private glints: Glint[] = [];
  private glintCooldown = 1.5;

  constructor() {
    this.glowCanvas = document.createElement('canvas');
    this.glowCanvas.width  = 1;
    this.glowCanvas.height = 1;
    this.lightCanvas = document.createElement('canvas');
    this.lightCanvas.width  = 1;
    this.lightCanvas.height = 1;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Apply a visual quality preset.  Resets the bake-dirty flag so the glow
   * canvas is rebuilt at the next draw call.
   */
  configure(preset: VisualQualityPreset): void {
    this.enabled       = preset.distantSunsEnabled;
    this.raysEnabled   = preset.distantSunsRays;
    this.coronaEnabled = preset.distantSunsCorona;
    this.glintsEnabled = preset.distantSunsGlints;
    // Force re-bake at next draw call.
    this.screenW = 0;
    this.screenH = 0;
  }

  // -------------------------------------------------------------------------
  // Fixed-tick update (driven from game.ts at DT = 1/60 s)
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;

    // Cross-shine "+" glints are a legacy-only lens-flare effect now.
    if (!this.enabled || !this.glintsEnabled || !isLegacyGraphics()) return;

    // Age existing glints.
    for (const g of this.glints) {
      if (g.life > 0) g.life -= dt;
    }

    // Spawn new glint on cooldown.
    this.glintCooldown -= dt;
    if (this.glintCooldown <= 0) {
      this.spawnGlint();
      const level = getCinematicLevel();
      this.glintCooldown = level === 0 ? 2.0 + Math.random() * 3.5 : level === 1 ? 1.15 + Math.random() * 2.25 : level === 2 ? 0.70 + Math.random() * 1.60 : 0.40 + Math.random() * 0.90;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Draw the distant suns layer.
   * Must be called after the solid background fill and before nebula.draw().
   */
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    if (!this.enabled) return;
    if (getCinematicLevel() < 0) return;

    // Rebuild baked glow when screen changes.
    const currentCinematicLevel = getCinematicLevel();
    if (screenW !== this.screenW || screenH !== this.screenH || currentCinematicLevel !== this.bakedCinematicLevel) {
      this.screenW = screenW;
      this.screenH = screenH;
      this.bakedCinematicLevel = currentCinematicLevel;
      this.bakeSunGlow();
    }

    // Resize half-resolution light buffer when screen changes.
    const lw = Math.max(1, Math.round(screenW / 2));
    const lh = Math.max(1, Math.round(screenH / 2));
    if (lw !== this.lightW || lh !== this.lightH) {
      this.lightW = lw;
      this.lightH = lh;
      this.lightCanvas.width  = lw;
      this.lightCanvas.height = lh;
      this.lightCtx = this.lightCanvas.getContext('2d');
    }

    // Effective screen-space sun center.  Sourced from the SAME helper the
    // building/ship shading uses so the glow, rays, core and orbit lines can
    // never drift apart from each other (or from the lit scene) after a resize
    // or a long camera pan.
    const { x: cx, y: cy } = getDistantSunScreenPosition(camera, screenW, screenH);
    // Parallax shift of the sun center from its plain screen-fraction anchor.
    const dx = screenW * SUN_PLACEMENT.cx - cx;
    const dy = screenH * SUN_PLACEMENT.cy - cy;

    // 1 — Baked radial glow (all quality levels).  The bake is padded by the
    // maximum parallax on every side; blit it back shifted by the current
    // parallax so the glow stays welded to `cx,cy` without exposing an edge.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.glowCanvas, -PARALLAX_MAX_X - dx, -PARALLAX_MAX_Y - dy);
    ctx.restore();

    if (getCinematicLevel() >= 5) {
      this.drawQuaternaryDustBand(ctx, camera, screenW, screenH);
    }

    // 2 — Warm directional screen fill (all quality levels).
    this.drawScreenWarmth(ctx, cx, cy, screenW, screenH);

    // 2b - Dark copper-brown contrast pocket around the flare.
    if (getCinematicLevel() > 0) {
      this.drawCinematicSolarContrast(ctx, cx, cy, screenW, screenH);
    }

    // 3 — Volumetric light rays (medium / high).
    // Drawn into a half-resolution offscreen buffer then composited back with
    // a blur filter — this eliminates hard polygon edges and overlap seams.
    if (this.raysEnabled && this.lightCtx) {
      const level = getCinematicLevel();
      const count = level === 0
        ? (this.coronaEnabled ? 10 : 6)
        : level === 1
          ? (this.coronaEnabled ? RAY_COUNT_HIGH : RAY_COUNT_MEDIUM)
          : level === 2
            ? (this.coronaEnabled ? 18 : 10)
            : level === 3
              ? (this.coronaEnabled ? 22 : 14)
                : level === 4
                  ? (this.coronaEnabled ? 28 : 18)
                  : (this.coronaEnabled ? 32 : 20);
      const lc = this.lightCtx;
      lc.clearRect(0, 0, this.lightW, this.lightH);
      // Scale sun position to half-res buffer coordinates.
      this.drawRays(lc, cx * 0.5, cy * 0.5, this.lightW, this.lightH, count);
      // Composite with a blur to soften beam edges into atmospheric light shafts.
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.filter = 'blur(8px)';
      ctx.drawImage(this.lightCanvas, 0, 0, screenW, screenH);
      ctx.restore();
    }

    // 3b - Hot solar body, drawn after rays so the core feels dense and bright.
    if (getCinematicLevel() > 0) {
      this.drawSolarCore(ctx, cx, cy, screenW, screenH);
    }

    // 4 - Back half of atomic orbit lines (high only).
    if (this.coronaEnabled && this.lightCtx) {
      this.compositeAtomicOrbitLayer(ctx, cx, cy, screenW, screenH, false);
    }

    // 5 - Rare warm glints (legacy only — the cross "+" shine reads cheesy).
    if (this.glintsEnabled && isLegacyGraphics()) {
      this.drawGlints(ctx, screenW, screenH);
    }

    // 6 - Front half of atomic orbit lines (high only).
    if (this.coronaEnabled && this.lightCtx) {
      this.compositeAtomicOrbitLayer(ctx, cx, cy, screenW, screenH, true);
    }
  }

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------

  /**
   * Render the sun's radial glow gradient into the offscreen canvas.
   * The canvas is screen-sized; the gradient is anchored at the randomized sun
   * position and reaches far enough to spill warmth across the whole viewport.
   */
  private bakeSunGlow(): void {
    const w = this.screenW;
    const h = this.screenH;
    // Pad the bake so the parallax blit in draw() never runs off the canvas.
    const padX = PARALLAX_MAX_X;
    const padY = PARALLAX_MAX_Y;
    this.glowCanvas.width  = w + padX * 2;
    this.glowCanvas.height = h + padY * 2;

    const ctx = this.glowCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.glowCanvas.width, this.glowCanvas.height);

    const cx = w * SUN_PLACEMENT.cx + padX;
    const cy = h * SUN_PLACEMENT.cy + padY;
    const level = Math.min(2, getCinematicLevel());
    // Radius generous enough to bathe the whole screen in warmth.
    const r  = Math.hypot(w, h) * (level === 0 ? 1.18 : level === 1 ? 1.28 : level === 2 ? 1.38 : level === 3 ? 1.48 : level === 4 ? 1.55 : level === 5 ? 1.62 : level === 6 ? 1.68 : level === 7 ? 1.74 : level === 8 ? 1.80 : 1.86);

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    if (level === 0) {
      grad.addColorStop(0.000, 'rgba(255,255,225,0.94)');
      grad.addColorStop(0.012, 'rgba(255,235,145,0.86)');
      grad.addColorStop(0.032, 'rgba(255,192,70,0.70)');
      grad.addColorStop(0.068, 'rgba(242,132,34,0.48)');
      grad.addColorStop(0.135, 'rgba(200,72,18,0.28)');
      grad.addColorStop(0.270, 'rgba(148,32,48,0.14)');
      grad.addColorStop(0.460, 'rgba(88,14,88,0.07)');
      grad.addColorStop(0.720, 'rgba(42,7,62,0.03)');
    } else {
      const boost = level === 2 ? 1.18 : 1;
      grad.addColorStop(0.000, `rgba(255,218,166,${Math.min(1, 0.98 * boost).toFixed(3)})`);
      grad.addColorStop(0.014, `rgba(227,138,74,${Math.min(1, 0.96 * boost).toFixed(3)})`);
      grad.addColorStop(0.040, `rgba(198,90,46,${Math.min(1, 0.92 * boost).toFixed(3)})`);
      grad.addColorStop(0.082, `rgba(163,71,40,${Math.min(1, 0.72 * boost).toFixed(3)})`);
      grad.addColorStop(0.165, `rgba(138,47,31,${Math.min(1, 0.50 * boost).toFixed(3)})`);
      grad.addColorStop(0.330, `rgba(107,58,34,${Math.min(1, 0.30 * boost).toFixed(3)})`);
      grad.addColorStop(0.590, `rgba(58,32,21,${Math.min(1, 0.150 * boost).toFixed(3)})`);
      grad.addColorStop(0.830, `rgba(24,15,12,${Math.min(1, 0.065 * boost).toFixed(3)})`);
    }
    grad.addColorStop(1.000, 'rgba(0,0,0,0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.glowCanvas.width, this.glowCanvas.height);
  }

  // -------------------------------------------------------------------------
  // Screen-space directional warmth (all quality levels)
  // -------------------------------------------------------------------------

  /**
   * Draw a very faint warm radial overlay extending from the sun across the
   * whole screen.  This subtly tints everything in the sun's direction without
   * washing out gameplay objects.
   */
  private drawScreenWarmth(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const level = Math.min(2, getCinematicLevel());
    const r = Math.hypot(w, h) * (level === 0 ? 0.98 : level === 1 ? 1.08 : level === 2 ? 1.22 : level === 3 ? 1.36 : 1.50);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    if (level === 0) {
      grad.addColorStop(0.00, 'rgba(255,182,62,0.065)');
      grad.addColorStop(0.30, 'rgba(220,122,40,0.042)');
      grad.addColorStop(0.65, 'rgba(160,58,18,0.022)');
    } else {
      const boost = level === 2 ? 1.34 : 1;
      grad.addColorStop(0.00, `rgba(227,138,74,${(0.165 * boost).toFixed(3)})`);
      grad.addColorStop(0.24, `rgba(198,90,46,${(0.112 * boost).toFixed(3)})`);
      grad.addColorStop(0.56, `rgba(163,71,40,${(0.066 * boost).toFixed(3)})`);
      grad.addColorStop(0.82, `rgba(107,58,34,${(0.038 * boost).toFixed(3)})`);
    }
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * Adds a soft umber pressure gradient around the hottest flare so the sun has
   * filmic contrast instead of flattening the whole background brighter.
   */
  private drawCinematicSolarContrast(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';

    const r = Math.hypot(w, h) * 0.86;
    const grad = ctx.createRadialGradient(cx, cy, Math.max(w, h) * 0.055, cx, cy, r);
    grad.addColorStop(0.00, 'rgba(255,255,255,0)');
    grad.addColorStop(0.26, 'rgba(107,58,34,0.045)');
    grad.addColorStop(0.58, 'rgba(58,32,21,0.080)');
    grad.addColorStop(1.00, 'rgba(24,15,12,0.115)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * Draws a compact asymmetric solar disc/corona so the flare has a visible
   * cinematic source, not only a broad gradient.
   */
  private drawSolarCore(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    const size = Math.max(w, h);
    const coreR = size * 0.055;
    const coronaR = size * 0.155;
    const pulse = 0.92 + 0.08 * Math.sin(this.time * 0.42);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const corona = ctx.createRadialGradient(cx, cy, coreR * 0.15, cx, cy, coronaR * pulse);
    corona.addColorStop(0.00, 'rgba(255,218,166,0.88)');
    corona.addColorStop(0.24, 'rgba(227,138,74,0.52)');
    corona.addColorStop(0.52, 'rgba(198,90,46,0.24)');
    corona.addColorStop(0.82, 'rgba(138,47,31,0.10)');
    corona.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(cx, cy, coronaR * pulse, 0, Math.PI * 2);
    ctx.fill();

    const core = ctx.createRadialGradient(cx - coreR * 0.22, cy - coreR * 0.18, 0, cx, cy, coreR);
    core.addColorStop(0.00, 'rgba(255,236,190,0.98)');
    core.addColorStop(0.30, 'rgba(227,138,74,0.92)');
    core.addColorStop(0.68, 'rgba(198,90,46,0.72)');
    core.addColorStop(1.00, 'rgba(138,47,31,0.18)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * pulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Volumetric light rays (medium / high)
  // -------------------------------------------------------------------------

  /**
   * Draw soft feathered light rays emanating from the sun center.
   * Each ray is rendered as three layered semi-transparent passes of decreasing
   * width, producing a natural alpha-falloff from the ray axis toward the edges.
   * This creates a cinematic "shaft of light" appearance without any blur calls.
   */
  private drawRays(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    count: number,
  ): void {
    const level = Math.min(2, getCinematicLevel());
    const len = Math.hypot(w, h) * (level === 0 ? 0.82 : level === 1 ? 1.14 : level === 2 ? 1.30 : level === 3 ? 1.42 : level === 4 ? 1.54 : level === 5 ? 1.62 : level === 6 ? 1.70 : 1.78);
    const rot = this.time * 0.007;   // very slow global rotation

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (let i = 0; i < count; i++) {
      // Slightly irregular spacing with a slow wobble per ray.
      const baseAngle  = (i / count) * Math.PI * 2 + rot;
      const wobble     = Math.sin(this.time * 0.22 + i * 1.13) * (level === 0 ? 0.04 : level === 1 ? 0.065 : level === 2 ? 0.085 : level === 3 ? 0.105 : level === 4 ? 0.125 : level === 5 ? 0.136 : level === 6 ? 0.148 : 0.162);
      const angle      = baseAngle + wobble;

      const tipX = cx + Math.cos(angle) * len;
      const tipY = cy + Math.sin(angle) * len;

      // Perpendicular unit vector for controlling base width.
      const px = -Math.sin(angle);
      const py =  Math.cos(angle);

      // Per-ray flicker (subtle).  Alpha reduced slightly — the blur on composite
      // spreads each beam wider, so lower per-pass alpha keeps overall brightness
      // balanced while reducing visible overlap seams.
      const flicker = (level === 0 ? 0.036 : level === 1 ? 0.080 : level === 2 ? 0.110 : level === 3 ? 0.130 : level === 4 ? 0.150 : level === 5 ? 0.162 : level === 6 ? 0.174 : 0.188)
        + (level === 0 ? 0.016 : level === 1 ? 0.034 : level === 2 ? 0.046 : level === 3 ? 0.056 : level === 4 ? 0.068 : level === 5 ? 0.076 : level === 6 ? 0.084 : 0.094) * Math.sin(this.time * 0.72 + i * 0.88);

      // Build a gradient that fades from bright at base to transparent at tip.
      const makeGrad = (alpha: number): CanvasGradient => {
        const g = ctx.createLinearGradient(cx, cy, tipX, tipY);
        if (level === 0) {
          g.addColorStop(0.00, `rgba(255,215,95,${(alpha).toFixed(3)})`);
          g.addColorStop(0.18, `rgba(255,168,60,${(alpha * 0.72).toFixed(3)})`);
          g.addColorStop(0.50, `rgba(240,108,32,${(alpha * 0.30).toFixed(3)})`);
          g.addColorStop(0.80, `rgba(200,70,18,${(alpha * 0.08).toFixed(3)})`);
        } else {
          const boost = level >= 9 ? 1.82 : level >= 8 ? 1.68 : level >= 7 ? 1.56 : level >= 6 ? 1.42 : level >= 5 ? 1.34 : level >= 3 ? 1.26 : level === 2 ? 1.16 : 1;
          g.addColorStop(0.00, `rgba(227,138,74,${Math.min(1, alpha * boost).toFixed(3)})`);
          g.addColorStop(0.18, `rgba(198,90,46,${Math.min(1, alpha * 0.80 * boost).toFixed(3)})`);
          g.addColorStop(0.50, `rgba(163,71,40,${Math.min(1, alpha * 0.42 * boost).toFixed(3)})`);
          g.addColorStop(0.82, `rgba(107,58,34,${Math.min(1, alpha * 0.14 * boost).toFixed(3)})`);
        }
        g.addColorStop(1.00, 'rgba(0,0,0,0)');
        return g;
      };

      const drawPass = (halfWidthMult: number, alphaScale: number): void => {
        const hw = len * (level === 0 ? 0.022 : level === 1 ? 0.036 : level === 2 ? 0.045 : level === 3 ? 0.052 : level === 4 ? 0.055 : level === 5 ? 0.059 : level === 6 ? 0.063 : level === 7 ? 0.068 : 0.074) * halfWidthMult;
        ctx.fillStyle = makeGrad(flicker * alphaScale);
        ctx.beginPath();
        ctx.moveTo(cx + px * hw, cy + py * hw);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(cx - px * hw, cy - py * hw);
        ctx.closePath();
        ctx.fill();
      };

      // Five passes with quadratic-style falloff from core to edges.
      // Combined with the 8 px blur on composite, these produce soft atmospheric
      // light shafts rather than hard transparent polygons.
      drawPass(level === 0 ? 6.0 : level === 1 ? 7.4 : level === 2 ? 9.0 : level === 3 ? 10.5 : level === 4 ? 11.2 : level === 5 ? 12.0 : level === 6 ? 12.8 : level === 7 ? 13.8 : level === 8 ? 14.8 : 16.0, level === 0 ? 0.15 : level >= 9 ? 0.25 : level >= 8 ? 0.22 : level >= 7 ? 0.20 : level >= 6 ? 0.18 : 0.16);
      drawPass(level === 0 ? 4.0 : level === 1 ? 5.0 : level === 2 ? 6.0 : level === 3 ? 7.0 : level === 4 ? 7.8 : level === 5 ? 8.6 : level === 6 ? 9.4 : level === 7 ? 10.2 : level === 8 ? 11.0 : 12.2,  level === 0 ? 0.28 : level >= 9 ? 0.44 : level >= 8 ? 0.40 : level >= 7 ? 0.37 : level >= 6 ? 0.33 : 0.30);
      drawPass(level === 0 ? 2.5 : level === 1 ? 3.0 : level === 2 ? 3.8 : level === 3 ? 4.4 : level === 4 ? 4.8 : level === 5 ? 5.2 : level === 6 ? 5.8 : level === 7 ? 6.4 : level === 8 ? 7.0 : 7.8,  level === 0 ? 0.46 : level >= 9 ? 0.72 : level >= 8 ? 0.65 : level >= 7 ? 0.60 : level >= 6 ? 0.54 : 0.50);
      drawPass(level === 0 ? 1.6 : level === 1 ? 1.8 : level === 2 ? 2.2 : level === 3 ? 2.6 : level === 4 ? 2.9 : level === 5 ? 3.2 : level === 6 ? 3.5 : level === 7 ? 3.8 : level === 8 ? 4.2 : 4.8,  level === 0 ? 0.68 : level >= 9 ? 1.00 : level >= 8 ? 0.92 : level >= 7 ? 0.86 : level >= 6 ? 0.78 : 0.72);
      drawPass(1.0, 1.00);  // core spine — narrowest, brightest
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Atomic orbit lines (high only)
  // -------------------------------------------------------------------------

  /**
   * Render one half (front / back of the solar core) of the spinning orbit
   * "trails" into the shared half-resolution light buffer, then composite it
   * back over the scene through a blur filter — the exact soft-shaft technique
   * the volumetric rays use.  Each arc itself is drawn by
   * {@link drawAtomicOrbitTrail} as a tapered, additively-layered ribbon in the
   * style of the ship / projectile motion trails.
   */
  private compositeAtomicOrbitLayer(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    screenW: number,
    screenH: number,
    front: boolean,
  ): void {
    const lc = this.lightCtx;
    if (!lc) return;

    lc.clearRect(0, 0, this.lightW, this.lightH);
    // Half-resolution buffer — scale the sun center to match.
    this.drawAtomicOrbitTrails(lc, cx * 0.5, cy * 0.5, this.lightW, this.lightH, front);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // Slightly tighter than the ray blur so the trails still read as strokes.
    ctx.filter = 'blur(5px)';
    ctx.drawImage(this.lightCanvas, 0, 0, screenW, screenH);
    ctx.restore();
  }

  /**
   * Draw bright, partial, slowly shifting orbit trails around the sun.  The
   * front/back split makes some strokes appear to pass behind the solar core.
   *
   * Each arc is sampled into a short polyline and stroked as 3 overlapping
   * additive layers (outer glow → inner glow → bright core) whose per-vertex
   * width and opacity taper from a bright, wide leading head to a vanishing
   * tail — the same construction {@link renderProjectileTrail} uses for ship
   * and projectile trails.
   */
  private drawAtomicOrbitTrails(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    front: boolean,
  ): void {
    const level = getCinematicLevel();
    const baseR = Math.max(w, h) * (level === 0 ? 0.052 : level === 1 ? 0.064 : level === 2 ? 0.078 : 0.092);
    const orbitCount = level === 0 ? 7 : level === 1 ? 9 : level === 2 ? 11 : 14;
    const baseLineW = Math.max(0.6, Math.max(w, h) * (level === 0 ? (front ? 0.00125 : 0.00085) : level === 1 ? (front ? 0.00155 : 0.00105) : level === 2 ? (front ? 0.0019 : 0.0013) : (front ? 0.0023 : 0.0016)));

    // Trail glow layers: [width multiplier, alpha multiplier, colour].
    const glow = level === 0
      ? (front ? '255,245,176' : '255,178,68')
      : (front ? '227,138,74' : '198,90,46');
    const coreCol = front ? '255,239,205' : '255,214,158';
    const layers: Array<[number, number, string]> = [
      [3.6, 0.16, glow],
      [1.7, 0.40, glow],
      [0.6, 0.82, coreCol],
    ];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let orbit = 0; orbit < orbitCount; orbit++) {
      const seed = orbit * 1.71;
      const phase = this.time * (0.15 + orbit * 0.018) + seed;
      const inFront = Math.sin(phase + orbit * 0.63) >= 0;
      if (inFront !== front) continue;

      const lengthPulse = 0.58 + 0.28 * Math.sin(this.time * (0.28 + orbit * 0.03) + seed);
      const arcLength = Math.PI * Math.max(0.32, lengthPulse);
      const startA = phase + Math.sin(this.time * 0.21 + seed) * 0.65;
      const r = baseR * (0.82 + orbit * 0.16) * (1 + 0.055 * Math.sin(this.time * 0.34 + seed));
      const yScale = 0.24 + (orbit % 4) * 0.105;
      const tilt = orbit * Math.PI / orbitCount + this.time * (0.022 - orbit * 0.0018);
      const alphaPulse = 0.50 + 0.50 * Math.sin(this.time * (0.42 + orbit * 0.05) + seed * 0.7);
      const alpha = (level === 0 ? (front ? 0.46 : 0.22) : level === 1 ? (front ? 0.58 : 0.30) : level === 2 ? (front ? 0.72 : 0.40) : (front ? 0.84 : 0.50)) * alphaPulse;
      if (alpha < 0.035) continue;

      // Sample the arc into a polyline (oldest tail → leading head).
      const SEG = 30;
      const rx = r;
      const ry = r * yScale;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const px: number[] = [];
      const py: number[] = [];
      for (let s = 0; s <= SEG; s++) {
        const ang = startA + arcLength * (s / SEG);
        const ex = Math.cos(ang) * rx;
        const ey = Math.sin(ang) * ry;
        px.push(cx + ex * cosT - ey * sinT);
        py.push(cy + ex * sinT + ey * cosT);
      }

      for (const [wMul, aMul, col] of layers) {
        ctx.strokeStyle = `rgba(${col},1)`;
        for (let s = 1; s <= SEG; s++) {
          // head = 1 at the leading tip, 0 at the oldest tail sample.
          const t0 = (s - 1) / SEG;
          const t1 = s / SEG;
          const segAlpha = alpha * aMul * (Math.pow(t0, 1.4) + Math.pow(t1, 1.4)) * 0.5;
          if (segAlpha <= 0.004) continue;
          const lw = baseLineW * wMul * (Math.pow(t0, 1.05) + Math.pow(t1, 1.05)) * 0.5;
          if (lw <= 0.2) continue;
          ctx.globalAlpha = segAlpha > 1 ? 1 : segAlpha;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(px[s - 1], py[s - 1]);
          ctx.lineTo(px[s], py[s]);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Glint management (high only)
  // -------------------------------------------------------------------------

  private spawnGlint(): void {
    const level = getCinematicLevel();
    let slot = this.glints.find((g) => g.life <= 0);
    if (!slot && this.glints.length < (level === 0 ? 5 : level === 1 ? 8 : level === 2 ? 12 : 18)) {
      slot = { x: 0, y: 0, life: 0, maxLife: 0, size: 0 };
      this.glints.push(slot);
    }
    if (!slot) return;

    // Scatter glints near the sun center (screen-fraction coords).
    const a   = Math.random() * Math.PI * 2;
    const d   = level === 0 ? 0.03 + Math.random() * 0.10 : 0.025 + Math.random() * (level === 1 ? 0.145 : level === 2 ? 0.19 : 0.24);
    slot.x       = SUN_PLACEMENT.cx + Math.cos(a) * d * (level === 0 ? 0.72 : level === 1 ? 0.82 : level === 2 ? 0.95 : 1.10);
    slot.y       = SUN_PLACEMENT.cy + Math.sin(a) * d * (level === 0 ? 0.44 : level === 1 ? 0.52 : level === 2 ? 0.62 : 0.74);
    slot.maxLife = level === 0 ? 0.5 + Math.random() * 0.85 : 0.65 + Math.random() * (level === 1 ? 1.05 : level === 2 ? 1.35 : 1.65);
    slot.life    = slot.maxLife;
    slot.size    = level === 0 ? 2.5 + Math.random() * 5.5 : 3.5 + Math.random() * (level === 1 ? 7.5 : level === 2 ? 10.5 : 13.5);
  }

  /**
   * Draw lens-flare-like warm glints — tiny cross / dot shapes that fade in
   * and out near the sun.
   */
  private drawGlints(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ): void {
    if (this.glints.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const level = getCinematicLevel();

    for (const g of this.glints) {
      if (g.life <= 0) continue;
      const t     = g.life / g.maxLife;
      const alpha = Math.sin(t * Math.PI) * (level === 0 ? 0.88 : level === 1 ? 0.96 : level === 2 ? 1.08 : 1.18);  // smooth fade in/out
      const gx    = g.x * w;
      const gy    = g.y * h;
      const r     = g.size * (0.38 + t * 0.62);

      // At level 3: chromatic aberration — draw offset red and blue fringe spikes first.
      if (level >= 3) {
        const offset = r * 0.22;
        const fringeAlpha = Math.min(1, alpha * 0.48);
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = `rgba(255,80,40,${fringeAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(gx + offset, gy - r * 3.8);
        ctx.lineTo(gx + offset, gy + r * 3.8);
        ctx.moveTo(gx - r * 3.8, gy + offset);
        ctx.lineTo(gx + r * 3.8, gy + offset);
        ctx.stroke();
        ctx.strokeStyle = `rgba(40,130,255,${fringeAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(gx - offset, gy - r * 3.8);
        ctx.lineTo(gx - offset, gy + r * 3.8);
        ctx.moveTo(gx - r * 3.8, gy - offset);
        ctx.lineTo(gx + r * 3.8, gy - offset);
        ctx.stroke();
      }

      // Four-point cross (diffraction spike feel).
      ctx.strokeStyle = level === 0 ? `rgba(255,242,155,${alpha.toFixed(3)})` : `rgba(227,138,74,${Math.min(1, alpha).toFixed(3)})`;
      ctx.lineWidth   = 0.7;
      ctx.beginPath();
      ctx.moveTo(gx, gy - r * 3.8);
      ctx.lineTo(gx, gy + r * 3.8);
      ctx.moveTo(gx - r * 3.8, gy);
      ctx.lineTo(gx + r * 3.8, gy);
      ctx.stroke();

      // Bright center dot.
      ctx.fillStyle = level === 0 ? `rgba(255,255,215,${(alpha * 0.68).toFixed(3)})` : `rgba(255,218,166,${Math.min(1, alpha * (level === 1 ? 0.76 : 0.9)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(gx, gy, Math.max(0.4, r * 0.52), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Level 5 only: faint quaternary dust band in an adjacent corner.
   * This adds layered color separation and motion detail without raising glow gain.
   */
  private drawQuaternaryDustBand(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    screenW: number,
    screenH: number,
  ): void {
    const dx = (camera.position.x - WORLD_WIDTH * 0.5) * PARALLAX_X * 0.64;
    const dy = (camera.position.y - WORLD_HEIGHT * 0.5) * PARALLAX_Y * 0.64;
    const cx = screenW * THIRD_STAR_PLACEMENT.cx - dx;
    const cy = screenH * THIRD_STAR_PLACEMENT.cy - dy;
    const arcR = Math.max(screenW, screenH) * 0.16;
    const drift = this.time * 0.013;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.translate(cx, cy);
    ctx.rotate(0.35 + Math.sin(drift) * 0.14);

    const ring = ctx.createRadialGradient(0, 0, arcR * 0.42, 0, 0, arcR * 1.18);
    ring.addColorStop(0.00, 'rgba(255,185,115,0.016)');
    ring.addColorStop(0.34, 'rgba(220,130,80,0.020)');
    ring.addColorStop(0.66, 'rgba(110,75,120,0.015)');
    ring.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.ellipse(0, 0, arcR * 1.45, arcR * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(175,125,255,${(0.045 + 0.015 * Math.sin(drift * 6.2)).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.5, arcR * 0.008);
    ctx.beginPath();
    ctx.ellipse(0, 0, arcR * 1.18, arcR * 0.42, 0, drift * 2.1, drift * 2.1 + Math.PI * 1.25);
    ctx.stroke();
    ctx.restore();
  }

}
