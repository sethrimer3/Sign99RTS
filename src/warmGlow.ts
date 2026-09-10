/**
 * Shared "warm glow" bloom — a soft, luminous, additive halo traced along an
 * arbitrary {@link Path2D}.
 *
 * This is the glow that was hand-rolled inside {@link renderBuildingCoreEffect}
 * (its "soft warm shader-style bloom around the node frame" pass), lifted out so
 * any dynamic thing — laser beams, ship cores, muzzle flashes — can reuse the
 * exact same look.
 *
 * Technique: stroke the path twice with `globalCompositeOperation = 'lighter'`
 * and a warm `shadowColor`, first with a wide `shadowBlur` for the broad halo,
 * then with a tighter blur for a hotter inner ring.  The cost lives entirely in
 * `shadowBlur` (a real gaussian blur per stroke), so it is gated to the High /
 * Ultra tiers via {@link setWarmGlowTier} and callers additionally gate it
 * behind `!isLegacyGraphics()` to keep the original look reachable.
 *
 * Appearance is fully data-driven via {@link WarmGlowStyle}; every field has a
 * sensible warm default matching the building node frame.
 */

import type { VisualQuality } from './visualquality.js';

/** Warm bloom is only worth its blur cost on these tiers. */
let warmGlowEnabled = true;

/** High / Ultra only — mirrors {@link setBuildingCoreEffectTier}. */
export function setWarmGlowTier(tier: VisualQuality): void {
  warmGlowEnabled = tier === 'high' || tier === 'ultraHigh';
}

/** True when the current tier permits the blur passes. */
export function isWarmGlowEnabled(): boolean {
  return warmGlowEnabled;
}

export interface WarmGlowStyle {
  /** CSS colour of the crisp additive line. */
  strokeColor?: string;
  /** CSS colour of the blurred halo (hotter / more saturated than the line). */
  haloColor?: string;
  /** 0..1 overall strength — usually an HP or fade fraction; 0 => nothing. */
  intensity?: number;
  /** Crisp line width in device px (clamped to >= 1.5). */
  lineWidth?: number;
  /** Wide blur radius in px for the broad halo (clamped to >= 4). */
  blur?: number;
  /** Tighter blur radius for the hot inner ring (default `blur * 0.45`, >= 2). */
  innerBlur?: number;
  /** Base alpha the intensity is multiplied into (default 0.9). */
  alpha?: number;
}

const DEFAULTS = {
  strokeColor: 'rgba(255, 168, 74, 0.85)',
  haloColor: 'rgba(255, 140, 48, 0.9)',
  lineWidth: 2,
  blur: 8,
  alpha: 0.9,
};

/**
 * Trace the warm bloom along `path`.  No-op when the tier disables it or the
 * effective intensity rounds to nothing.  Leaves `ctx` state as it found it.
 */
export function renderWarmGlow(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  style: WarmGlowStyle = {},
): void {
  if (!warmGlowEnabled) return;
  const intensity = Math.max(0, Math.min(1, style.intensity ?? 1));
  if (intensity <= 0.001) return;

  const blur = style.blur ?? DEFAULTS.blur;
  const innerBlur = style.innerBlur ?? blur * 0.45;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = intensity * (style.alpha ?? DEFAULTS.alpha);
  ctx.strokeStyle = style.strokeColor ?? DEFAULTS.strokeColor;
  ctx.lineWidth = Math.max(1.5, style.lineWidth ?? DEFAULTS.lineWidth);
  ctx.shadowColor = style.haloColor ?? DEFAULTS.haloColor;
  ctx.shadowBlur = Math.max(4, blur);
  ctx.stroke(path);
  ctx.shadowBlur = Math.max(2, innerBlur);
  ctx.stroke(path);
  ctx.restore();
}

/** Convenience for the common case: a straight segment in screen space. */
export function renderWarmGlowLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  style: WarmGlowStyle = {},
): void {
  if (!warmGlowEnabled) return;
  const p = new Path2D();
  p.moveTo(x0, y0);
  p.lineTo(x1, y1);
  ctx.save();
  ctx.lineCap = 'round';
  renderWarmGlow(ctx, p, style);
  ctx.restore();
}
