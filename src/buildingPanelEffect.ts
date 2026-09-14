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
import { isWarmGlowEnabled } from './warmGlow.js';

/** Panel interior shading strength — how much brighter/darker adjacent panels can read from each other. */
const PANEL_SHADE_VARIATION = 0.14;
const PANEL_BEVEL_ALPHA = 0.32;

/** Baseline seam line alpha — dim, barely-visible grey joints, always drawn regardless of power. */
const SEAM_LINE_ALPHA = 0.22;
/** How much brighter an exposed (torn) edge reads vs. a normal interior seam. */
const SEAM_EXPOSED_BOOST = 1.8;

/** Number of traveling light trails active on a fully-powered building. */
const TRAIL_COUNT = 4;
/** World units/sec a trail travels along the seam network — twice the original per-seam crossing speed. */
const TRAIL_SPEED = 100;
/** World-unit length of the fading tail — three times the original fraction-of-seam tail. */
const TRAIL_TAIL_LENGTH = 42;
/** Max seconds of inactivity before a building's trail state is discarded (avoids leaking entries for despawned buildings). */
const TRAIL_STATE_TTL = 5;
/** Warm trail tip color, matching the game's sun glare palette. */
const TRAIL_TIP_COLOR = '255, 178, 54';
const TRAIL_CORE_COLOR = '255, 151, 40';
const TRAIL_HIGHLIGHT_COLOR = '255, 249, 190';
/** Endpoints within this world-unit distance are treated as the same structural junction. */
const JUNCTION_EPS = 0.5;

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

interface TrailParticle {
  seamIdx: number;
  /** Progress 0..1 from (x1,y1) to (x2,y2) of the current seam. */
  t: number;
  dir: 1 | -1;
  rngState: number;
  /** Recent world-local positions, oldest first, used to draw the fading tail. */
  history: { x: number; y: number }[];
}

interface BuildingTrailState {
  lastTime: number;
  particles: TrailParticle[];
}

const trailStates = new Map<number, BuildingTrailState>();

