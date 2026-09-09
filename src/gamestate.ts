/** Central game state manager for Sign99 */

import { pointToSegmentDistance, Vec2 } from './math.js';
import { Entity, Team, EntityType } from './entities.js';
import { PlayerShip } from './ship.js';
import { BuildingBase, CommandPost, Wall } from './building.js';
import { Shipyard } from './building.js';
import { SynonymousMineLayer, TurretBase } from './turret.js';
import { MassDriverBullet, ProjectileBase, RegenBullet, SynonymousNovaBomb } from './projectile.js';
import { isSynonymousDriftMine } from './synonymousMine.js';
import { FighterShip, SwarmShip } from './fighter.js';
import { ParticleSystem } from './particles.js';
import { RingEffectSystem } from './ringeffects.js';
import { Camera } from './camera.js';
import { Audio } from './audio.js';
import { WorldGrid, GRID_CELL_SIZE, cellKey, footprintOrigin, footprintCenter } from './grid.js';
import { PowerGraph } from './power.js';
import { RESOURCE_GAIN_RATE, BASELINE_RESOURCE_GAIN, CONDUIT_COST, RESEARCH_TIME, TICK_RATE, DT } from './constants.js';
import { findClosestEnemy } from './combatUtils.js';
import { WORLD_WIDTH, WORLD_HEIGHT, ENTITY_RADIUS } from './constants.js';
import { buildCostForBuildingType, type BuildDef } from './builddefs.js';
import { Colors, colorToCSS } from './colors.js';
import { teamColor } from './teamutils.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import { type FactionType, type ConfluenceTerritoryCircle, CONFLUENCE_BASE_RADIUS, CONFLUENCE_PLACEMENT_DISTANCE, CONFLUENCE_PLACEMENT_TOLERANCE, CONFLUENCE_PARENT_EXPAND_DURATION, CONFLUENCE_NEW_CIRCLE_GROW_DURATION, CONFLUENCE_INCLUDE_MARGIN, isConfluenceFaction, isSynonymousFaction } from './confluence.js';
import { SynonymousSwarmSystem, SYNONYMOUS_BASE_PRODUCTION, SYNONYMOUS_BUILD_COST, SYNONYMOUS_CURRENCY_SYMBOL, SYNONYMOUS_FACTORY_PRODUCTION } from './synonymous.js';
import {
  adjustNavigationTargetOutOfBlockers,
  beginShipPathFrame,
  isNavigationTargetBlocked,
  noteShipPathCacheReuse,
  noteShipPathSkipped,
  resolveShipNavigationTarget,
  scoreShipRoute,
} from './shippath.js';
import { buildingBlocksShips, buildingFootprintOrigin, buildingShipCollisionRect } from './buildingCollision.js';
import { SpatialIndex, type SpatialIndexStats } from './spatialIndex.js';

const FACTORY_COST_STEP = 25;
const MAX_FACTORIES = 10;
const MAX_RESEARCH_LABS = 1;
const MAX_TURRETS_PER_KIND = 20;

export interface DestroyedBuildingRecord {
  type: EntityType;
  team: Team;
  position: Vec2;
  maxHealth: number;
  erased?: boolean;
}

export interface DestroyedConduitRecord {
  cx: number;
  cy: number;
  team: Team;
  erased?: boolean;
}

export interface ResearchProgress {
  item: string | null;
  progress: number;
  timeNeeded: number;
}

export interface ExplosionGlow {
  center: Vec2;
  radius: number;
  lifeSeconds: number;
  totalSeconds: number;
  intensity: number;
}

export interface AIDebugSnapshot {
  goal: string;
  healthFraction: number;
  retreatTarget: Vec2 | null;
  cachedNavigationTarget: Vec2 | null;
  retreatTargetAdjusted: boolean;
}

export type GameMode = 'menu' | 'tutorial' | 'practice' | 'vs_ai' | 'playing' | 'lan_host' | 'lan_client' | 'online_host' | 'online_client';

export interface GamePerfStats {
  gameStateUpdateMs: number;
  practiceUpdateMs: number;
  practicePlannerMs: number;
  practicePlannerMaxMs: number;
  turretAcquireMs: number;
  projectileCollisionMs: number;
  fighterCombatMs: number;
  fighterSeparationMs: number;
  activeEnemyBases: number;
  spatial: SpatialIndexStats;
}

function emptySpatialStats(): SpatialIndexStats {
  return { queryCount: 0, rawCandidateCount: 0, returnedCount: 0, insertedCount: 0, cellCount: 0 };
}

const DISTANT_STAGED_FIGHTER_SLEEP_RANGE_SQ = 3600 * 3600;

function projectileSegmentEnd(projectile: ProjectileBase): Vec2 {
  const maybeSegment = projectile as ProjectileBase & { targetPos?: Vec2 };
  return maybeSegment.targetPos ?? projectile.position;
}

function projectileSweepStart(projectile: ProjectileBase): Vec2 {
  if (projectileSegmentEnd(projectile) !== projectile.position) return projectile.position;
  return new Vec2(projectile.position.x - projectile.velocity.x * DT, projectile.position.y - projectile.velocity.y * DT);
}

function segmentSegmentDistance(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  const adx = a1.x - a0.x;
  const ady = a1.y - a0.y;
  const bdx = b1.x - b0.x;
  const bdy = b1.y - b0.y;
  const cross = adx * bdy - ady * bdx;
  if (Math.abs(cross) > 0.0001) {
    const dx = b0.x - a0.x;
    const dy = b0.y - a0.y;
    const t = (dx * bdy - dy * bdx) / cross;
    const u = (dx * ady - dy * adx) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointToSegmentDistance(a0, b0, b1),
    pointToSegmentDistance(a1, b0, b1),
    pointToSegmentDistance(b0, a0, a1),
    pointToSegmentDistance(b1, a0, a1),
  );
}

function compactAlive<T extends Entity>(items: T[]): void {
  let write = 0;
  for (let read = 0; read < items.length; read++) {
    const item = items[read];
    if (!item.alive) continue;
    items[write++] = item;
  }
  items.length = write;
}

function compactKeep<T>(items: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < items.length; read++) {
    const item = items[read];
    if (!keep(item)) continue;
    items[write++] = item;
  }
  items.length = write;
}

export class GameState {
  /**
   * Map of slot index → PlayerShip for all active player ships (slots 0–7).
   * Slot 0 is always the local/host player; additional slots are remote
   * human players or AI ships in multiplayer.
   */
  playerShips: Map<number, PlayerShip> = new Map();

  /**
   * Convenience accessor for the slot-0 ship (local player / host).
   * All single-player code continues to use this; new multi-player code
   * should use `playerShips` directly.
   */
  get player(): PlayerShip {
    return this.playerShips.get(0)!;
  }

  buildings: BuildingBase[] = [];
  destroyedBuildings: DestroyedBuildingRecord[] = [];
  destroyedConduits: DestroyedConduitRecord[] = [];
  projectiles: ProjectileBase[] = [];
  fighters: FighterShip[] = [];
  particles: ParticleSystem;
  explosionGlows: ExplosionGlow[] = [];
  /** Ring/blackout pulse effects (PR9). */
  ringEffects: RingEffectSystem = new RingEffectSystem();
  /**
   * Accumulated screen-shake magnitude from explosions this frame.
   * Consumed and reset by game.ts each tick via camera.addShake().
   * Quality-gated: game.ts only passes it through if cameraShakeEnabled.
   */
  pendingShakeMagnitude: number = 0;
  /**
   * Explosion events pending delivery to the CrystalNebula system.
   * Each entry records the world position and effective blast radius.
   * Drained and cleared by game.ts each tick after physics injection.
   */
  pendingCrystalExplosions: Array<{ x: number; y: number; radius: number }> = [];
  /** PR3: universal world grid storing painted conduits. */
  grid: WorldGrid = new WorldGrid();
  /** PR5: graph-based power network (lazy, dirty-flag cached). */
  power: PowerGraph = new PowerGraph();
  synonymous: SynonymousSwarmSystem = new SynonymousSwarmSystem();
  private synonymousBaseAccumulator: Map<Team, number> = new Map();
  private synonymousFactoryAccumulator: Map<number, number> = new Map();
  private fighterNavCache: Map<number, {
    targetX: number;
    targetY: number;
    fromX: number;
    fromY: number;
    nextUpdateAt: number;
    navTarget: Vec2;
    lastDistanceToTarget: number;
    stuckSince: number;
  }> = new Map();
  private sharedFighterPathCache: Map<string, {
    navTarget: Vec2;
    targetX: number;
    targetY: number;
    expiresAt: number;
  }> = new Map();
  private spatialIndex: SpatialIndex = new SpatialIndex(GRID_CELL_SIZE * 3);
  private spatialQueryScratch: Entity[] = [];
  private pathBudgetRemaining = 0;
  private pathBudgetFrameToken = -1;
  private buildingCollisionVersionCounter = 0;
  survivalKillRewardsEnabled = false;
  survivalEnemyRewardBank = 0;
  perfStats: GamePerfStats = {
    gameStateUpdateMs: 0,
    practiceUpdateMs: 0,
    practicePlannerMs: 0,
    practicePlannerMaxMs: 0,
    turretAcquireMs: 0,
    projectileCollisionMs: 0,
    fighterCombatMs: 0,
    fighterSeparationMs: 0,
    activeEnemyBases: 0,
    spatial: emptySpatialStats(),
  };

  /**
   * Countdown until the next pending conduit is promoted to the active grid.
   * Conduits queued by the player are built one at a time from the network
   * frontier outward, with a 0.5 s delay between each.
   */
  private conduitBuildTimer: number = 0.5;
  private advancedRegenConduitRepairTimer: number = 0.5;

  resources: number = 500;
  researchProgress: ResearchProgress = { item: null, progress: 0, timeNeeded: 0 };
  researchQueue: string[] = [];
  completedResearchNotifications: string[] = [];
  researchedItems: Set<string> = new Set();

  /**
   * Vs. AI bot-player main ship, when the active mode is `vs_ai`.
   * Treated like a second player: physics tick, render, and projectile
   * collisions all flow through the same paths as `player`.
   *
   * In LAN multiplayer this is superseded by `playerShips`; for the
   * legacy Vs. AI mode it remains active so existing code is unchanged.
   */
  get aiPlayerShip(): PlayerShip | null {
    return this.playerShips.get(1) ?? null;
  }
  set aiPlayerShip(ship: PlayerShip | null) {
    if (ship) {
      this.playerShips.set(1, ship);
    } else {
      this.playerShips.delete(1);
    }
  }

  /**
   * The most recently selected building type from the Q build menu.
   * Displayed in the HUD near the energy bar.
   */
  selectedBuildType: string | null = null;
  aiDebug: AIDebugSnapshot | null = null;

  gameMode: GameMode = 'menu';

  factionByTeam: Map<Team, FactionType> = new Map();
  territoryCirclesByTeam: Map<Team, ConfluenceTerritoryCircle[]> = new Map();
  private nextTerritoryCircleId = 1;
  gameTime: number = 0;

  /** Entities that took damage this frame, used by radar for flash indicators. */
  recentlyDamaged: Set<number> = new Set();

  /**
   * PR7: timestamps of recent enemy construction events (in seconds since
   * gameTime). Used by the HUD to show warning markers near the player CP.
   * Entries older than 8 seconds are dropped on read.
   */
  recentEnemyConstructions: Array<{ pos: Vec2; time: number }> = [];

  constructor(playerStart: Vec2 = new Vec2(0, 0)) {
    this.playerShips.set(0, new PlayerShip(playerStart, Team.Player));
    this.particles = new ParticleSystem();
    this.factionByTeam.set(Team.Player, 'terran');
    this.factionByTeam.set(Team.Enemy, 'terran');
  }

