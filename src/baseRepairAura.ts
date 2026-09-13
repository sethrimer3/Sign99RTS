/**
 * Command-post repair aura.
 *
 * The base holds a weak repair field around itself — far weaker than a dedicated
 * Repair turret, so the turret keeps its job. The field itself is invisible at
 * rest: it only fades into view, as a whole Lockward-style ring around the
 * perimeter, once a friendly ship (player, fighter, or teammate) gets close to
 * its edge. The ring never stretches or reshapes toward whoever triggered
 * it — just its overall opacity rises and falls with proximity.
 */

import type { Camera } from './camera.js';
import { EntityType, Team, type Entity } from './entities.js';
import type { GameState } from './gamestate.js';
import { teamColor } from './teamutils.js';
import { renderLockward } from './lockwardEffect.js';

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

/** Peak opacity of the ring once a friendly ship sits right on the perimeter. */
const AURA_RING_PEAK_OPACITY = 0.6;

/**
 * Draws each friendly base's repair field as a whole Lockward-style ring. The
 * ring is invisible at rest; its overall opacity fades in as the nearest
 * friendly ship (player, fighter, or teammate) approaches the perimeter, and
 * fades back out as it leaves — the ring itself never stretches, reshapes, or
 * tracks the ship's bearing.
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

  for (const b of state.buildings) {
    if (!b.alive || b.team !== localTeam || b.type !== EntityType.CommandPost) continue;
    if (b.buildProgress < 1) continue;
    const centre = camera.worldToScreen(b.position);
    const bandPx = REVEAL_BAND * zoom;
    if (centre.x < -rr - bandPx || centre.y < -rr - bandPx ||
        centre.x > ctx.canvas.width + rr + bandPx || centre.y > ctx.canvas.height + rr + bandPx) continue;

    const nearby = state.queryEntitiesInRange(b.position, BASE_REPAIR_AURA_RADIUS + REVEAL_BAND, nearbyScratch);
    let maxProximity = 0;
    for (let i = 0; i < nearby.length; i++) {
      const e = nearby[i];
      if (!isRepairableShip(e, b.team)) continue;
      const dx = e.position.x - b.position.x, dy = e.position.y - b.position.y;
      const dist = Math.hypot(dx, dy);
      // Strongest right on the boundary, gone REVEAL_BAND either side of it.
      const proximity = 1 - Math.abs(dist - BASE_REPAIR_AURA_RADIUS) / REVEAL_BAND;
      if (proximity > maxProximity) maxProximity = proximity;
    }
    if (maxProximity <= 0.02) continue;

    renderLockward(ctx, centre.x, centre.y, time, (b.team + 1) * 53 + 11, {
      color: teamColor(b.team),
      radiusPx: rr,
      opacity: maxProximity * AURA_RING_PEAK_OPACITY,
      rings: 3,
      centerOpacityBias: 0,
    });
  }
}
