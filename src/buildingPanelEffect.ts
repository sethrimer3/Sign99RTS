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

/** Baseline seam line alpha — dim, barely-visible grey joints, always drawn regardless of power. */
const SEAM_LINE_ALPHA = 0.22;
/** How much brighter an exposed (torn) edge reads vs. a normal interior seam. */
const SEAM_EXPOSED_BOOST = 1.8;

/** Number of traveling light trails active on a fully-powered building. */
const TRAIL_COUNT = 4;
/** Seconds for a trail to cross from one end of its chosen seam to the other. */
const TRAIL_PERIOD = 1.3;
/** Fraction of the seam's length the trail's fading tail covers. */
const TRAIL_TAIL_FRAC = 0.4;
/** Warm trail tip color, matching the buildings' glow palette. */
const TRAIL_TIP_COLOR = '255, 200, 120';

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

/** Thin, barely-visible opaque grey lines along every real BSP-leaf seam — always drawn so panel breakup reads as structure, not damage. */
export function renderBuildingSeamLines(ctx: CanvasRenderingContext2D, opts: BuildingPanelEffectOpts): void {
  const { screenX, screenY, zoom, seams } = opts;
  if (seams.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  for (const s of seams) {
    const x1 = screenX + s.x1 * zoom, y1 = screenY + s.y1 * zoom;
    const x2 = screenX + s.x2 * zoom, y2 = screenY + s.y2 * zoom;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) continue;

    const alpha = SEAM_LINE_ALPHA * (s.exposed ? SEAM_EXPOSED_BOOST : 1);
    ctx.strokeStyle = `rgba(70, 70, 74, ${Math.min(1, alpha).toFixed(3)})`;
    ctx.lineWidth = s.exposed ? 1.3 : 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A handful of warm light trails randomly traveling along the seam network of a powered building. */
export function renderBuildingSeamTrails(ctx: CanvasRenderingContext2D, opts: BuildingPanelEffectOpts): void {
  const { screenX, screenY, zoom, seams, timeSec, power, seed } = opts;
  if (seams.length === 0 || power <= 0.5) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  for (let lane = 0; lane < TRAIL_COUNT; lane++) {
    const laneSeed = (seed ^ (lane * 2654435761)) >>> 0;
    const laneOffset = hash01(lane, laneSeed);
    const cycle = timeSec / TRAIL_PERIOD + laneOffset;
    const runIndex = Math.floor(cycle);
    const t = cycle - runIndex; // 0..1 progress along the chosen seam this run

    const seamIdx = Math.floor(hash01(runIndex, laneSeed) * seams.length) % seams.length;
    const s = seams[seamIdx];
    const x1 = screenX + s.x1 * zoom, y1 = screenY + s.y1 * zoom;
    const x2 = screenX + s.x2 * zoom, y2 = screenY + s.y2 * zoom;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 4) continue;

    const dx = (x2 - x1) / len, dy = (y2 - y1) / len;
    const tipDist = t * len;
    const tailDist = Math.max(0, tipDist - TRAIL_TAIL_FRAC * len);
    if (tipDist - tailDist < 1) continue;

    const tailX = x1 + dx * tailDist, tailY = y1 + dy * tailDist;
    const tipX = x1 + dx * tipDist, tipY = y1 + dy * tipDist;
    const globalAlpha = Math.min(1, power);

    const grad = ctx.createLinearGradient(tailX, tailY, tipX, tipY);
    grad.addColorStop(0, `rgba(${TRAIL_TIP_COLOR}, 0)`);
    grad.addColorStop(1, `rgba(${TRAIL_TIP_COLOR}, ${(0.9 * globalAlpha).toFixed(3)})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.4;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Bright tip with a slight glow.
    ctx.shadowBlur = 5;
    ctx.shadowColor = `rgba(${TRAIL_TIP_COLOR}, ${globalAlpha.toFixed(3)})`;
    ctx.fillStyle = `rgba(255, 235, 210, ${globalAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}