  // -----------------------------------------------------------------------
  // Entity management
  // -----------------------------------------------------------------------

  addEntity(entity: Entity): void {
    if (entity instanceof ProjectileBase) {
      this.projectiles.push(entity);
    } else if (entity instanceof FighterShip) {
      this.fighters.push(entity);
    } else if (entity instanceof BuildingBase) {
      if (isSynonymousFaction(this.factionByTeam, entity.team) && !entity.synonymousVisualKind) {
        if (entity.type === EntityType.CommandPost) entity.synonymousVisualKind = 'base';
        else if (entity.type === EntityType.Factory) entity.synonymousVisualKind = 'factory';
        else if (entity.type === EntityType.ResearchLab) entity.synonymousVisualKind = 'researchlab';
        else if (entity.type === EntityType.FighterYard || entity.type === EntityType.BomberYard || entity.type === EntityType.SwarmYard) entity.synonymousVisualKind = 'shipyard';
        else if (entity.type === EntityType.MissileTurret) entity.synonymousVisualKind = 'laserturret';
        else if (entity.type === EntityType.GatlingTurret) entity.synonymousVisualKind = 'laserturret';
        else if (entity.type === EntityType.ExciterTurret) entity.synonymousVisualKind = 'laserturret';
        else if (entity.type === EntityType.MassDriverTurret) entity.synonymousVisualKind = 'laserturret';
        else if (entity.type === EntityType.RegenTurret) entity.synonymousVisualKind = 'laserturret';
        else if (entity.type === EntityType.TimeBomb) entity.synonymousVisualKind = 'minelayer';
      }
      this.buildings.push(entity);
      this.markBuildingCollisionDirty();
      if (!isSynonymousFaction(this.factionByTeam, entity.team)) {
        this.addAutomaticBuildingConduits(entity);
      }
      if (entity instanceof Wall && entity.team === Team.Player && this.researchedItems.has('poweredWalls')) {
        entity.enablePoweredWall();
      }
      this.power.markDirty();
    }
  }

  removeEntity(entity: Entity): void {
    if (entity instanceof BuildingBase && entity.alive) this.markBuildingCollisionDirty();
    entity.alive = false;
  }

  get buildingCollisionVersion(): number {
    return this.buildingCollisionVersionCounter;
  }

  private markBuildingCollisionDirty(): void {
    this.buildingCollisionVersionCounter++;
  }

  /** Return all living entities across every list plus the player. */
  allEntities(): Entity[] {
    const result: Entity[] = [];
    for (const ship of this.playerShips.values()) {
      if (ship.alive) result.push(ship);
    }
    for (const b of this.buildings) if (b.alive) result.push(b);
    for (const f of this.fighters) if (f.alive) result.push(f);
    for (const p of this.projectiles) if (p.alive) result.push(p);
    return result;
  }

  getEntityById(id: number): Entity | null {
    for (const ship of this.playerShips.values()) {
      if (ship.alive && ship.id === id) return ship;
    }
    for (const b of this.buildings) {
      if (b.alive && b.id === id) return b;
    }
    for (const f of this.fighters) {
      if (f.alive && f.id === id) return f;
    }
    for (const p of this.projectiles) {
      if (p.alive && p.id === id) return p;
    }
    return null;
  }

  /** Find all living entities within a given range of a world position. */
  getEntitiesInRange(pos: Vec2, range: number): Entity[] {
    const indexed = this.spatialIndex.queryCircle(pos, range);
    if (indexed.length > 0 || this.perfStats.spatial.insertedCount > 0) return indexed.slice();
    const result: Entity[] = [];
    const rSq = range * range;
    this.queryAllEntitiesInRange(pos, rSq, result);
    return result;
  }

  queryEntitiesInRange(pos: Vec2, range: number, out: Entity[]): Entity[] {
    if (this.perfStats.spatial.insertedCount > 0) {
      return this.spatialIndex.queryCircle(pos, range, out);
    }
    out.length = 0;
    const rSq = range * range;
    this.queryAllEntitiesInRange(pos, rSq, out);
    return out;
  }

  queryEntitiesNearSegment(start: Vec2, end: Vec2, radius: number, out: Entity[]): Entity[] {
    if (this.perfStats.spatial.insertedCount > 0) {
      return this.spatialIndex.querySegment(start, end, radius, out);
    }
    out.length = 0;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const mid = new Vec2(start.x + dx * 0.5, start.y + dy * 0.5);
    this.queryAllEntitiesInRange(mid, Math.pow(Math.sqrt(dx * dx + dy * dy) * 0.5 + radius, 2), out);
    return out;
  }

