/**
 * Command-post repair aura.
 *
 * The base holds a weak repair field around itself — far weaker than a dedicated
 * Repair turret, so the turret keeps its job. The field itself is invisible: it
 * only lights up as a short arc where a friendly ship is close to the perimeter,
 * like energy briefly becoming visible where something brushes against it.
 */

import type { Camera } from './camera.js';
import type { Color } from './colors.js';
import { EntityType, Team, type Entity } from './entities.js';
import type { GameState } from './gamestate.js';
import { teamColor } from './teamutils.js';

/** World-unit radius of the base repair field. */
export const BASE_REPAIR_AURA_RADIUS = 560;
/** HP per second granted to friendly ships inside the field (Repair turret does ~10/s). */
export const BASE_REPAIR_AURA_RATE = 2;
/** Seconds between repair pulses. */
const BASE_REPAIR_AURA_INTERVAL = 0.25;
/** How far either side of the perimeter a ship starts revealing the field. */
const REVEAL_BAND = 150;

/** Scratch reused by both the sim tick and the renderer; never reallocated. */
const nearbyScratch: Entity[] = [];

function isRepairableShip(e: Entity, team: Team): boolean {
  return e.alive && e.team === team && e.hullDamage !== null;
}

/**
 * Repairs friendly ships inside every command post's field. Routed through
 * `Entity.repair`, the same path the Repair turret uses, so hull components come
 * back through the existing machinery.
 */
export function tickBaseRepairAura(state: GameState, dt: number): void {
  state.baseRepairAuraTimer -= dt;
  if (state.baseRepairAuraTimer > 0) return;
  state.baseRepairAuraTimer += BASE_REPAIR_AURA_INTERVAL;
  if (state.baseRepairAuraTimer <= 0) state.baseRepairAuraTimer = BASE_REPAIR_AURA_INTERVAL;
  const amount = BASE_REPAIR_AURA_RATE * BASE_REPAIR_AURA_INTERVAL;

  for (const b of state.buildings) {
    if (!b.alive || b.type !== EntityType.CommandPost || b.team === Team.Neutral) continue;
    if (b.buildProgress < 1) continue;
    const nearby = state.queryEntitiesInRange(b.position, BASE_REPAIR_AURA_RADIUS, nearbyScratch);
    for (let i = 0; i < nearby.length; i++) {
      const e = nearby[i];
      if (!isRepairableShip(e, b.team) || e.health >= e.maxHealth) continue;
      e.repair(amount);
      state.particles.emitHealing(e.position);
    }
  }
}

const SEGMENTS = 30;

/**
 * Draws the revealed arcs of every friendly base field. Nothing is drawn unless a
 * friendly ship is within `REVEAL_BAND` of the perimeter, and then only over the
 * bearing that ship occupies.
 */
export function drawBaseRepairAura(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: GameState,
  localTeam: Team,
  time: number,
): void {
  const zoom = camera.zoom;
  const rr = BASE_REPAIR_AURA_RADIUS * zoom;
  let opened = false;

  for (const b of state.buildings) {
    if (!b.alive || b.team !== localTeam || b.type !== EntityType.CommandPost) continue;
    if (b.buildProgress < 1) continue;
    const centre = camera.worldToScreen(b.position);
    const bandPx = REVEAL_BAND * zoom;
    if (centre.x < -rr - bandPx || centre.y < -rr - bandPx ||
        centre.x > ctx.canvas.width + rr + bandPx || centre.y > ctx.canvas.height + rr + bandPx) continue;

    const nearby = state.queryEntitiesInRange(b.position, BASE_REPAIR_AURA_RADIUS + REVEAL_BAND, nearbyScratch);
    const colour = teamColor(b.team);
    for (let i = 0; i < nearby.length; i++) {
      const e = nearby[i];
      if (!isRepairableShip(e, b.team)) continue;
      const dx = e.position.x - b.position.x, dy = e.position.y - b.position.y;
      const dist = Math.hypot(dx, dy);
      // Strongest right on the boundary, gone REVEAL_BAND either side of it.
      const proximity = 1 - Math.abs(dist - BASE_REPAIR_AURA_RADIUS) / REVEAL_BAND;
      if (proximity <= 0.02) continue;
      const bearing = Math.atan2(dy, dx);
      if (!opened) {
        ctx.save();
        ctx.lineCap = 'butt';
        opened = true;
      }
      drawRevealArc(ctx, centre.x, centre.y, rr, zoom, bearing, proximity, time, colour);
    }
  }
  if (opened) ctx.restore();
}

