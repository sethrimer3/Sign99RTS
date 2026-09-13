/**
 * Renders the visible interior partitions of a damaged building directly from
 * its real BuildingStructureDamage BSP leaves/seams — NOT a separate
 * decorative grid. Every surviving leaf gets subtle per-panel shading; every
 * surviving seam between two leaves gets a thin glowing joint with an
 * animated light pulse traveling outward from the structural root.
 *
 * Called from BuildingBase.drawBuildingBase, inside the same structural clip
 * that already masks out removed/detached leaves, so a torn-off panel simply
 * stops being drawn — no extra bookkeeping needed here.
 */

import type { BSPLeaf, VisibleSeam } from './buildingStructureDamage.js';

/** Panel interior shading strength — how much brighter/darker adjacent panels can read from each other. */
const PANEL_SHADE_VARIATION = 0.14;
const PANEL_BEVEL_ALPHA = 0.32;

/** Baseline seam glow alpha at full power, before the traveling pulse multiplies it. */
const SEAM_BASE_GLOW = 0.5;
/** How much brighter an exposed (torn) edge reads vs. a normal interior seam. */
const SEAM_EXPOSED_BOOST = 1.5;
/** Wave cycles per rootDistance hop — controls how "tight" the traveling bands look. */
const WAVE_HOPS_PER_CYCLE = 0.85;
/** Wave cycles per second at full power. */
const WAVE_SPEED = 0.55;

function hash01(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

export interface BuildingPanelEffectOpts {
  /** Screen-space position of the building's center (matches Camera.worldToScreen). */
  screenX: number;
  screenY: number;
  /** Camera zoom — leaf coordinates are in world units relative to the building center. */
  zoom: number;
  leaves: BSPLeaf[];
  seams: VisibleSeam[];
  timeSec: number;
  seed: number;
  /** 0..1: overall activity level — full power/complete/healthy = 1, unpowered/under construction/dead = lower. Scales both glow brightness and wave speed. */
  power: number;
}

/** Subtle per-panel brightness/bevel so the surviving BSP leaves read as distinct structural panels, not a flat fill. */
export function renderBuildingPanelInteriors(ctx: CanvasRenderingContext2D, opts: BuildingPanelEffectOpts): void {
  const { screenX, screenY, zoom, leaves, seed } = opts;
  if (leaves.length === 0) return;

  ctx.save();
  for (const leaf of leaves) {
    const w = leaf.w * zoom;
    const h = leaf.h * zoom;
    if (w < 1.5 || h < 1.5) continue;
    const sx = screenX + leaf.x * zoom - w / 2;
    const sy = screenY + leaf.y * zoom - h / 2;

    const v = hash01(leaf.index, seed) * 2 - 1; // -1..1
    ctx.globalAlpha = Math.abs(v) * PANEL_SHADE_VARIATION;
    ctx.fillStyle = v >= 0 ? '#ffffff' : '#000000';
    ctx.fillRect(sx, sy, w, h);

    if (w > 4 && h > 4) {
      ctx.globalAlpha = PANEL_BEVEL_ALPHA;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = Math.max(0.5, Math.min(w, h) * 0.025);
      ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1);
    }
  }
  ctx.restore();
}

/** Thin glowing seams along real BSP-leaf boundaries, with a traveling light pulse propagating outward from the structural root. */
export function renderBuildingSeamWaves(ctx: CanvasRenderingContext2D, opts: BuildingPanelEffectOpts): void {
  const { screenX, screenY, zoom, seams, timeSec, power } = opts;
  if (seams.length === 0 || power <= 0.005) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  const waveSpeed = WAVE_SPEED * (0.35 + 0.65 * power);
  for (const s of seams) {
    const phase = s.rootDistance * WAVE_HOPS_PER_CYCLE - timeSec * waveSpeed;
    const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    const boost = s.exposed ? SEAM_EXPOSED_BOOST : 1;
    const alpha = Math.min(1, SEAM_BASE_GLOW * power * boost * (0.45 + 0.55 * pulse));
    if (alpha <= 0.01) continue;

    const x1 = screenX + s.x1 * zoom, y1 = screenY + s.y1 * zoom;
    const x2 = screenX + s.x2 * zoom, y2 = screenY + s.y2 * zoom;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) continue;

    ctx.strokeStyle = s.exposed
      ? `rgba(255, 158, 66, ${alpha.toFixed(3)})`
      : `rgba(130, 205, 255, ${alpha.toFixed(3)})`;
    ctx.lineWidth = s.exposed ? 1.5 : 1.1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}
