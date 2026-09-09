/**
 * Reusable combat helper functions extracted from game.ts.
 *
 * These utilities handle laser-line damage resolution, homing-weapon target
 * selection, and related queries.  They take explicit state parameters so they
 * can be called from any module without importing the monolithic Game class.
 */

import { BuildingBase } from './building.js';
import { Team, EntityType, Entity } from './entities.js';
import type { GameState } from './gamestate.js';
import { Vec2 } from './math.js';
import { SpaceFluid } from './spacefluid.js';

const targetQueryScratch: Entity[] = [];
const laserQueryScratch: Entity[] = [];
const limitedLaserQueryScratch: Entity[] = [];

function buildingImpactFromPoint(building: BuildingBase, from: Vec2): { pos: Vec2; outwardAngle: number } {
  let outward = building.position.sub(from);
  if (outward.length() <= 0.001) outward = new Vec2(1, 0);
  outward = outward.normalize();
  return {
    pos: building.position.sub(outward.scale(building.radius)),
    outwardAngle: Math.atan2(-outward.y, -outward.x),
  };
}

function emitBuildingDamageSparks(state: GameState, target: Entity, hitPoint: Vec2): void {
  if (!(target instanceof BuildingBase)) return;
  const impact = buildingImpactFromPoint(target, hitPoint);
  state.particles.emitBuildingDamageSparks(impact.pos, impact.outwardAngle);
}

// ---------------------------------------------------------------------------
// Target-selection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `entity` is a valid target for homing weapons (guided
 * missiles, homing bullets, etc.).  Ships, fighters, bombers, and buildings
 * qualify; projectiles and neutral entities do not.
 */
export function isHomingTarget(entity: Entity): boolean {
  return (
    entity.type === EntityType.PlayerShip ||
    entity.type === EntityType.Fighter ||
    entity.type === EntityType.Bomber ||
    entity instanceof BuildingBase
  );
}

/**
 * Find the closest hostile homing-target within `range` of `pos`.
 * `team` is the attacking team; entities on the same team are skipped.
 * Returns `null` when no target is found.
 */
export function findClosestEnemy(
  state: GameState,
  pos: Vec2,
  team: Team,
  range: number,
): Entity | null {
  let best: Entity | null = null;
  let bestDist = range;
  for (const e of state.queryEntitiesInRange(pos, range, targetQueryScratch)) {
    if (!e.alive || e.team === team || e.team === Team.Neutral) continue;
    if (!isHomingTarget(e)) continue;
    const d = e.position.distanceTo(pos);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Laser / beam damage resolution
// ---------------------------------------------------------------------------

/**
 * Deal `damage` to every hostile entity within `hitRadius` of the line
 * segment `start→end`.  All intercepted targets are hit (no pierce limit).
 *
 * Entities on the same team as `source`, and neutral entities, are skipped.
 * Particle and fluid effects are emitted for each hit or kill.
 */
export function damageLaserLine(
  state: GameState,
  spaceFluid: SpaceFluid | null,
  source: Entity,
  start: Vec2,
  end: Vec2,
  damage: number,
  hitRadius = 2,
  alreadyHit?: Set<number>,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) return;

  const queryRadius = hitRadius + 120;
  for (const target of state.queryEntitiesNearSegment(start, end, queryRadius, laserQueryScratch)) {
    if (!target.alive || target.team === source.team || target.team === Team.Neutral) continue;
    if (alreadyHit?.has(target.id)) continue;
    const tx = target.position.x - start.x;
    const ty = target.position.y - start.y;
    const t = Math.max(0, Math.min(1, (tx * dx + ty * dy) / lenSq));
    const px = start.x + dx * t;
    const py = start.y + dy * t;
    const dist = Math.hypot(target.position.x - px, target.position.y - py);
    if (dist <= target.radius + hitRadius) {
      alreadyHit?.add(target.id);
      target.takeDamage(damage, source);
      state.recentlyDamaged.add(target.id);
      if (!target.alive) {
        state.particles.emitExplosion(target.position, target.radius);
        spaceFluid?.addExplosion(target.position.x, target.position.y, 1.2, 214, 134, 48);
      } else {
        emitBuildingDamageSparks(state, target, new Vec2(px, py));
        state.particles.emitSpark(target.position);
      }
    }
  }
}

/**
 * Deal `damage` to up to `pierceCount` hostile entities along `start→end`,
 * sorted by closest point along the ray (nearest target hit first).
 *
 * `source` is both the damage attribution entity and the team-filter anchor
 * (entities on `source.team` and neutral entities are skipped).
 */
export function damageLaserLineLimited(
  state: GameState,
  spaceFluid: SpaceFluid | null,
  start: Vec2,
  end: Vec2,
  damage: number,
  hitRadius: number,
  pierceCount: number,
  source: Entity,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) return;

  const hits: Array<{ target: Entity; t: number }> = [];
  const queryRadius = hitRadius + 120;
  for (const target of state.queryEntitiesNearSegment(start, end, queryRadius, limitedLaserQueryScratch)) {
    if (!target.alive || target.team === source.team || target.team === Team.Neutral) continue;
    const tx = target.position.x - start.x;
    const ty = target.position.y - start.y;
    const t = Math.max(0, Math.min(1, (tx * dx + ty * dy) / lenSq));
    const px = start.x + dx * t;
    const py = start.y + dy * t;
    const dist = Math.hypot(target.position.x - px, target.position.y - py);
    if (dist <= target.radius + hitRadius) hits.push({ target, t });
  }

  hits.sort((a, b) => a.t - b.t);
  const count = Math.min(pierceCount, hits.length);
  for (let i = 0; i < count; i++) {
    const target = hits[i].target;
    target.takeDamage(damage, source);
    state.recentlyDamaged.add(target.id);
    if (!target.alive) {
      state.particles.emitExplosion(target.position, target.radius);
      spaceFluid?.addExplosion(target.position.x, target.position.y, 0.75, 42, 190, 120);
    } else {
      const hit = hits[i];
      const px = start.x + dx * hit.t;
      const py = start.y + dy * hit.t;
      emitBuildingDamageSparks(state, target, new Vec2(px, py));
      state.particles.emitSpark(target.position);
    }
  }
}
