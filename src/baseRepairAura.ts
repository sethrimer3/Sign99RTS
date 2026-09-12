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
        ctx.globalCompositeOperation = 'lighter';
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
  const band = Math.max(9, 22 * zoom);      // thickness of the field sheet
  const hazeWidth = band * 3.2;
  const rimWidth = Math.max(1, 1.5 * zoom);

  for (let s = 0; s < SEGMENTS; s++) {
    const a0 = bearing - halfWidth + step * s;
    const a1 = a0 + step * 1.06; // slight overlap so segments read as one sheet
    const mid = a0 + step * 0.5;
    // cos^2 across the arc: the reveal dissolves angularly instead of stopping hard.
    const t = ((s + 0.5) / SEGMENTS - 0.5) * Math.PI;
    const falloff = Math.cos(t) * Math.cos(t);
    // Two travelling waves beating against each other, so the sheet breathes.
    const shimmer = 0.55 + 0.45 * Math.sin(time * 3.1 + mid * 19);
    const beat = 0.5 + 0.5 * Math.sin(time * 1.7 - mid * 11);
    const energy = proximity * falloff;
    if (energy < 0.01) continue;

    // Volume: a wide, very soft haze the sheet sits inside.
    ctx.lineWidth = hazeWidth;
    ctx.strokeStyle = rgba(colour, energy * 0.2 * (0.6 + 0.4 * shimmer));
    ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a1); ctx.stroke();

    // The sheet itself — a filled band rather than a line, so it reads as surface.
    ctx.lineWidth = band;
    ctx.strokeStyle = rgba(colour, energy * 0.7 * (0.5 + 0.5 * beat));
    ctx.beginPath(); ctx.arc(cx, cy, rr, a0, a1); ctx.stroke();

    // Rims: the surface is brightest where it ends.
    ctx.lineWidth = rimWidth;
    ctx.strokeStyle = rgba(colour, energy * 0.36 * shimmer);
    ctx.beginPath(); ctx.arc(cx, cy, rr + band * 0.5, a0, a1); ctx.stroke();
    ctx.strokeStyle = rgba(colour, energy * 0.26 * (1 - shimmer * 0.7));
    ctx.beginPath(); ctx.arc(cx, cy, rr - band * 0.5, a0, a1); ctx.stroke();

    // Radial rungs close the lattice cells; alternate cells carry the travelling wave.
    const rung = energy * (s % 3 === 0 ? 0.2 : 0.04) * (0.4 + 0.6 * shimmer);
    ctx.strokeStyle = rgba(colour, rung);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a0) * (rr - band * 0.5), cy + Math.sin(a0) * (rr - band * 0.5));
    ctx.lineTo(cx + Math.cos(a0) * (rr + band * 0.5), cy + Math.sin(a0) * (rr + band * 0.5));
    ctx.stroke();
  }
}

/**
 * Team colour at face value. `colorToCSS` scales by `Color.intensity`, which clips
 * bright team colours to white once these layers are added together.
 */
function rgba(colour: Color, alpha: number): string {
  return `rgba(${colour.r | 0},${colour.g | 0},${colour.b | 0},${alpha.toFixed(3)})`;
}