function nextRand(state: TrailParticle): number {
  state.rngState = (state.rngState + 0x6D2B79F5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function seamPoint(s: VisibleSeam, t: number): { x: number; y: number } {
  return { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t };
}

function seamLen(s: VisibleSeam): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/** Every other seam touching the given endpoint (within JUNCTION_EPS), as {seamIdx, dir the particle would head off in}. */
function junctionCandidates(seams: VisibleSeam[], px: number, py: number): { seamIdx: number; dir: 1 | -1 }[] {
  const out: { seamIdx: number; dir: 1 | -1 }[] = [];
  for (let i = 0; i < seams.length; i++) {
    const s = seams[i];
    if (Math.hypot(s.x1 - px, s.y1 - py) < JUNCTION_EPS) out.push({ seamIdx: i, dir: 1 });
    else if (Math.hypot(s.x2 - px, s.y2 - py) < JUNCTION_EPS) out.push({ seamIdx: i, dir: -1 });
  }
  return out;
}

function pickRandomSeam(seams: VisibleSeam[], rngState: TrailParticle): number {
  return Math.floor(nextRand(rngState) * seams.length) % seams.length;
}

function spawnParticle(seams: VisibleSeam[], seed: number): TrailParticle {
  const p: TrailParticle = { seamIdx: 0, t: 0, dir: 1, rngState: seed | 0, history: [] };
  p.seamIdx = pickRandomSeam(seams, p);
  p.t = nextRand(p);
  p.dir = nextRand(p) < 0.5 ? 1 : -1;
  return p;
}

/** Advances one particle by distSec seconds worth of travel, hopping to a random connected seam at every junction it reaches. */
function advanceParticle(p: TrailParticle, seams: VisibleSeam[], dt: number): void {
  let remaining = TRAIL_SPEED * dt;
  let guard = 0;
  while (remaining > 0 && guard++ < 8) {
    const s = seams[p.seamIdx];
    if (!s) { p.seamIdx = pickRandomSeam(seams, p); p.t = 0.5; continue; }
    const len = Math.max(0.001, seamLen(s));
    const tStep = (remaining / len) * p.dir;
    let newT = p.t + tStep;

    if (newT >= 0 && newT <= 1) {
      p.t = newT;
      remaining = 0;
      break;
    }

    // Reached a junction: consume the distance to the endpoint, then hop.
    const edgeT = p.dir > 0 ? 1 : 0;
    const distToEdge = Math.abs(edgeT - p.t) * len;
    remaining -= distToEdge;
    const junction = seamPoint(s, edgeT);

    const candidates = junctionCandidates(seams, junction.x, junction.y);
    if (candidates.length === 0) {
      p.dir = p.dir > 0 ? -1 : 1; // dead end: bounce back along the same seam
      p.t = edgeT;
      continue;
    }
    const pick = candidates[Math.floor(nextRand(p) * candidates.length) % candidates.length];
    p.seamIdx = pick.seamIdx;
    p.dir = pick.dir;
    p.t = pick.dir > 0 ? 0 : 1;
  }
}

function getTrailState(seed: number, timeSec: number, seams: VisibleSeam[]): BuildingTrailState {
  let state = trailStates.get(seed);
  if (!state) {
    state = { lastTime: timeSec, particles: [] };
    for (let lane = 0; lane < TRAIL_COUNT; lane++) {
      state.particles.push(spawnParticle(seams, (seed ^ (lane * 2654435761)) >>> 0));
    }
    trailStates.set(seed, state);
  }
  return state;
}

/** Drops stale per-building trail state (e.g. despawned buildings) so the map doesn't grow unbounded. */
function pruneTrailStates(timeSec: number): void {
  for (const [key, state] of trailStates) {
    if (timeSec - state.lastTime > TRAIL_STATE_TTL) trailStates.delete(key);
  }
}

/** A handful of persistent warm light trails that random-walk the seam network of a powered building, hopping to a new random seam at every junction instead of disappearing. */
export function renderBuildingSeamTrails(ctx: CanvasRenderingContext2D, opts: BuildingPanelEffectOpts): void {
  const { screenX, screenY, zoom, seams, timeSec, power, seed } = opts;
  if (seams.length === 0 || power <= 0.5) return;

  const state = getTrailState(seed, timeSec, seams);
  const dt = Math.max(0, Math.min(0.25, timeSec - state.lastTime));
  state.lastTime = timeSec;
  if (Math.random() < 0.02) pruneTrailStates(timeSec);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const globalAlpha = Math.min(1, power);

  for (const p of state.particles) {
    if (p.seamIdx >= seams.length) { const fresh = spawnParticle(seams, (nextRand(p) * 0xffffffff) | 0); p.seamIdx = fresh.seamIdx; p.t = fresh.t; p.dir = fresh.dir; p.history = []; }
    if (dt > 0) advanceParticle(p, seams, dt);

    const s = seams[p.seamIdx];
    if (!s) continue;
    const cur = seamPoint(s, Math.max(0, Math.min(1, p.t)));
    const hist = p.history;
    hist.push(cur);
    let total = 0;
    for (let i = hist.length - 1; i > 0; i--) {
      total += Math.hypot(hist[i].x - hist[i - 1].x, hist[i].y - hist[i - 1].y);
      if (total > TRAIL_TAIL_LENGTH) { hist.splice(0, i); break; }
    }
    if (hist.length < 2) continue;

    // Fading tail: walk backward from the tip, giving each segment an alpha
    // that ramps linearly from full at the tip to 0 at TRAIL_TAIL_LENGTH back.
    let distFromTip = 0;
    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1], b = hist[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const alpha = Math.max(0, 1 - distFromTip / TRAIL_TAIL_LENGTH) * globalAlpha;
      distFromTip += segLen;
      if (alpha <= 0.01) continue;
      ctx.strokeStyle = `rgba(${TRAIL_TIP_COLOR}, ${(alpha * 0.9).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(screenX + a.x * zoom, screenY + a.y * zoom);
      ctx.lineTo(screenX + b.x * zoom, screenY + b.y * zoom);
      ctx.stroke();
    }

    // Bright tip with a slight glow, matching the sun's warm core/highlight palette.
    // The shadowBlur glow is a real gaussian blur per tip per frame — only worth
    // it on High/Ultra tiers (mirrors warmGlow.ts's own gating).
    const tipX = screenX + cur.x * zoom, tipY = screenY + cur.y * zoom;
    if (isWarmGlowEnabled()) {
      ctx.shadowBlur = 5;
      ctx.shadowColor = `rgba(${TRAIL_CORE_COLOR}, ${globalAlpha.toFixed(3)})`;
    }
    ctx.fillStyle = `rgba(${TRAIL_HIGHLIGHT_COLOR}, ${globalAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}