function drawRevealArc(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, rr: number, zoom: number,
  bearing: number, proximity: number, time: number,
  colour: Color,
): void {
  const halfWidth = 0.10 + 0.34 * proximity;
  const step = (halfWidth * 2) / SEGMENTS;
  const band = Math.max(9, 22 * zoom);
  const body = rgba(colour, 1);
  const seed = Math.round(bearing * 16);

  // Pass 1 — additive haze, the volume the sheet sits inside.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = band * 2.4;
  for (let s = 0; s < SEGMENTS; s++) {
    const e = energyAt(s, proximity);
    if (e < 0.01) continue;
    const a0 = bearing - halfWidth + step * s;
    ctx.strokeStyle = rgba(colour, e * 0.03);
    ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a0 + step * 1.08); ctx.stroke();
  }

  // Pass 2 — the sheet body, blended normally so the team hue survives instead of
  // summing to white the way stacked additive layers do.
  ctx.globalCompositeOperation = 'source-over';
  for (let s = 0; s < SEGMENTS; s++) {
    const e = energyAt(s, proximity);
    if (e < 0.01) continue;
    const a0 = bearing - halfWidth + step * s;
    const mid = a0 + step * 0.5;
    const n1 = hash(seed + s), n2 = hash(seed + s + 97);
    // Two incommensurate waves, so the banding never lines up into a ladder.
    const w = 0.5 + 0.5 * Math.sin(time * 2.3 + mid * 23.7 + n1 * 6.283);
    const v = 0.5 + 0.5 * Math.sin(time * 1.1 - mid * 9.1);
    ctx.lineWidth = band * (0.5 + 0.95 * n2);
    ctx.globalAlpha = Math.min(1, e * (0.66 + 0.30 * w * v));
    ctx.strokeStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, rr + (n1 - 0.5) * band * 0.55, a0, a0 + step * 1.08);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Pass 3 — sparse additive rim and rung highlights. Only some segments carry one, so
  // the interior reads as broken interference rather than an evenly segmented meter.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = Math.max(1, 1.4 * zoom);
  for (let s = 0; s < SEGMENTS; s++) {
    const e = energyAt(s, proximity);
    if (e < 0.01) continue;
    const a0 = bearing - halfWidth + step * s;
    const mid = a0 + step * 0.5;
    const n1 = hash(seed + s), n2 = hash(seed + s + 97), n3 = hash(seed + s + 211);
    const w = 0.5 + 0.5 * Math.sin(time * 2.3 + mid * 23.7 + n1 * 6.283);
    const half = band * (0.25 + 0.475 * n2);
    if (n3 > 0.34) {
      ctx.strokeStyle = rgba(colour, e * 0.3 * w);
      ctx.beginPath(); ctx.arc(cx, cy, rr + half, a0, a0 + step * (0.6 + n1)); ctx.stroke();
    }
    if (n1 > 0.62) {
      const len = half * (0.5 + n3);
      ctx.strokeStyle = rgba(colour, e * 0.4 * (0.3 + 0.7 * w));
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a0) * (rr - len), cy + Math.sin(a0) * (rr - len));
      ctx.lineTo(cx + Math.cos(a0) * (rr + len), cy + Math.sin(a0) * (rr + len));
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Angular profile: a broad saturated middle that still dissolves to nothing at both
 * ends. A plain cos^2 spent most of the arc at low alpha, which washed the team hue
 * out against a bright nebula; the flatter exponent keeps the colour and the fade.
 */
function energyAt(s: number, proximity: number): number {
  const t = ((s + 0.5) / SEGMENTS - 0.5) * Math.PI;
  return proximity * Math.pow(Math.max(0, Math.cos(t)), 0.8);
}

/** Cheap deterministic hash in [0,1) — stable per segment, so the texture never flickers. */
function hash(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Team colour at face value. `colorToCSS` scales by `Color.intensity`, which pushes
 * bright team colours toward white once these layers are added together.
 */
function rgba(colour: Color, alpha: number): string {
  return `rgba(${colour.r | 0},${colour.g | 0},${colour.b | 0},${alpha.toFixed(3)})`;
}