  private queryAllEntitiesInRange(pos: Vec2, rangeSq: number, out: Entity[]): void {
    for (const ship of this.playerShips.values()) {
      if (!ship.alive) continue;
      const dx = ship.position.x - pos.x;
      const dy = ship.position.y - pos.y;
      if (dx * dx + dy * dy <= rangeSq) out.push(ship);
    }
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const dx = b.position.x - pos.x;
      const dy = b.position.y - pos.y;
      if (dx * dx + dy * dy <= rangeSq) out.push(b);
    }
    for (const f of this.fighters) {
      if (!f.alive || f.docked || this.shouldSleepDistantStagedFighter(f)) continue;
      const dx = f.position.x - pos.x;
      const dy = f.position.y - pos.y;
      if (dx * dx + dy * dy <= rangeSq) out.push(f);
    }
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      const dx = p.position.x - pos.x;
      const dy = p.position.y - pos.y;
      if (dx * dx + dy * dy <= rangeSq) out.push(p);
    }
  }

  recordGameStateUpdateMs(ms: number): void {
    this.perfStats.gameStateUpdateMs = ms;
  }

  addTurretAcquireTime(ms: number): void {
    this.perfStats.turretAcquireMs += ms;
  }

  addFighterCombatTime(ms: number): void {
    this.perfStats.fighterCombatMs += ms;
  }

  acquireTurretTarget(turret: TurretBase): void {
    const startedAt = performance.now();
    const nearby = this.queryEntitiesInRange(turret.position, turret.range, this.spatialQueryScratch);
    turret.acquireTarget(nearby);
    this.addTurretAcquireTime(performance.now() - startedAt);
  }

  recordPracticePerf(updateMs: number, plannerMs: number, plannerMaxMs: number, activeBases: number): void {
    this.perfStats.practiceUpdateMs = updateMs;
    this.perfStats.practicePlannerMs = plannerMs;
    this.perfStats.practicePlannerMaxMs = plannerMaxMs;
    this.perfStats.activeEnemyBases = activeBases;
  }

  /** All living entities hostile to the given team. */
  getEnemiesOf(team: Team): Entity[] {
    return this.allEntities().filter(
      (e) => e.team !== Team.Neutral && e.team !== team,
    );
  }

  /** All living entities friendly to the given team. */
  getFriendliesOf(team: Team): Entity[] {
    return this.allEntities().filter((e) => e.team === team);
  }

  // -----------------------------------------------------------------------
  // Per-frame update
  // -----------------------------------------------------------------------

  update(dt: number): void {
    if (this.gameMode === 'menu') return;

    this.resetPerfStatsForTick();
    this.gameTime += dt;
    this.beginNavigationFrame();
    for (const circles of this.territoryCirclesByTeam.values()) {
      for (const c of circles) {
        if (c.radius === c.targetRadius) continue;
        if (c.growthDuration <= 0) { c.radius = c.targetRadius; continue; }
        const t = Math.min(1, (this.gameTime - c.growthStartTime) / c.growthDuration);
        const eased = 1 - (1 - t) * (1 - t);
        c.radius = c.radius + (c.targetRadius - c.radius) * eased;
        if (t >= 1) c.radius = c.targetRadius;
      }
    }
    this.recentlyDamaged.clear();

    // Update all player ships (slot 0 = local player, others = remote/AI)
    for (const ship of this.playerShips.values()) {
      if (ship.alive) ship.update(dt);
    }
    this.synonymous.update(dt, this.gameTime);
    this.updatePlayerShieldAura();

    // Update buildings and power status
    this.updateBuildingPower();
    for (const b of this.buildings) {
      b.update(dt);
      if (b.completionEffectPending) {
        this.markBuildingCollisionDirty();
      }
      if (
        b.completionEffectPending &&
        (b.type === EntityType.CommandPost || b.type === EntityType.PowerGenerator)
      ) {
        this.power.markDirty();
      }
    }
    for (const b of this.buildings) {
      if (b instanceof SynonymousMineLayer) b.tickMineLayer(this);
    }
    this.synonymous.updateBuildingIntegrity(this.buildings);
    this.rebuildSpatialIndex();

    const separationStart = performance.now();
    this.applyFighterSeparation(dt);
    this.perfStats.fighterSeparationMs = performance.now() - separationStart;

    let enemyCommandPosts = 0;
    for (const b of this.buildings) {
      if (b.alive && b.team === Team.Enemy && b.type === EntityType.CommandPost) enemyCommandPosts++;
    }
    const survivalScaleEnemyBases = enemyCommandPosts > 1;

    // Update fighters. Docked fighters are capacity bookkeeping for their
    // shipyards; they do not need hazard avoidance or route refreshes.
    for (const f of this.fighters) {
      if (f.docked) {
        f.setNavigationTarget(null);
        this.fighterNavCache.delete(f.id);
        f.update(dt);
        continue;
      }
      if (survivalScaleEnemyBases && this.shouldSleepDistantStagedFighter(f)) {
        f.setNavigationTarget(null);
        this.fighterNavCache.delete(f.id);
        continue;
      }
      this.applyAdvancedFighterHazardAvoidance(f, dt);
      this.updateFighterNavigation(f);
      f.update(dt);
    }

    // Update projectiles
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.update(dt);
      if (p instanceof MassDriverBullet) {
        const pulseRadius = p.consumeDamagePulse();
        if (pulseRadius !== null) {
          this.applyMassDriverPulse(p, pulseRadius);
        }
      }
      if (p instanceof SynonymousNovaBomb && p.consumePulse()) {
        this.applyNovaBombPulse(p);
      }
      if (!p.alive && this.projectileBlastRadius(p) > 0) {
        this.detonateProjectile(p);
      }
    }
    this.rebuildSpatialIndex();

    // Collision detection
    // First let enemy bullets intercept swarm missiles (GOAL 3C)
    const collisionStart = performance.now();
    this.resolveMineProjectileDamage();
    this.resolveProjectileInterceptions();
    this.resolveCollisions();
    this.perfStats.projectileCollisionMs = performance.now() - collisionStart;
    this.synonymous.updateBuildingIntegrity(this.buildings);

    // Resources from factories
    this.accumulateResources(dt);

    // PR3: conduit interaction. Conduits are flight lanes now: ships pass
    // over them, while opposing shots can still chip powered conduit cells.
    this.applyConduitInteraction(dt);
    this.applyStructureInteraction();

    // Tick pending conduit fronts. Every eligible frontier cell builds together.
    this.tickPendingConduits(dt);
    this.tickAdvancedRegenConduitRepair(dt);

    // Research progress
    this.tickResearch(dt);

    // Particles
    this.particles.update(dt);
    this.updateExplosionGlows(dt);
    this.ringEffects.update(dt);
    this.ringEffects.prune();

    this.completeBuildingDeletions();

    // Cleanup dead entities
    this.cleanupDead();
    this.rebuildSpatialIndex();
  }

  private resetPerfStatsForTick(): void {
    const previousGameStateMs = this.perfStats.gameStateUpdateMs;
    this.spatialIndex.clear(true);
    this.perfStats = {
      gameStateUpdateMs: previousGameStateMs,
      practiceUpdateMs: 0,
      practicePlannerMs: 0,
      practicePlannerMaxMs: 0,
      turretAcquireMs: 0,
      projectileCollisionMs: 0,
      fighterCombatMs: 0,
      fighterSeparationMs: 0,
      activeEnemyBases: 0,
      spatial: emptySpatialStats(),
    };
  }

  private rebuildSpatialIndex(): void {
    this.spatialIndex.clear(false);
    for (const ship of this.playerShips.values()) this.spatialIndex.insert(ship);
    for (const b of this.buildings) this.spatialIndex.insert(b);
    for (const f of this.fighters) {
      if (!f.docked && !this.shouldSleepDistantStagedFighter(f)) this.spatialIndex.insert(f);
    }
    for (const p of this.projectiles) this.spatialIndex.insert(p);
    this.perfStats.spatial = this.spatialIndex.stats();
  }

  // -----------------------------------------------------------------------
  // Collision detection
  // -----------------------------------------------------------------------

  private resolveCollisions(): void {
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;

      const isRegen = proj instanceof RegenBullet;
      const end = projectileSegmentEnd(proj);
      const queryRadius = proj.radius + ENTITY_RADIUS.building + Math.hypot(proj.velocity.x, proj.velocity.y) * DT + GRID_CELL_SIZE;
      const nearby = end === proj.position
        ? this.queryEntitiesInRange(proj.position, queryRadius, this.spatialQueryScratch)
        : this.queryEntitiesNearSegment(proj.position, end, queryRadius, this.spatialQueryScratch);

      // Check against buildings
      for (const e of nearby) {
        if (!(e instanceof BuildingBase)) continue;
        const b = e;
        if (this.checkHit(proj, b, isRegen)) break;
      }
      if (!proj.alive) continue;

      // Check against fighters
      for (const e of nearby) {
        if (!(e instanceof FighterShip)) continue;
        const f = e;
        if (!f.alive || f.docked) continue;
        if (this.checkHit(proj, f, isRegen)) break;
      }
      if (!proj.alive) continue;

      // Check against all player ships (slot 0 = local, others = remote/AI)
      for (const ship of this.playerShips.values()) {
        if (!ship.alive) continue;
        if (this.checkHit(proj, ship, isRegen)) break;
      }
    }
  }

  private resolveMineProjectileDamage(): void {
    for (const shot of this.projectiles) {
      if (!shot.alive || isSynonymousDriftMine(shot)) continue;
      const shotEnd = projectileSegmentEnd(shot);
      const queryRadius = shot.radius + ENTITY_RADIUS.missile + 12;
      const nearby = shotEnd === shot.position
        ? this.queryEntitiesInRange(shot.position, queryRadius, this.spatialQueryScratch)
        : this.queryEntitiesNearSegment(shot.position, shotEnd, queryRadius, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof ProjectileBase) || !isSynonymousDriftMine(candidate)) continue;
        const mine = candidate;
        if (!mine.alive || shot === mine) continue;
        const dist = shotEnd === shot.position
          ? mine.position.distanceTo(shot.position)
          : pointToSegmentDistance(mine.position, shot.position, shotEnd);
        if (dist <= mine.radius + shot.radius) {
          mine.takeDamage(Math.max(1, Math.abs(shot.damage)), shot);
          shot.destroy();
          this.recentlyDamaged.add(mine.id);
          this.particles.emitSpark(mine.position);
          if (!mine.alive) this.detonateProjectile(mine);
          break;
        }
      }
    }
  }

  /** Returns true if the projectile hit and was consumed. */
  private checkHit(proj: ProjectileBase, target: Entity, isRegen: boolean): boolean {
    if (proj instanceof SynonymousNovaBomb) return false;
    if (proj instanceof MassDriverBullet && proj.isBursting) return false;
    // Regen bullets heal same-team, damage other-team
    if (isRegen && proj.team === target.team) {
      if (target.health >= target.maxHealth) return false;
      const dist = pointToSegmentDistance(target.position, projectileSweepStart(proj), proj.position);
      if (dist < proj.radius + target.radius) {
        target.takeDamage(proj.damage); // negative damage = healing
        this.particles.emitHealing(target.position);
        proj.destroy();
        return true;
      }
      return false;
    }

    // Friendly shots pass over friendly structures, including walls.
    if (proj.team === target.team) return false;
    if (target.type === EntityType.Wall && proj.damage < 0) return false;

    if (proj instanceof MassDriverBullet) {
      const dist = pointToSegmentDistance(target.position, projectileSweepStart(proj), proj.position);
      if (dist < proj.radius + target.radius) {
        proj.triggerBurst();
        return true;
      }
      return false;
    }

    if (isSynonymousFaction(this.factionByTeam, target.team)) {
      const handled = this.synonymous.damageDroneAt(target.team, proj.position, proj.damage, {
        buildingId: target instanceof BuildingBase ? target.id : undefined,
        fallbackToBuilding: target instanceof BuildingBase,
        time: this.gameTime,
      });
      if (handled) {
        this.recentlyDamaged.add(target.id);
        proj.destroy();
        return true;
      }
    }

    const dist = pointToSegmentDistance(target.position, projectileSweepStart(proj), proj.position);
    const combinedRadius = proj.radius + target.radius;
    if (dist < combinedRadius) {
      if (this.projectileBlastRadius(proj) > 0) {
        this.applyProjectileDamage(proj, target);
        proj.destroy();
        return true;
      }
      target.takeDamage(proj.damage, proj);
      this.recentlyDamaged.add(target.id);
      if (!target.alive) {
        this.particles.emitExplosion(target.position, target.radius);
        this.pendingCrystalExplosions.push({ x: target.position.x, y: target.position.y, radius: Math.max(60, target.radius * 4) });
        // Larger targets add screen shake
        this.pendingShakeMagnitude = Math.min(Camera.MAX_SHAKE, this.pendingShakeMagnitude + Math.min(4, target.radius * 0.12));
        // Explosion sound — size depends on entity type
        if (
          target.type === EntityType.CommandPost ||
          target.type === EntityType.PowerGenerator ||
          target.type === EntityType.FighterYard ||
          target.type === EntityType.BomberYard ||
          target.type === EntityType.SwarmYard ||
          target.type === EntityType.ResearchLab ||
          target.type === EntityType.Factory
        ) {
          Audio.playSoundAt('explode2', target.position);
        } else if (
          target.type === EntityType.GatlingTurret ||
          target.type === EntityType.MissileTurret ||
          target.type === EntityType.Wall ||
          target.type === EntityType.TimeBomb ||
          target.type === EntityType.ExciterTurret ||
          target.type === EntityType.MassDriverTurret ||
          target.type === EntityType.RegenTurret ||
          target.type === EntityType.PlayerShip
        ) {
          Audio.playSoundAt('explode1', target.position);
        } else {
          Audio.playSoundAt('explode0', target.position);
        }
      } else {
        // Non-fatal hit — play hit sound, emit directional impact sparks
        const hitAngle = Math.atan2(proj.velocity.y, proj.velocity.x);
        this.emitBuildingDamageSparks(target, proj.position);
        this.particles.emitImpact(target.position, hitAngle);
        Audio.playSoundAt('bhit0', target.position);
      }
      proj.destroy();
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Building power (PR5: graph-based, see src/power.ts)
  // -----------------------------------------------------------------------

  private updateBuildingPower(): void {
    this.power.recompute(this);
  }

  // -----------------------------------------------------------------------
  // Resources
  // -----------------------------------------------------------------------

  private accumulateResources(dt: number): void {
    this.accumulateSynonymousDrones(dt);
    if (isSynonymousFaction(this.factionByTeam, Team.Player)) return;

    // Baseline resource gain — player automatically gains resources over time
    if (this.player.alive) {
      this.resources += BASELINE_RESOURCE_GAIN * dt;
    }

    // Bonus from factories
    for (const b of this.buildings) {
      if (
        b.alive &&
        b.type === EntityType.Factory &&
        b.team === Team.Player &&
        b.powered &&
        b.buildProgress >= 1
      ) {
        this.resources += RESOURCE_GAIN_RATE * dt;
      }
    }
  }

  /** Current player income rate (resources per second). */
  getPlayerIncomePerSecond(): number {
    if (isSynonymousFaction(this.factionByTeam, Team.Player)) {
      let income = SYNONYMOUS_BASE_PRODUCTION;
      for (const b of this.buildings) {
        if (
          b.alive &&
          b.type === EntityType.Factory &&
          b.team === Team.Player &&
          b.buildProgress >= 1
        ) {
          income += SYNONYMOUS_FACTORY_PRODUCTION;
        }
      }
      return income;
    }
    let income = this.player.alive ? BASELINE_RESOURCE_GAIN : 0;
    for (const b of this.buildings) {
      if (
        b.alive &&
        b.type === EntityType.Factory &&
        b.team === Team.Player &&
        b.powered &&
        b.buildProgress >= 1
      ) {
        income += RESOURCE_GAIN_RATE;
      }
    }
    return income;
  }

  private accumulateSynonymousDrones(dt: number): void {
    for (const [team, faction] of this.factionByTeam) {
      if (faction !== 'synonymous') continue;
      const cp = this.getCommandPostForTeam(team);
      if (!cp?.alive) continue;
      const next = (this.synonymousBaseAccumulator.get(team) ?? 0) + SYNONYMOUS_BASE_PRODUCTION * dt;
      const whole = Math.floor(next);
      this.synonymousBaseAccumulator.set(team, next - whole);
      if (whole > 0) this.synonymous.produce(team, whole, cp.position, this.gameTime);
    }

    for (const b of this.buildings) {
      if (!b.alive || b.type !== EntityType.Factory || !isSynonymousFaction(this.factionByTeam, b.team)) continue;
      if (b.buildProgress < 1) continue;
      const next = (this.synonymousFactoryAccumulator.get(b.id) ?? 0) + SYNONYMOUS_FACTORY_PRODUCTION * dt;
      const whole = Math.floor(next);
      this.synonymousFactoryAccumulator.set(b.id, next - whole);
      if (whole > 0) this.synonymous.produce(b.team, whole, b.position, this.gameTime);
    }
  }

  // -----------------------------------------------------------------------
  // Conduit interaction (PR3) — powered conduits block hostile shots only
  // -----------------------------------------------------------------------

  /**
   * Conduits do not block movement for any team. Powered conduits still act as
   * vulnerable infrastructure: opposing shots that enter a powered conduit cell
   * damage the conduit and are consumed.
   */
  private applyConduitInteraction(_dt: number): void {
    if (this.grid.conduitCount() === 0) return;

    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      if (proj instanceof MassDriverBullet && proj.isBursting) continue;
      const cx = Math.floor(proj.position.x / GRID_CELL_SIZE);
      const cy = Math.floor(proj.position.y / GRID_CELL_SIZE);
      const conduitTeam = this.grid.conduitTeam(cx, cy);
      // Only opposing-team powered conduits stop shots.
      if (conduitTeam === null || conduitTeam === proj.team) continue;
      if (!this.power.isCellEnergized(conduitTeam, cx, cy)) continue;
      if (this.grid.damageConduit(cx, cy, 1)) {
        this.recordDestroyedConduit(cx, cy, conduitTeam);
      }
      this.power.markDirty();
      if (proj instanceof MassDriverBullet) {
        proj.triggerBurst();
        continue;
      }
      proj.destroy();
      if (this.projectileBlastRadius(proj) > 0) {
        this.detonateProjectile(proj);
      } else {
        this.particles.emitSpark(proj.position);
      }
    }
  }

  private applyStructureInteraction(): void {
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      const nearby = this.queryEntitiesInRange(proj.position, proj.radius + ENTITY_RADIUS.building + GRID_CELL_SIZE, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof BuildingBase)) continue;
        const wall = candidate;
        if (wall.buildProgress < 1 || wall.type !== EntityType.Wall) continue;
        if (proj.team === wall.team) continue;
        if (this.projectileIntersectsBuildingFootprint(proj, wall)) {
          this.applyProjectileDamage(proj, wall);
          proj.destroy();
          break;
        }
      }
    }
    const shipsToCheck: Entity[] = [];
    for (const ship of this.playerShips.values()) {
      if (ship.alive) shipsToCheck.push(ship);
    }
    for (const f of this.fighters) {
      if (f.alive && !f.docked) shipsToCheck.push(f);
    }

    for (const ship of shipsToCheck) {
      const nearby = this.queryEntitiesInRange(ship.position, ship.radius + ENTITY_RADIUS.building + GRID_CELL_SIZE * 2, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof BuildingBase)) continue;
        const building = candidate;
        if (!building.alive || building.buildProgress < 1) continue;
        if (!buildingBlocksShips(building)) continue;
        this.pushEntityOutOfBuildingFootprint(ship, building);
      }
    }
  }

  private pushEntityOutOfBuildingFootprint(entity: Entity, building: BuildingBase): void {
    const { left, right, top, bottom } = buildingShipCollisionRect(building);
    const closestX = Math.max(left, Math.min(right, entity.position.x));
    const closestY = Math.max(top, Math.min(bottom, entity.position.y));
    const dx = entity.position.x - closestX;
    const dy = entity.position.y - closestY;
    if (dx * dx + dy * dy > entity.radius * entity.radius) return;

    const overlapL = entity.position.x - left;
    const overlapR = right - entity.position.x;
    const overlapT = entity.position.y - top;
    const overlapB = bottom - entity.position.y;
    const minH = Math.min(overlapL, overlapR);
    const minV = Math.min(overlapT, overlapB);
    if (minH <= minV) {
      if (overlapL < overlapR) {
        entity.position.x = left - entity.radius;
        if (entity.velocity.x > 0) entity.velocity.x *= -0.35;
      } else {
        entity.position.x = right + entity.radius;
        if (entity.velocity.x < 0) entity.velocity.x *= -0.35;
      }
    } else if (overlapT < overlapB) {
      entity.position.y = top - entity.radius;
      if (entity.velocity.y > 0) entity.velocity.y *= -0.35;
    } else {
      entity.position.y = bottom + entity.radius;
      if (entity.velocity.y < 0) entity.velocity.y *= -0.35;
    }
  }

  private applyFighterSeparation(dt: number): void {
    for (let i = 0; i < this.fighters.length; i++) {
      const a = this.fighters[i];
      if (!a.alive || a.docked) continue;
      if (this.shouldSleepDistantStagedFighter(a)) continue;
      const nearby = this.queryEntitiesInRange(a.position, 72, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof FighterShip)) continue;
        const b = candidate;
        if (b.id <= a.id || !b.alive || b.docked || a.team !== b.team) continue;
        a.applySeparationFrom(b, dt);
        b.applySeparationFrom(a, dt);
      }
    }
  }

  private updatePlayerShieldAura(): void {
    const radius = 90;
    const protectedIds = new Set<number>();
    for (const ship of this.playerShips.values()) {
      if (!ship.shieldUnlocked || !ship.alive || ship.shield <= 0) continue;
      const nearby = this.queryEntitiesInRange(ship.position, radius, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof FighterShip)) continue;
        if (!candidate.alive || candidate.docked || candidate.team !== ship.team) continue;
        protectedIds.add(candidate.id);
      }
    }
    for (const f of this.fighters) {
      if (!f.alive || f.docked) continue;
      if (protectedIds.has(f.id)) f.enableShield();
      else if (f.shieldUnlocked) f.disableShield();
    }
  }

  private projectileIntersectsBuildingFootprint(projectile: ProjectileBase, building: BuildingBase): boolean {
    const { left, right, top, bottom } = buildingShipCollisionRect(building);
    const closestX = Math.max(left, Math.min(right, projectile.position.x));
    const closestY = Math.max(top, Math.min(bottom, projectile.position.y));
    const dx = projectile.position.x - closestX;
    const dy = projectile.position.y - closestY;
    return dx * dx + dy * dy <= projectile.radius * projectile.radius;
  }

  // -----------------------------------------------------------------------
  // Pending conduit build queue (0.5 s per cell, BFS frontier outward)
  // -----------------------------------------------------------------------

  /**
   * Each tick, count down toward the next conduit build event. When the
   * timer fires, promote every pending conduit orthogonal to the powered
   * network or a finished powered building; placement order does not matter.
   */
  private tickPendingConduits(dt: number): void {
    if (this.grid.pendingConduitCount() === 0) return;
    this.conduitBuildTimer -= dt;
    if (this.conduitBuildTimer > 0) return;
    this.conduitBuildTimer = 0.5;

    const ready: Array<{ cx: number; cy: number; team: Team }> = [];
    for (const { cx, cy, team } of this.grid.eachPendingConduit()) {
      if (this.isAtConduitFrontier(cx, cy, team)) {
        ready.push({ cx, cy, team });
      }
    }
    if (ready.length === 0) return;
    for (const { cx, cy } of ready) this.grid.promotePendingConduit(cx, cy);
    this.power.markDirty();
    if (ready.length > 0) {
      const first = ready[0];
      this.ringEffects.spawn('build_complete_wave', new Vec2((first.cx + 0.5) * GRID_CELL_SIZE, (first.cy + 0.5) * GRID_CELL_SIZE), 8, 70, 0.55, 0.55);
    }
    let nearestDist = Infinity;
    let nearestPos = this.player.position;
    for (const { cx, cy } of ready) {
      const x = (cx + 0.5) * GRID_CELL_SIZE;
      const y = (cy + 0.5) * GRID_CELL_SIZE;
      const d = Math.hypot(this.player.position.x - x, this.player.position.y - y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestPos = new Vec2(x, y);
      }
    }
    Audio.playSoundAt('build', nearestPos);
  }

  private tickAdvancedRegenConduitRepair(dt: number): void {
    if (!this.researchedItems.has('advancedRegenTurrets') || this.destroyedConduits.length === 0) return;
    this.advancedRegenConduitRepairTimer -= dt;
    if (this.advancedRegenConduitRepairTimer > 0) return;
    this.advancedRegenConduitRepairTimer = 0.5;

    let repaired = 0;
    let nearestRepairDist = Infinity;
    let nearestRepairPos = this.player.position;
    for (const b of this.buildings) {
      if (!b.alive || b.team !== Team.Player || !(b instanceof TurretBase)) continue;
      if (b.type !== EntityType.RegenTurret || b.buildProgress < 1 || !b.powered) continue;
      const conduit = this.findDestroyedConduitForRegenTurret(b);
      if (!conduit) continue;
      this.grid.addConduit(conduit.cx, conduit.cy, conduit.team);
      conduit.erased = true;
      repaired++;
      const pos = new Vec2((conduit.cx + 0.5) * GRID_CELL_SIZE, (conduit.cy + 0.5) * GRID_CELL_SIZE);
      const repairDist = this.player.position.distanceTo(pos);
      if (repairDist < nearestRepairDist) {
        nearestRepairDist = repairDist;
        nearestRepairPos = pos;
      }
      b.turretAngle = b.position.angleTo(pos);
      b.showBeam(pos);
      this.particles.emitHealing(pos);
      this.ringEffects.spawn('build_complete_wave', pos, 5, 42, 0.42, 0.5);
    }
    if (repaired === 0) return;
    compactKeep(this.destroyedConduits, (c) => !c.erased);
    this.power.markDirty();
    Audio.playSoundAt('build', nearestRepairPos);
  }

  private findDestroyedConduitForRegenTurret(turret: TurretBase): DestroyedConduitRecord | null {
    let best: DestroyedConduitRecord | null = null;
    let bestDist = turret.range;
    for (const conduit of this.destroyedConduits) {
      if (conduit.erased || conduit.team !== turret.team) continue;
      if (!this.isConduitPlacementCellClear(conduit.cx, conduit.cy).valid) continue;
      const pos = new Vec2((conduit.cx + 0.5) * GRID_CELL_SIZE, (conduit.cy + 0.5) * GRID_CELL_SIZE);
      const dist = turret.position.distanceTo(pos);
      if (dist <= bestDist) {
        best = conduit;
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * True when (cx, cy) is orthogonally adjacent to an energized conduit of
   * the same team or to the footprint of a finished powered same-team building.
   */
  private isAtConduitFrontier(cx: number, cy: number, team: Team): boolean {
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (
        this.grid.hasConduit(nx, ny) &&
        this.grid.conduitTeam(nx, ny) === team &&
        this.power.isCellEnergized(team, nx, ny)
      ) {
        return true;
      }
    }
    for (const b of this.buildings) {
      if (!b.alive || b.team !== team) continue;
      if (b.buildProgress < 1 || !b.powered) continue;
      const size = footprintForBuildingType(b.type);
      const origin = buildingFootprintOrigin(b);
      const endCx = origin.cx + size - 1;
      const endCy = origin.cy + size - 1;
      const orthogonal =
        (cy >= origin.cy && cy <= endCy && (cx === origin.cx - 1 || cx === endCx + 1)) ||
        (cx >= origin.cx && cx <= endCx && (cy === origin.cy - 1 || cy === endCy + 1));
      if (orthogonal) return true;
    }
    return false;
  }

  private applyProjectileDamage(proj: ProjectileBase, target: Entity): void {
    const blastRadius = this.projectileBlastRadius(proj);
    if (blastRadius > 0) {
      this.applyBlastDamage(proj, target, blastRadius);
      this.emitFancyExplosion(proj.position, blastRadius);
      return;
    }

    target.takeDamage(proj.damage, proj);
    this.recentlyDamaged.add(target.id);
    if (!target.alive) {
      this.particles.emitExplosion(target.position, target.radius);
      this.pendingCrystalExplosions.push({ x: target.position.x, y: target.position.y, radius: Math.max(60, target.radius * 4) });
      this.pendingShakeMagnitude = Math.min(Camera.MAX_SHAKE, this.pendingShakeMagnitude + Math.min(4, target.radius * 0.12));
      this.playEntityExplosionSound(target);
    } else {
      const hitAngle = Math.atan2(proj.velocity.y, proj.velocity.x);
      this.emitBuildingDamageSparks(target, proj.position);
      this.particles.emitImpact(target.position, hitAngle);
      Audio.playSoundAt('bhit0', target.position);
    }
  }

  private projectileBlastRadius(proj: ProjectileBase): number {
    const maybeBlast = proj as ProjectileBase & { blastRadius?: number };
    return typeof maybeBlast.blastRadius === 'number' ? maybeBlast.blastRadius : 0;
  }

  private applyBlastDamage(proj: ProjectileBase, directTarget: Entity, blastRadius: number): void {
    for (const e of this.queryEntitiesInRange(proj.position, blastRadius + ENTITY_RADIUS.building, this.spatialQueryScratch)) {
      if (!e.alive || e === proj || e.team === Team.Neutral || e.team === proj.team) continue;
      const d = e.position.distanceTo(proj.position);
      if (d > blastRadius + e.radius) continue;
      const falloff = Math.max(0.35, 1 - d / Math.max(1, blastRadius));
      e.takeDamage(e === directTarget ? proj.damage : proj.damage * falloff, proj);
      this.recentlyDamaged.add(e.id);
      if (!e.alive) this.playEntityExplosionSound(e);
      else this.emitBuildingDamageSparks(e, proj.position);
    }
  }

  private emitFancyExplosion(pos: Vec2, blastRadius: number): void {
    this.particles.emitExplosion(pos, blastRadius * 0.45);
    this.particles.emitExplosion(pos, blastRadius * 0.22);
    this.spawnExplosionGlow(pos, blastRadius);
    this.ringEffects.spawn('shockwave', pos, blastRadius * 0.08, blastRadius * 1.08, 0.55, 1.35);
    this.ringEffects.spawn('blackout_wave', pos, blastRadius * 0.2, blastRadius * 0.78, 0.36, 0.5);
    // Crystal nebula shockwave ring
    this.pendingCrystalExplosions.push({ x: pos.x, y: pos.y, radius: blastRadius * 1.6 });
    // Larger blasts contribute more shake
    this.pendingShakeMagnitude = Math.min(Camera.MAX_SHAKE, this.pendingShakeMagnitude + Math.min(7, blastRadius * 0.07));
    Audio.playSoundAt(blastRadius > 70 ? 'explode2' : 'explode1', pos);
  }

  private spawnExplosionGlow(pos: Vec2, blastRadius: number): void {
    this.explosionGlows.push({
      center: pos.clone(),
      radius: blastRadius,
      lifeSeconds: 0.42,
      totalSeconds: 0.42,
      intensity: blastRadius > 80 ? 1.15 : 0.9,
    });
    if (this.explosionGlows.length > 32) {
      this.explosionGlows.splice(0, this.explosionGlows.length - 32);
    }
  }

  private updateExplosionGlows(dt: number): void {
    for (const glow of this.explosionGlows) glow.lifeSeconds -= dt;
    if (this.explosionGlows.length > 0) {
      compactKeep(this.explosionGlows, (glow) => glow.lifeSeconds > 0);
    }
  }

  private detonateProjectile(proj: ProjectileBase): void {
    const blastRadius = this.projectileBlastRadius(proj);
    if (blastRadius <= 0) return;
    this.applyBlastDamage(proj, proj, blastRadius);
    this.emitFancyExplosion(proj.position, blastRadius);
  }

  private playEntityExplosionSound(target: Entity): void {
    if (
      target.type === EntityType.CommandPost ||
      target.type === EntityType.PowerGenerator ||
      target.type === EntityType.FighterYard ||
      target.type === EntityType.BomberYard ||
      target.type === EntityType.SwarmYard ||
      target.type === EntityType.ResearchLab ||
      target.type === EntityType.Factory
    ) {
      Audio.playSoundAt('explode2', target.position);
    } else if (
      target.type === EntityType.GatlingTurret ||
      target.type === EntityType.MissileTurret ||
      target.type === EntityType.Wall ||
      target.type === EntityType.TimeBomb ||
      target.type === EntityType.ExciterTurret ||
      target.type === EntityType.MassDriverTurret ||
      target.type === EntityType.RegenTurret ||
      target.type === EntityType.PlayerShip
    ) {
      Audio.playSoundAt('explode1', target.position);
    } else {
      Audio.playSoundAt('explode0', target.position);
    }
  }

  private addAutomaticBuildingConduits(building: BuildingBase): void {
    if (!building.alive || building.team === Team.Neutral) return;
    if (building.type === EntityType.Wall) return;
    if (isConfluenceFaction(this.factionByTeam, building.team)) return;
    const size = footprintForBuildingType(building.type);
    const origin = buildingFootprintOrigin(building);
    let planned = 0;

    for (let y = origin.cy - 1; y <= origin.cy + size; y++) {
      for (let x = origin.cx - 1; x <= origin.cx + size; x++) {
        const isPerimeter =
          x === origin.cx - 1 ||
          x === origin.cx + size ||
          y === origin.cy - 1 ||
          y === origin.cy + size;
        if (!isPerimeter) continue;
        if (
          x < 0 ||
          y < 0 ||
          (x + 1) * GRID_CELL_SIZE > WORLD_WIDTH ||
          (y + 1) * GRID_CELL_SIZE > WORLD_HEIGHT
        ) {
          continue;
        }
        planned += this.planAutomaticConduit(x, y, building.team);
      }
    }

    if (planned > 0) this.power.markDirty();
  }

  private planAutomaticConduit(cx: number, cy: number, team: Team): number {
    if (this.grid.hasConduit(cx, cy) || this.grid.hasPendingConduit(cx, cy)) return 0;
    if (this.isCellOccupiedByBuilding(cx, cy)) return 0;
    this.grid.queueConduit(cx, cy, team);
    return 1;
  }

  private applyNovaBombPulse(proj: SynonymousNovaBomb): void {
    // Nova Bombs apply two fixed-damage pulses; radius/damage are already
    // scaled by living bomber drones when the projectile is created.
    for (const e of this.queryEntitiesInRange(proj.position, proj.aoeRadius + ENTITY_RADIUS.building, this.spatialQueryScratch)) {
      if (!e.alive || e === proj || e.team === Team.Neutral || e.team === proj.team) continue;
      if (e.position.distanceTo(proj.position) > proj.aoeRadius + e.radius) continue;
      e.takeDamage(proj.pulseDamage, proj);
      this.recentlyDamaged.add(e.id);
      if (!e.alive) this.playEntityExplosionSound(e);
      else this.emitBuildingDamageSparks(e, proj.position);
    }
    this.spawnExplosionGlow(proj.position, proj.aoeRadius);
    this.ringEffects.spawn('shockwave', proj.position, proj.aoeRadius * 0.05, proj.aoeRadius, 0.45, 0.9);
  }

  startDeletingBuildingAt(pos: Vec2, team: Team): BuildingBase | null {
    const px = Math.floor(pos.x / GRID_CELL_SIZE);
    const py = Math.floor(pos.y / GRID_CELL_SIZE);
    let best: BuildingBase | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings) {
      if (!b.alive || b.team !== team) continue;
      const size = footprintForBuildingType(b.type);
      const origin = buildingFootprintOrigin(b);
      if (px < origin.cx || px >= origin.cx + size || py < origin.cy || py >= origin.cy + size) {
        continue;
      }
      const d = b.position.distanceTo(pos);
      if (d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    if (!best) return null;
    if (best.type === EntityType.CommandPost) return null;
    best.startDeleting();
    return best;
  }

  private applyMassDriverPulse(proj: MassDriverBullet, radius: number): void {
    for (const e of this.queryEntitiesInRange(proj.position, radius + ENTITY_RADIUS.building, this.spatialQueryScratch)) {
      if (!e.alive || e === proj || e.team === Team.Neutral || e.team === proj.team) continue;
      const d = e.position.distanceTo(proj.position);
      if (d > radius + e.radius) continue;
      const falloff = Math.max(0.45, 1 - d / Math.max(1, radius));
      e.takeDamage(proj.damage * falloff, proj);
      this.recentlyDamaged.add(e.id);
      if (!e.alive) this.playEntityExplosionSound(e);
      else this.emitBuildingDamageSparks(e, proj.position);
    }
    this.ringEffects.spawn('shockwave', proj.position.clone(), radius * 0.35, radius, 0.22, 1.1);
    Audio.playSoundAt('explode1', proj.position);
  }

  private applyAdvancedFighterHazardAvoidance(fighter: FighterShip, dt: number): void {
    if (!fighter.advancedTier || fighter.docked || !fighter.alive) return;
    for (const p of this.queryEntitiesInRange(fighter.position, 220, this.spatialQueryScratch)) {
      if (!(p instanceof MassDriverBullet) || !p.isBursting || p.team === fighter.team) continue;
      fighter.avoidHazard(p.position, p.radius, dt);
    }
  }

  private emitBuildingDamageSparks(target: Entity, hitSource: Vec2): void {
    if (!(target instanceof BuildingBase)) return;
    const impact = this.buildingImpactFromPoint(target, hitSource);
    this.particles.emitBuildingDamageSparks(impact.pos, impact.outwardAngle);
  }

  private buildingImpactFromPoint(building: BuildingBase, from: Vec2): { pos: Vec2; outwardAngle: number } {
    let inward = building.position.sub(from);
    if (inward.length() <= 0.001) inward = new Vec2(1, 0);
    inward = inward.normalize();
    return {
      pos: building.position.sub(inward.scale(building.radius)),
      outwardAngle: Math.atan2(-inward.y, -inward.x),
    };
  }

  sellAtGridCell(pos: Vec2, team: Team): 'building' | 'conduit' | null {
    const cx = Math.floor(pos.x / GRID_CELL_SIZE);
    const cy = Math.floor(pos.y / GRID_CELL_SIZE);
    const building = this.startDeletingBuildingAt(pos, team);
    if (building) return 'building';
    if (this.grid.conduitTeam(cx, cy) === team || this.grid.pendingConduitTeam(cx, cy) === team) {
      this.grid.removeConduit(cx, cy);
      if (team === Team.Player) this.resources += CONDUIT_COST;
      this.power.markDirty();
      return 'conduit';
    }
    return null;
  }

  /**
   * Remove construction that has not become operational yet and return its
   * full purchase price. Used when the player ship enters ghost mode.
   */
  cancelPlannedConstruction(team: Team): { buildings: number; conduits: number; refund: number } {
    let buildings = 0;
    let refund = 0;
    for (const building of this.buildings) {
      if (!building.alive || building.team !== team || building.buildProgress >= 1) continue;
      if (isSynonymousFaction(this.factionByTeam, team)) {
        this.synonymous.releaseBuilding(building.id, this.gameTime, { sold: true });
      } else {
        refund += building.placementCost ?? buildCostForBuildingType(building.type);
      }
      building.destroy();
      buildings++;
    }

    const conduits = this.grid.cancelPendingConduits(team);
    refund += conduits * CONDUIT_COST;
    if (team === Team.Player && refund > 0) this.resources += refund;
    if (buildings > 0 || conduits > 0) this.power.markDirty();
    return { buildings, conduits, refund };
  }

  eraseBlueprintAt(pos: Vec2, team: Team): boolean {
    const px = Math.floor(pos.x / GRID_CELL_SIZE);
    const py = Math.floor(pos.y / GRID_CELL_SIZE);
    let removed = false;
    for (const wreck of this.destroyedBuildings) {
      if (wreck.erased || wreck.team !== team) continue;
      const cx = Math.floor(wreck.position.x / GRID_CELL_SIZE);
      const cy = Math.floor(wreck.position.y / GRID_CELL_SIZE);
      const size = footprintForBuildingType(wreck.type);
      const origin = footprintOrigin(cx, cy, size);
      if (px >= origin.cx && px < origin.cx + size && py >= origin.cy && py < origin.cy + size) {
        wreck.erased = true;
        removed = true;
      }
    }
    for (const conduit of this.destroyedConduits) {
      if (conduit.erased || conduit.team !== team) continue;
      if (conduit.cx === px && conduit.cy === py) {
        conduit.erased = true;
        removed = true;
      }
    }
    if (removed) {
      compactKeep(this.destroyedBuildings, (w) => !w.erased);
      compactKeep(this.destroyedConduits, (c) => !c.erased);
    }
    return removed;
  }

  private completeBuildingDeletions(): void {
    for (const b of this.buildings) {
      if (!b.alive || !b.deleting || b.deletionProgress < 1) continue;
      if (b.team === Team.Player) {
        if (isSynonymousFaction(this.factionByTeam, b.team)) {
          this.synonymous.releaseBuilding(b.id, this.gameTime, { sold: true });
        } else {
          this.resources += buildCostForBuildingType(b.type) * b.healthFraction;
        }
      }
      b.destroy();
      this.power.markDirty();
    }
  }


  // -----------------------------------------------------------------------
  // Research
  // -----------------------------------------------------------------------

  private tickResearch(dt: number): void {
    if (!this.researchProgress.item) return;

    // Need a research lab
    const hasLab = this.buildings.some(
      (b) =>
        b.alive &&
        b.type === EntityType.ResearchLab &&
        b.team === Team.Player &&
            (isSynonymousFaction(this.factionByTeam, b.team) || b.powered) &&
            b.buildProgress >= 1,
    );
    if (!hasLab) return;

    this.researchProgress.progress += dt;
    if (this.researchProgress.progress >= this.researchProgress.timeNeeded) {
      const completed = this.researchProgress.item;
      this.researchedItems.add(completed);
      this.player.applyResearchUpgrade(completed);
      if (completed === 'advancedFighters') {
        for (const b of this.buildings) {
          if (b.alive && b.team === Team.Player && b instanceof Shipyard) {
            b.shipCapacity = 7;
            b.buildInterval = 4;
          }
        }
        for (const f of this.fighters) {
          if (f.alive && f.team === Team.Player) f.upgradeToAdvanced();
        }
      } else if (completed === 'shipShield1') {
        for (const f of this.fighters) {
          if (f.alive && f.team === Team.Player && !f.docked && f.position.distanceTo(this.player.position) <= 90) {
            f.enableShield();
          }
        }
      } else if (completed === 'poweredWalls') {
        for (const b of this.buildings) {
          if (b.alive && b.team === Team.Player && b instanceof Wall) b.enablePoweredWall();
        }
      }
      this.completedResearchNotifications.push(completed);
      this.researchProgress = { item: null, progress: 0, timeNeeded: 0 };
      this.startNextQueuedResearch();
      Audio.playSound('researchcomplete');
    }
  }

  private startNextQueuedResearch(): void {
    while (!this.researchProgress.item && this.researchQueue.length > 0) {
      const next = this.researchQueue.shift()!;
      if (this.researchedItems.has(next)) continue;
      const ticks = RESEARCH_TIME[next as keyof typeof RESEARCH_TIME];
      if (ticks === undefined) continue;
      this.researchProgress = { item: next, progress: 0, timeNeeded: ticks / TICK_RATE };
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanupDead(): void {
    const beforeBuildings = this.buildings.length;
    for (const b of this.buildings) {
      if (b.alive || b.deleting) continue;
      // GOAL 1: When a shipyard is destroyed, release its docked fighters so
      // they defend the team's base instead of drifting idle.
      if ((b.type === EntityType.FighterYard || b.type === EntityType.BomberYard || b.type === EntityType.SwarmYard) && b instanceof Shipyard) {
        this.releaseDeferredFighters(b);
      }
      this.destroyedBuildings.push({
        type: b.type,
        team: b.team,
        position: b.position.clone(),
        maxHealth: b.maxHealth,
      });
      this.awardSurvivalDestroyedBuildingReward(b);
      this.ringEffects.spawn('shockwave', b.position, b.radius * 0.7, b.radius * 5.5, 0.75, b.team === Team.Player ? 0.85 : 1.05);
    }
    compactAlive(this.buildings);
    if (this.buildings.length !== beforeBuildings) {
      this.power.markDirty();
      this.markBuildingCollisionDirty();
    }
    compactAlive(this.projectiles);
    compactAlive(this.fighters);
  }

  private awardSurvivalDestroyedBuildingReward(b: BuildingBase): void {
    if (!this.survivalKillRewardsEnabled || b.deleting) return;
    const sourceTeam = b.lastDamageSource?.team ?? Team.Neutral;
    if (sourceTeam === Team.Neutral || sourceTeam === b.team) return;
    const amount = b.type === EntityType.CommandPost ? 99 : Math.max(1, Math.floor(buildCostForBuildingType(b.type) * 0.5));
    if (sourceTeam === Team.Player) {
      if (!isSynonymousFaction(this.factionByTeam, Team.Player)) this.resources += amount;
    } else if (b.team === Team.Player) {
      this.survivalEnemyRewardBank += amount;
    } else {
      return;
    }
    this.particles.emitFloatingText(b.position.add(new Vec2(0, -b.radius - 12)), `+${amount}`, teamColor(sourceTeam));
  }

  private recordDestroyedConduit(cx: number, cy: number, team: Team): void {
    if (this.destroyedConduits.some((c) => !c.erased && c.cx === cx && c.cy === cy && c.team === team)) return;
    this.destroyedConduits.push({ cx, cy, team });
  }

  // -----------------------------------------------------------------------
  // GOAL 1: Fighter release on shipyard destruction
  // -----------------------------------------------------------------------

  /**
   * When a shipyard is destroyed, launch all docked fighters and redirect any
   * fighters returning to dock so they defend the team's command post instead
   * of drifting idle.  The `fightersReleased` guard prevents this from
   * running more than once per yard.
   */
  private releaseDeferredFighters(yard: Shipyard): void {
    if (yard.fightersReleased) return;
    yard.fightersReleased = true;

    const cp = this.getCommandPostForTeam(yard.team);
    const defendPos = cp?.position ?? null;
    let released = 0;

    for (const f of this.fighters) {
      if (!f.alive || f.homeYard !== yard) continue;
      // Detach so the fighter no longer references a dead yard
      f.homeYard = null;

      if (f.docked) {
        // Fighter was still in the bay — launch it into the world
        f.launch();
        released++;
      } else if (f.order === 'dock') {
        // Fighter was flying back to dock — redirect it instead of idling
        released++;
      } else {
        // Fighter is already active with another order; leave it alone but
        // clear the homeYard reference so it won't try to return later.
        continue;
      }
      // Give the fighter a base-defence order
      f.order = 'protect';
      f.targetPos = defendPos ? defendPos.clone() : null;
    }

    if (released > 0) {
      // Small visual cue — particles burst at the yard position
      this.particles.emitExplosion(yard.position, yard.radius * 0.55);
    }
  }

  // -----------------------------------------------------------------------
  // GOAL 3C: Swarm missile interception by enemy projectiles
  // -----------------------------------------------------------------------

  /**
   * Check whether any non-interceptable enemy projectile hits an
   * interceptable projectile (e.g. SwarmMissile).  When a hit is detected
   * the interceptor is consumed and the swarm missile detonates via its
   * existing blast-radius logic.
   */
  private resolveProjectileInterceptions(): void {
    for (let i = 0; i < this.projectiles.length; i++) {
      const bullet = this.projectiles[i];
      if (!bullet.alive || bullet.interceptable) continue;

      const bulletEnd = projectileSegmentEnd(bullet);
      const nearby = bulletEnd === bullet.position
        ? this.queryEntitiesInRange(bullet.position, bullet.radius + ENTITY_RADIUS.missile + 12, this.spatialQueryScratch)
        : this.queryEntitiesNearSegment(bullet.position, bulletEnd, bullet.radius + ENTITY_RADIUS.missile + 12, this.spatialQueryScratch);
      for (const candidate of nearby) {
        if (!(candidate instanceof ProjectileBase)) continue;
        const swarm = candidate;
        if (!swarm.alive || !swarm.interceptable || bullet === swarm) continue;
        if (bullet.team === swarm.team) continue;

        const swarmEnd = projectileSegmentEnd(swarm);
        const dist = segmentSegmentDistance(swarm.position, swarmEnd, bullet.position, bulletEnd);
        if (dist < swarm.radius + bullet.radius) {
          bullet.destroy(); // the intercepting bullet is consumed
          swarm.takeDamage(Math.max(1, Math.abs(bullet.damage)), bullet);
          this.recentlyDamaged.add(swarm.id);
          this.particles.emitSpark(swarm.position);
          if (!swarm.alive) this.detonateProjectile(swarm);
          break; // this swarm missile is gone; move to the next one
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Drawing — calls draw on every entity
  // -----------------------------------------------------------------------

  drawEntities(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.drawBlueprintOutlines(ctx, camera);
    // Draw exhaust/thrust particles BEFORE all ship bodies so thrust visually
    // sits underneath the ship silhouettes rather than on top of them.
    this.particles.drawExhaust(ctx, camera);
    for (const b of this.buildings) {
      if (!camera.isOnScreen(b.position, GRID_CELL_SIZE * 8)) continue;
      b.draw(ctx, camera);
    }
    this.synonymous.draw(ctx, camera, this.gameTime);
    for (const f of this.fighters) {
      if (!f.alive || f.docked || this.shouldSleepDistantStagedFighter(f)) continue;
      if (!camera.isOnScreen(f.position, GRID_CELL_SIZE * 5)) continue;
      f.draw(ctx, camera);
    }
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      if (!camera.isOnScreen(p.position, GRID_CELL_SIZE * 16)) continue;
      p.draw(ctx, camera);
    }
    for (const ship of this.playerShips.values()) {
      if (ship.alive) ship.draw(ctx, camera);
    }
    this.particles.draw(ctx, camera);
    this.ringEffects.draw(ctx, camera);
  }

  private drawBlueprintOutlines(ctx: CanvasRenderingContext2D, camera: Camera): void {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (const wreck of this.destroyedBuildings) {
      if (wreck.erased) continue;
      if (!camera.isOnScreen(wreck.position, GRID_CELL_SIZE * 8)) continue;
      const screen = camera.worldToScreen(wreck.position);
      const color = wreck.team === Team.Player
        ? colorToCSS(Colors.radar_friendly_status, 0.23)
        : colorToCSS(Colors.enemyfire, 0.16);
      const r = ENTITY_RADIUS.building * camera.zoom;
      const size = footprintForBuildingType(wreck.type) * GRID_CELL_SIZE * camera.zoom;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeRect(screen.x - size / 2, screen.y - size / 2, size, size);
    }
    for (const conduit of this.destroyedConduits) {
      if (conduit.erased) continue;
      const world = new Vec2(
        (conduit.cx + 0.5) * GRID_CELL_SIZE,
        (conduit.cy + 0.5) * GRID_CELL_SIZE,
      );
      if (!camera.isOnScreen(world, GRID_CELL_SIZE * 3)) continue;
      const screen = camera.worldToScreen(world);
      const cellPx = GRID_CELL_SIZE * camera.zoom;
      ctx.strokeStyle = conduit.team === Team.Player
        ? colorToCSS(Colors.radar_friendly_status, 0.20)
        : colorToCSS(Colors.enemyfire, 0.14);
      ctx.strokeRect(screen.x - cellPx / 2 + 1, screen.y - cellPx / 2 + 1, cellPx - 2, cellPx - 2);
    }
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Get the player's command post, if it exists. */
  getPlayerCommandPost(): CommandPost | null {
    return (
      (this.buildings.find(
        (b) => b.alive && b.type === EntityType.CommandPost && b.team === Team.Player,
      ) as CommandPost) ?? null
    );
  }

  /** Get the enemy's command post, if it exists. */
  getEnemyCommandPost(): CommandPost | null {
    return (
      (this.buildings.find(
        (b) => b.alive && b.type === EntityType.CommandPost && b.team === Team.Enemy,
      ) as CommandPost) ?? null
    );
  }

  /** Get the command post for any given team. */
  getCommandPostForTeam(team: Team): CommandPost | null {
    return (
      (this.buildings.find(
        (b) => b.alive && b.type === EntityType.CommandPost && b.team === team,
      ) as CommandPost) ?? null
    );
  }

  /** Check if the player has a research lab. */
  hasResearchLab(): boolean {
    return this.buildings.some(
      (b) => b.alive && b.type === EntityType.ResearchLab && b.team === Team.Player,
    );
  }

  /** Get fighters of a specific group and team. */
  getFightersByGroup(team: Team, group: number): FighterShip[] {
    return this.fighters.filter(
      (f) => f.alive && f.team === team && f.group === group,
    );
  }

  resolveShipNavigationTarget(ship: Entity, target: Vec2, intelligence: number = 1): Vec2 {
    const adjustedTarget = adjustNavigationTargetOutOfBlockers(this, target, ship.radius);
    return resolveShipNavigationTarget(this, ship.position, adjustedTarget, {
      team: ship.team,
      intelligence,
      radius: ship.radius,
      preferBreach: intelligence >= 3,
    });
  }

  scoreShipRoute(from: Vec2, target: Vec2, team: Team, radius: number, intelligence: number = 1): number {
    return scoreShipRoute(this, from, target, {
      team,
      intelligence,
      radius,
      preferBreach: intelligence >= 3,
    });
  }

  private shouldSleepDistantStagedFighter(f: FighterShip): boolean {
    if (f.team !== Team.Enemy) return false;
    if (f.order !== 'waypoint' && f.order !== 'follow' && f.order !== 'protect') return false;
    const dx = f.position.x - this.player.position.x;
    const dy = f.position.y - this.player.position.y;
    return dx * dx + dy * dy > DISTANT_STAGED_FIGHTER_SLEEP_RANGE_SQ;
  }

  private updateFighterNavigation(f: FighterShip): void {
    if (!f.alive || f.docked) {
      f.setNavigationTarget(null);
      this.fighterNavCache.delete(f.id);
      return;
    }
    this.updateSwarmShipCombatTarget(f);
    if (f.order === 'protect') {
      f.targetPos = this.resolveProtectBaseRallyPoint(f);
    }
    const target = f.order === 'dock' && f.homeYard
      ? f.homeYard.position
      : f.targetPos;
    if (!target) {
      f.setNavigationTarget(null);
      this.fighterNavCache.delete(f.id);
      return;
    }
    const adjustedTarget = adjustNavigationTargetOutOfBlockers(this, target, f.radius);
    const cached = this.fighterNavCache.get(f.id);
    const targetMovedSq = cached
      ? (adjustedTarget.x - cached.targetX) ** 2 + (adjustedTarget.y - cached.targetY) ** 2
      : Infinity;
    const shipMovedSq = cached
      ? (f.position.x - cached.fromX) ** 2 + (f.position.y - cached.fromY) ** 2
      : Infinity;
    const reachedCachedWaypointSq = cached
      ? (f.position.x - cached.navTarget.x) ** 2 + (f.position.y - cached.navTarget.y) ** 2
      : Infinity;
    const cachedBlocked = cached ? isNavigationTargetBlocked(this, cached.navTarget, f.radius) : true;
    const distanceToTarget = f.position.distanceTo(adjustedTarget);
    const progressDelta = cached ? cached.lastDistanceToTarget - distanceToTarget : Infinity;
    const stuckSince = cached && progressDelta < GRID_CELL_SIZE * 0.25
      ? cached.stuckSince
      : this.gameTime;
    const stuck = cached ? this.gameTime - stuckSince > 1.1 : false;
    const targetRefreshDistanceSq = (GRID_CELL_SIZE * 2.5) ** 2;
    const shipRefreshDistanceSq = (GRID_CELL_SIZE * (stuck ? 3 : 7)) ** 2;
    const waypointRefreshDistanceSq = (GRID_CELL_SIZE * 1.5) ** 2;
    if (
      cached &&
      this.gameTime < cached.nextUpdateAt &&
      targetMovedSq < targetRefreshDistanceSq &&
      shipMovedSq < shipRefreshDistanceSq &&
      reachedCachedWaypointSq > waypointRefreshDistanceSq &&
      !cachedBlocked
    ) {
      f.setNavigationTarget(cached.navTarget);
      noteShipPathCacheReuse();
      return;
    }
    const intelligence = f.team === Team.Enemy ? 2 : 1;
    const sharedKey = this.sharedFighterPathKey(f, adjustedTarget);
    const shared = this.sharedFighterPathCache.get(sharedKey);
    if (shared && this.gameTime < shared.expiresAt && !isNavigationTargetBlocked(this, shared.navTarget, f.radius)) {
      const navTarget = this.offsetSharedFighterWaypoint(shared.navTarget, f.id);
      this.storeFighterNavCache(f, adjustedTarget, navTarget, distanceToTarget, stuckSince, stuck);
      f.setNavigationTarget(navTarget);
      noteShipPathCacheReuse(true);
      return;
    }

    if (!this.consumePathBudget()) {
      if (cached && !cachedBlocked) {
        f.setNavigationTarget(cached.navTarget);
        noteShipPathCacheReuse();
      } else {
        f.setNavigationTarget(adjustedTarget);
      }
      noteShipPathSkipped();
      return;
    }

    const navTarget = this.resolveShipNavigationTarget(f, adjustedTarget, intelligence);
    this.sharedFighterPathCache.set(sharedKey, {
      navTarget: navTarget.clone(),
      targetX: adjustedTarget.x,
      targetY: adjustedTarget.y,
      expiresAt: this.gameTime + (f.team === Team.Player ? 0.55 : 0.38),
    });
    this.storeFighterNavCache(f, adjustedTarget, navTarget, distanceToTarget, stuckSince, stuck);
    f.setNavigationTarget(navTarget);
  }

  private updateSwarmShipCombatTarget(f: FighterShip): void {
    if (!(f instanceof SwarmShip)) return;
    if (f.order === 'dock' || f.order === 'follow') return;
    const target = findClosestEnemy(this, f.position, f.team, Math.max(f.weaponRange * 2.7, GRID_CELL_SIZE * 6));
    if (!target) return;
    f.order = 'attack';
    f.targetPos = target.position.clone();
  }

  private beginNavigationFrame(): void {
    const token = Math.floor(this.gameTime * 60);
    beginShipPathFrame(token);
    if (token === this.pathBudgetFrameToken) return;
    this.pathBudgetFrameToken = token;
    this.pathBudgetRemaining = 4;
    if (this.sharedFighterPathCache.size > 96) this.sharedFighterPathCache.clear();
  }

  private consumePathBudget(): boolean {
    if (this.pathBudgetRemaining <= 0) return false;
    this.pathBudgetRemaining--;
    return true;
  }

  private storeFighterNavCache(
    f: FighterShip,
    target: Vec2,
    navTarget: Vec2,
    distanceToTarget: number,
    stuckSince: number,
    stuck: boolean,
  ): void {
    this.fighterNavCache.set(f.id, {
      targetX: target.x,
      targetY: target.y,
      fromX: f.position.x,
      fromY: f.position.y,
      nextUpdateAt: this.gameTime + this.fighterNavRefreshSeconds(f, stuck),
      navTarget,
      lastDistanceToTarget: distanceToTarget,
      stuckSince,
    });
  }

  private fighterNavRefreshSeconds(f: FighterShip, stuck: boolean): number {
    const jitter = ((f.id * 37) % 17) * 0.011;
    if (stuck) return 0.24 + jitter;
    return (f.team === Team.Enemy ? 0.55 : 0.72) + jitter;
  }

  private sharedFighterPathKey(f: FighterShip, target: Vec2): string {
    const sourceBucket = GRID_CELL_SIZE * 8;
    const targetBucket = GRID_CELL_SIZE * 4;
    return [
      f.team,
      Math.floor(f.position.x / sourceBucket),
      Math.floor(f.position.y / sourceBucket),
      Math.floor(target.x / targetBucket),
      Math.floor(target.y / targetBucket),
    ].join(':');
  }

  private offsetSharedFighterWaypoint(navTarget: Vec2, id: number): Vec2 {
    const angle = (id * 2.399963229728653) % (Math.PI * 2);
    const radius = 8 + (id % 5) * 3;
    return new Vec2(navTarget.x + Math.cos(angle) * radius, navTarget.y + Math.sin(angle) * radius);
  }

  private resolveProtectBaseRallyPoint(f: FighterShip): Vec2 | null {
    const base = this.playerBasePerimeter(f.team);
    if (!base) return this.getCommandPostForTeam(f.team)?.position.clone() ?? null;

    const pointCount = Math.max(10, Math.min(24, Math.ceil(base.radius / 70)));
    const seed = Math.abs(Math.imul(f.id + 17, 2654435761));
    const direction = (seed & 1) === 0 ? 1 : -1;
    const stepSeconds = 1.65 + ((seed >>> 8) % 9) * 0.08;
    const step = Math.floor(this.gameTime / stepSeconds);
    const baseIndex = (seed >>> 12) % pointCount;
    const slot = ((baseIndex + direction * step) % pointCount + pointCount) % pointCount;
    const angularLooseness = (((seed >>> 18) % 100) / 100 - 0.5) * 0.28;
    const radiusLooseness = (((seed >>> 24) % 100) / 100 - 0.5) * 34;
    const angle = (slot / pointCount) * Math.PI * 2 + angularLooseness;
    const radius = Math.max(120, base.radius + radiusLooseness);

    return new Vec2(
      base.center.x + Math.cos(angle) * radius,
      base.center.y + Math.sin(angle) * radius,
    );
  }

  private playerBasePerimeter(team: Team): { center: Vec2; radius: number } | null {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let count = 0;

    for (const building of this.buildings) {
      if (!building.alive || building.team !== team) continue;
      const halfSide = footprintForBuildingType(building.type) * GRID_CELL_SIZE * 0.5;
      left = Math.min(left, building.position.x - halfSide);
      right = Math.max(right, building.position.x + halfSide);
      top = Math.min(top, building.position.y - halfSide);
      bottom = Math.max(bottom, building.position.y + halfSide);
      count++;
    }

    if (count === 0) return null;

    const center = new Vec2((left + right) * 0.5, (top + bottom) * 0.5);
    const halfWidth = (right - left) * 0.5;
    const halfHeight = (bottom - top) * 0.5;
    const padding = 110 + Math.min(130, count * 5);
    return {
      center,
      radius: Math.hypot(halfWidth, halfHeight) + padding,
    };
  }

  /** Count docked and total fighters for a group. */
  getFighterGroupCounts(
    team: Team,
    group: number,
  ): { docked: number; total: number } {
    let docked = 0;
    let total = 0;
    for (const f of this.fighters) {
      if (!f.alive || f.team !== team || f.group !== group) continue;
      total++;
      if (f.docked) docked++;
    }
    return { docked, total };
  }


  setFaction(team: Team, faction: FactionType): void {
    this.factionByTeam.set(team, faction);
    for (const ship of this.playerShips.values()) {
      if (ship.team === team) ship.setFaction(faction);
    }
    if (!isConfluenceFaction(this.factionByTeam, team)) {
      this.territoryCirclesByTeam.delete(team);
    }
    if (faction !== 'synonymous') this.synonymous.clearTeam(team);
  }

  ensureSynonymousSeedSwarm(team: Team, center: Vec2): void {
    if (!isSynonymousFaction(this.factionByTeam, team)) return;
    this.synonymous.setBase(team, center);
    if (this.synonymous.totalDroneCount(team) === 0) {
      this.synonymous.spawnAtBase(team, 120, this.gameTime);
    }
  }

  ensureConfluenceSeedCircle(team: Team, center: Vec2): void {
    if (!isConfluenceFaction(this.factionByTeam, team)) return;
    const circles = this.territoryCirclesByTeam.get(team) ?? [];
    if (circles.length > 0) return;
    circles.push({
      id: `c${this.nextTerritoryCircleId++}`,
      x: center.x,
      y: center.y,
      radius: CONFLUENCE_BASE_RADIUS,
      targetRadius: CONFLUENCE_BASE_RADIUS,
      createdAt: this.gameTime,
      growthStartTime: this.gameTime,
      growthDuration: 0,
    });
    this.territoryCirclesByTeam.set(team, circles);
  }

  private findNearestConfluenceCircle(team: Team, x: number, y: number): ConfluenceTerritoryCircle | null {
    const circles = this.territoryCirclesByTeam.get(team) ?? [];
    let best: ConfluenceTerritoryCircle | null = null;
    let bestAbs = Infinity;
    for (const c of circles) {
      const d = Math.hypot(x - c.x, y - c.y) - c.radius;
      const ad = Math.abs(d - CONFLUENCE_PLACEMENT_DISTANCE);
      if (ad < bestAbs) { bestAbs = ad; best = c; }
    }
    return best;
  }

  getPlacementStatus(def: BuildDef, cx: number, cy: number, team: Team): { valid: boolean; reason: string } {
    const capStatus = this.getBuildingCapStatus(def, team);
    if (!capStatus.valid) return capStatus;
    const conduitRefund = this.getReplaceableConduitValue(def, cx, cy, team);
    if (isSynonymousFaction(this.factionByTeam, team)) {
      const cost = SYNONYMOUS_BUILD_COST[def.key] ?? 0;
      if (team === Team.Player && cost > 0 && !this.synonymous.canSpend(team, cost)) {
        return { valid: false, reason: `Need ${cost} ${SYNONYMOUS_CURRENCY_SYMBOL}` };
      }
    } else if (this.resources + conduitRefund < this.getBuildCost(def, team) && team === Team.Player) {
      return { valid: false, reason: 'Not enough resources' };
    }
    const replaceConduitTeam =
      !isSynonymousFaction(this.factionByTeam, team) && !isConfluenceFaction(this.factionByTeam, team)
        ? team
        : undefined;
    const footprintStatus = this.getStructureFootprintStatus(def, cx, cy, replaceConduitTeam);
    if (!footprintStatus.valid) return footprintStatus;
    const origin = footprintOrigin(cx, cy, def.footprintCells);
    if (def.key === 'commandpost' || def.key === 'powergenerator' || def.key === 'wall') return { valid: true, reason: 'OK' };
    if (isSynonymousFaction(this.factionByTeam, team)) return { valid: true, reason: 'OK' };
    if (isConfluenceFaction(this.factionByTeam, team)) {
      const center = footprintCenter(cx, cy, def.footprintCells);
      const parent = this.findNearestConfluenceCircle(team, center.x, center.y);
      if (!parent) return { valid: false, reason: 'No territory' };
      const distanceFromCircleEdge = Math.hypot(center.x - parent.x, center.y - parent.y) - parent.radius;
      const minBand = CONFLUENCE_PLACEMENT_DISTANCE - CONFLUENCE_PLACEMENT_TOLERANCE;
      const maxBand = CONFLUENCE_PLACEMENT_DISTANCE + CONFLUENCE_PLACEMENT_TOLERANCE;
      if (distanceFromCircleEdge < minBand || distanceFromCircleEdge > maxBand) return { valid: false, reason: 'Place on Concentroid frontier band' };
      return { valid: true, reason: 'OK' };
    }
    if (this.isNearPowerNetwork(origin.cx, origin.cy, def.footprintCells, team)) return { valid: true, reason: 'OK' };
    return { valid: false, reason: 'Build near command post, generator, or powered conduit' };
  }

  getReplaceableConduitValue(def: BuildDef, cx: number, cy: number, team: Team): number {
    if (def.key === 'wall' || isSynonymousFaction(this.factionByTeam, team) || isConfluenceFaction(this.factionByTeam, team)) return 0;
    const origin = footprintOrigin(cx, cy, def.footprintCells);
    let value = 0;
    for (let y = origin.cy; y < origin.cy + def.footprintCells; y++) {
      for (let x = origin.cx; x < origin.cx + def.footprintCells; x++) {
        if (this.grid.conduitTeam(x, y) === team) value += CONDUIT_COST;
        if (this.grid.pendingConduitTeam(x, y) === team) value += CONDUIT_COST;
      }
    }
    return value;
  }

  sellReplaceableConduitsUnderFootprint(def: BuildDef, cx: number, cy: number, team: Team): number {
    if (def.key === 'wall' || isSynonymousFaction(this.factionByTeam, team) || isConfluenceFaction(this.factionByTeam, team)) return 0;
    const origin = footprintOrigin(cx, cy, def.footprintCells);
    let refunded = 0;
    for (let y = origin.cy; y < origin.cy + def.footprintCells; y++) {
      for (let x = origin.cx; x < origin.cx + def.footprintCells; x++) {
        if (this.grid.conduitTeam(x, y) === team || this.grid.pendingConduitTeam(x, y) === team) {
          this.grid.removeConduit(x, y);
          refunded += CONDUIT_COST;
        }
      }
    }
    if (refunded > 0) this.power.markDirty();
    return refunded;
  }

  getBuildCost(def: BuildDef, team: Team): number {
    if (def.key !== 'factory' || team !== Team.Player || isSynonymousFaction(this.factionByTeam, team)) return def.cost;
    return def.cost + this.countBuildingsOfType(EntityType.Factory, team) * FACTORY_COST_STEP;
  }

  private countBuildingsOfType(type: EntityType, team: Team): number {
    return this.buildings.filter((b) => b.alive && b.team === team && b.type === type).length;
  }

  private getBuildingCapStatus(def: BuildDef, team: Team): { valid: boolean; reason: string } {
    const type = def.key === 'fighteryard' ? EntityType.FighterYard
      : def.key === 'bomberyard' ? EntityType.BomberYard
      : def.key === 'swarmyard' ? EntityType.SwarmYard
      : def.key === 'factory' ? EntityType.Factory
      : def.key === 'researchlab' ? EntityType.ResearchLab
      : def.key === 'gatlingturret' ? EntityType.GatlingTurret
      : def.key === 'missileturret' ? EntityType.MissileTurret
      : def.key === 'synonymousminelayer' ? EntityType.TimeBomb
      : def.key === 'exciterturret' ? EntityType.ExciterTurret
      : def.key === 'massdriverturret' ? EntityType.MassDriverTurret
      : def.key === 'regenturret' ? EntityType.RegenTurret
      : null;
    if (type === null) return { valid: true, reason: 'OK' };
    const cap = type === EntityType.Factory ? MAX_FACTORIES
      : type === EntityType.ResearchLab ? MAX_RESEARCH_LABS
      : def.tier === 'turret' ? MAX_TURRETS_PER_KIND
      : type === EntityType.FighterYard ? 10
      : type === EntityType.BomberYard && team === Team.Player ? 3
      : type === EntityType.SwarmYard ? 5
      : 5;
    const count = this.countBuildingsOfType(type, team);
    if (count >= cap) {
      return {
        valid: false,
        reason: `${def.label} cap reached (${count}/${cap})`,
      };
    }
    return { valid: true, reason: 'OK' };
  }

  getStructureFootprintStatus(
    def: BuildDef,
    cx: number,
    cy: number,
    replaceConduitTeam?: Team,
  ): { valid: boolean; reason: string } {
    const origin = footprintOrigin(cx, cy, def.footprintCells);
    const endCx = origin.cx + def.footprintCells - 1;
    const endCy = origin.cy + def.footprintCells - 1;
    if (
      origin.cx < 0 ||
      origin.cy < 0 ||
      (endCx + 1) * GRID_CELL_SIZE > WORLD_WIDTH ||
      (endCy + 1) * GRID_CELL_SIZE > WORLD_HEIGHT
    ) {
      return { valid: false, reason: 'Outside world' };
    }
    for (let y = origin.cy; y <= endCy; y++) {
      for (let x = origin.cx; x <= endCx; x++) {
        const conduitTeam = this.grid.conduitTeam(x, y);
        const pendingTeam = this.grid.pendingConduitTeam(x, y);
        if (
          (conduitTeam !== null && conduitTeam !== replaceConduitTeam) ||
          (pendingTeam !== null && pendingTeam !== replaceConduitTeam)
        ) {
          return { valid: false, reason: 'Cell occupied by conduit' };
        }
      }
    }
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const size = footprintForBuildingType(b.type);
      const bo = buildingFootprintOrigin(b);
      const bx2 = bo.cx + size - 1;
      const by2 = bo.cy + size - 1;
      const overlaps = origin.cx <= bx2 && endCx >= bo.cx && origin.cy <= by2 && endCy >= bo.cy;
      if (overlaps) return { valid: false, reason: 'Cell occupied by building' };
    }
    return { valid: true, reason: 'OK' };
  }

  isConduitPlacementCellClear(cx: number, cy: number): { valid: boolean; reason: string } {
    if (
      cx < 0 ||
      cy < 0 ||
      (cx + 1) * GRID_CELL_SIZE > WORLD_WIDTH ||
      (cy + 1) * GRID_CELL_SIZE > WORLD_HEIGHT
    ) {
      return { valid: false, reason: 'Outside world' };
    }
    if (this.grid.hasConduit(cx, cy) || this.grid.hasPendingConduit(cx, cy)) {
      return { valid: false, reason: 'Cell occupied by conduit' };
    }
    if (this.isCellOccupiedByBuilding(cx, cy)) {
      return { valid: false, reason: 'Cell occupied by building' };
    }
    return { valid: true, reason: 'OK' };
  }

  isCellOccupiedByBuilding(cx: number, cy: number): boolean {
    for (const b of this.buildings) {
      if (!b.alive) continue;
      const size = footprintForBuildingType(b.type);
      const origin = buildingFootprintOrigin(b);
      if (cx >= origin.cx && cx < origin.cx + size && cy >= origin.cy && cy < origin.cy + size) {
        return true;
      }
    }
    return false;
  }


  applyConfluencePlacement(team: Team, pos: Vec2, sourceBuildingId?: string): void {
    if (!isConfluenceFaction(this.factionByTeam, team)) return;
    const circles = this.territoryCirclesByTeam.get(team) ?? [];
    if (circles.length === 0) return;
    const parent = this.findNearestConfluenceCircle(team, pos.x, pos.y);
    if (parent) {
      parent.targetRadius = Math.max(parent.targetRadius, Math.hypot(pos.x - parent.x, pos.y - parent.y) + CONFLUENCE_INCLUDE_MARGIN);
      parent.growthStartTime = this.gameTime;
      parent.growthDuration = CONFLUENCE_PARENT_EXPAND_DURATION;
    }
    circles.push({
      id: `c${this.nextTerritoryCircleId++}`,
      x: pos.x,
      y: pos.y,
      radius: 2,
      targetRadius: CONFLUENCE_BASE_RADIUS,
      parentCircleId: parent?.id,
      sourceBuildingId,
      createdAt: this.gameTime,
      growthStartTime: this.gameTime,
      growthDuration: CONFLUENCE_NEW_CIRCLE_GROW_DURATION,
    });
    this.territoryCirclesByTeam.set(team, circles);
  }

  private isNearPowerNetwork(originCx: number, originCy: number, size: number, team: Team): boolean {
    for (let y = originCy - 1; y <= originCy + size; y++) {
      for (let x = originCx - 1; x <= originCx + size; x++) {
        const border =
          x === originCx - 1 || x === originCx + size ||
          y === originCy - 1 || y === originCy + size;
        if (!border) continue;
        if (this.power.isCellEnergized(team, x, y)) return true;
        if (this.grid.conduitTeam(x, y) === team || this.grid.hasPendingConduit(x, y)) return true;
      }
    }
    for (const b of this.buildings) {
      if (!b.alive || b.team !== team) continue;
      if (b.type !== EntityType.CommandPost && b.type !== EntityType.PowerGenerator) continue;
      const sourceSize = footprintForBuildingType(b.type);
      const sourceOrigin = buildingFootprintOrigin(b);
      const sourceX2 = sourceOrigin.cx + sourceSize - 1;
      const sourceY2 = sourceOrigin.cy + sourceSize - 1;
      const adjacent =
        originCx <= sourceX2 + 1 &&
        originCx + size - 1 >= sourceOrigin.cx - 1 &&
        originCy <= sourceY2 + 1 &&
        originCy + size - 1 >= sourceOrigin.cy - 1;
      if (adjacent) return true;
    }
    return false;
  }
}
