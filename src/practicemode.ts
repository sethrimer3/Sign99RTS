/** Practice mode game logic for Sign99. */

import { Vec2, randomRange } from './math.js';
import { Team, EntityType, ShipGroup, Entity } from './entities.js';
import { GameState } from './gamestate.js';
import { BuildingBase, CommandPost, Shipyard } from './building.js';
import { TurretBase } from './turret.js';
import { BomberShip, FighterShip, SwarmShip, SynonymousFighterShip, SynonymousNovaBomberShip, FIGHTER_UPGRADE_RESEARCH_KEYS, applyFighterResearchUpgrade } from './fighter.js';
import { Bullet, BomberMissile, ExciterBeam, GatlingTurretBullet, Laser, MassDriverBullet, Missile, ProjectileBase, SwarmFighterLaser, SynonymousDroneLaser, SynonymousNovaBomb } from './projectile.js';
import { HUD } from './hud.js';
import { Colors } from './colors.js';
import { Audio } from './audio.js';
import { BASELINE_RESOURCE_GAIN, RESOURCE_GAIN_RATE, WORLD_WIDTH, WORLD_HEIGHT, WEAPON_STATS } from './constants.js';
import { footprintCenter, worldToCell } from './grid.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import { damageLaserLine, damageLaserLineLimited } from './combatUtils.js';
import { EnemyBasePlanner } from './enemybaseplanner.js';
import type { PlayerStrategy } from './enemybaseplanner.js';
import {
  PracticeConfig,
  cloneDefaultPracticeConfig,
  difficultyIndex,
  isZenithDifficulty,
} from './practiceconfig.js';
import { rankedDifficultyName, clampRank } from './vsaiconfig.js';
import { BuilderDrone, isBuilderDrone } from './builderdrone.js';
import { isSynonymousFaction } from './confluence.js';
import { aimAngle, aimAtEntity, isCombatTargetValid, recordCombatAimSample } from './targeting.js';
import { isLegacyGraphics } from './graphicsmode.js';

const TURRET_FIRE_CHECK_INTERVAL = 0.1;
const MAX_AUDIBLE_GATLING_TURRETS = 2;
const AI_MAIN_SHIP_ORDER_RADIUS = 1000;
/** Spawn-group rotation order: enemy fighters cycle Red→Green→Blue. */
const SPAWN_GROUPS = [ShipGroup.Red, ShipGroup.Green, ShipGroup.Blue] as const;
/** Pixel variance added to the flank target so repeated attacks vary slightly. */
const FLANK_POSITION_VARIANCE = 60;
const SURVIVAL_BASE_INTERVAL_SECONDS = 60;
const SURVIVAL_BASE_RANK_ESCALATION = 100;
const SURVIVAL_CHEATER_RANK = 3000;
const SURVIVAL_POST_CAP_STARTING_RESOURCES_STEP = 250;
const SURVIVAL_POST_CAP_INCOME_STEP = 0.1;
const SURVIVAL_POST_CAP_BUILD_SPEED_STEP = 0.08;
const SURVIVAL_POST_CAP_BUILDER_STEP_INTERVAL = 2;
const SURVIVAL_BASE_LOD_CHECK_INTERVAL = 0.5;
const DORMANT_ENEMY_TURRET_RANGE_SQ = 5600 * 5600;

/** Interval (seconds) between player-threat evaluations. */
const THREAT_EVAL_INTERVAL = 10;
/**
 * If no major attack has launched within this many seconds, escalate urgency.
 * Tiered: [Easy, Normal, Hard, Expert, Nightmare] — lower difficulties are more
 * forgiving (and don't use wave-staging at all below Hard anyway).
 */
const STAGNATION_THRESHOLDS = [9999, 9999, 150, 100, 75, 35];
/**
 * If the AI is above the first stagnation threshold, upgrade urgency to level 2
 * (critical stall) after this many additional seconds.
 */
const CRITICAL_STALL_EXTRA = 60;

/**
 * Window (seconds) after a wave launches within which we still check whether
 * all attackers died — used to determine if the wave was repelled quickly.
 */
const WAVE_COMPLETION_WINDOW = 90;
/**
 * If all attacking fighters die within this many seconds of the wave launching,
 * the wave is considered a quick failure (repelled without doing meaningful damage).
 */
const QUICK_FAILURE_THRESHOLD = 45;

export interface PracticeScore {
  basesDestroyed: number;
  timeSurvived: number;
}

interface EnemyBaseRuntime {
  cp: CommandPost;
  planner: EnemyBasePlanner;
  config: PracticeConfig;
  incomeMul: number;
  resources: number;
  lodTimer: number;
  lodAccum: number;
  lodCheckTimer: number;
  lodCadence: number;
}

interface PracticeTickCache {
  token: number;
  poweredEnemyFactories: number;
  poweredEnemyShipyards: number;
  playerShipyards: number;
  playerTurrets: number;
  playerMassDrivers: BuildingBase[];
  turrets: TurretBase[];
  poweredEnemyShipyardsList: Shipyard[];
  stagedEnemyFighters: FighterShip[];
  attackingEnemyFighters: number;
}

export class PracticeMode {
  private turretCheckTimer: number = 0;
  private planner: EnemyBasePlanner | null = null;
  private primaryBase: EnemyBaseRuntime | null = null;
  private extraBases: EnemyBaseRuntime[] = [];
  private countedDestroyedBaseIds: Set<number> = new Set();
  private survivalSpawnTimer: number = SURVIVAL_BASE_INTERVAL_SECONDS;
  private config: PracticeConfig = cloneDefaultPracticeConfig();
  /**
   * If true, this mode will *also* drive an enemy main ship and a more
   * aggressive raid cadence. PracticeMode itself stays focused on a
   * growing base; the Vs. AI mode wraps PracticeMode and sets this flag
   * via {@link setVsAIMode}.
   */
  vsAIMode: boolean = false;
  survivalMode: boolean = false;
  /** Income multipliers, applied to the resource baseline. */
  private playerIncomeMul: number = 1.0;
  private enemyIncomeMul: number = 1.0;
  /** Internal enemy resource pool — not currently spent (planner is free) but
   *  surfaced to the HUD and used to gate future expensive actions. */
  enemyResources: number = 0;
  /** Accumulator so the AI raid timer doesn't depend on dt at low FPS. */
  private raidTimer: number = 30;
  private enemyWaveTimer: number = 0;
  /**
   * Counter that cycles 0→1→2 as fighters spawn, assigning them to
   * ShipGroup.Red → Green → Blue in sequence for group-based tactics.
   */
  private _spawnGroupCounter: number = 0;
  lastPlannerUpdateMs = 0;
  lastPlannerMaxMs = 0;
  activeEnemyBaseCount = 0;

  // -- Player threat profile --------------------------------------------------

  /** Current classification of what the player appears to be doing. */
  private playerStrategy: PlayerStrategy = 'unknown';
  /** Timer for periodic threat evaluation. */
  private threatEvalTimer: number = 0;
  /** Seconds since the last wave was launched (for stagnation detection). */
  private secsSinceLastWave: number = 0;
  /** How many consecutive waves have failed without dealing meaningful damage. */
  private consecutiveFailedWaves: number = 0;
  /** Current strategic urgency level sent to the planner. 0/1/2. */
  private urgencyLevel: number = 0;
  private readonly nearbyCombatScratch: Entity[] = [];
  private readonly enemyFighterTargetScratch: Entity[] = [];
  private readonly tickCache: PracticeTickCache = {
    token: -1,
    poweredEnemyFactories: 0,
    poweredEnemyShipyards: 0,
    playerShipyards: 0,
    playerTurrets: 0,
    playerMassDrivers: [],
    turrets: [],
    poweredEnemyShipyardsList: [],
    stagedEnemyFighters: [],
    attackingEnemyFighters: 0,
  };

  score: PracticeScore = { basesDestroyed: 0, timeSurvived: 0 };
  gameOver: boolean = false;
  victory: boolean = false;

  /** Apply the practice configuration before {@link init}. */
  configure(cfg: PracticeConfig): void {
    this.config = cfg;
    this.playerIncomeMul = cfg.playerIncomeMul;
    this.enemyIncomeMul = cfg.enemyIncomeMul;
    this.enemyResources = cfg.enemyStartingResources;
    // Difficulty raises raid cadence floor.
    const idx = difficultyIndex(cfg.difficulty);
    this.raidTimer = [60, 45, 30, 22, 16, 9][idx];
    this.enemyWaveTimer = [0, 0, 34, 28, 22, 12][idx];
  }

  /**
   * Initialize practice: place a single enemy Command Post and let the
   * builder-drone planner grow the base from there. No prebuilt
   * shipyards or turrets — the player should see the base assemble.
   */
  init(state: GameState, hud: HUD): void {
    this.score = { basesDestroyed: 0, timeSurvived: 0 };
    this.gameOver = false;
    this.victory = false;
    this.primaryBase = null;
    this.extraBases = [];
    this.countedDestroyedBaseIds.clear();
    this.survivalSpawnTimer = SURVIVAL_BASE_INTERVAL_SECONDS;
    state.survivalKillRewardsEnabled = this.survivalMode;
    state.survivalEnemyRewardBank = 0;

    state.resources = this.config.playerStartingResources;

    // Position the enemy CP at the configured distance from the player.
    const playerPos = state.player.position;
    const angle = randomRange(0, Math.PI * 2);
    const dist = this.config.startingDistance;
    const rawBasePos = new Vec2(
      Math.max(300, Math.min(WORLD_WIDTH - 300, playerPos.x + Math.cos(angle) * dist)),
      Math.max(300, Math.min(WORLD_HEIGHT - 300, playerPos.y + Math.sin(angle) * dist)),
    );
    const baseCell = worldToCell(rawBasePos);
    const basePos = footprintCenter(baseCell.cx, baseCell.cy, footprintForBuildingType(EntityType.CommandPost));
    const base = this.createEnemyBase(state, basePos);
    this.primaryBase = base;
    this.planner = base.planner;

    hud.showMessage('Enemy base is constructing — destroy it before it grows!',
      Colors.alert1, 5);
    Audio.playSound('enemyhere');
  }

  update(state: GameState, hud: HUD, dt: number): void {
    if (this.gameOver) return;

    this.lastPlannerUpdateMs = 0;
    this.lastPlannerMaxMs = 0;
    this.activeEnemyBaseCount = 0;
    this.score.timeSurvived = state.gameTime;

    // Defeat check
    if (this.checkDefeat(state)) {
      this.gameOver = true;
      this.victory = false;
      hud.showMessage('Defeat! Your Command Post has fallen.', Colors.alert1, 8);
      hud.showMessage(
        `Time survived: ${Math.floor(this.score.timeSurvived)}s`,
        Colors.general_building, 10,
      );
      return;
    }

    // Victory check. Survival is an endurance mode, so clearing the current
    // bases buys breathing room instead of ending the run.
    if (!this.survivalMode && this.checkVictory(state)) {
      this.gameOver = true;
      this.victory = true;
      hud.showMessage('Victory! Enemy Command Post destroyed.',
        Colors.friendly_status, 10);
      this.score.basesDestroyed++;
      return;
    }
    if (this.survivalMode) this.updateSurvivalDestroyedBaseCount();

    // Income — apply multipliers (player baseline accumulation lives in
    // GameState; we simulate the multiplier by sprinkling extra resources).
    if (this.playerIncomeMul !== 1.0 && state.player.alive) {
      const extra = (this.playerIncomeMul - 1.0) * 2.0 * dt;
      if (extra > 0) state.resources += extra;
      else if (extra < 0) state.resources = Math.max(0, state.resources + extra);
    }

    if (this.survivalMode) {
      this.survivalSpawnTimer -= dt;
      if (this.survivalSpawnTimer <= 0) {
        this.survivalSpawnTimer += SURVIVAL_BASE_INTERVAL_SECONDS;
        this.spawnSurvivalBase(state, hud);
      }
    }

    const tickCache = this.refreshTickCache(state);
    const poweredFactories = tickCache.poweredEnemyFactories;
    const difficultyIncomeMul = [0.55, 0.8, 1.0, 1.2, 1.45, 1.85][difficultyIndex(this.config.difficulty)];
    this.enemyResources += this.enemyIncomeMul *
      (BASELINE_RESOURCE_GAIN * difficultyIncomeMul + poweredFactories * RESOURCE_GAIN_RATE) *
      dt;
    if (state.survivalEnemyRewardBank > 0) {
      this.enemyResources += state.survivalEnemyRewardBank;
      state.survivalEnemyRewardBank = 0;
    }

    // Drive the planner — only when there's still a CP.
    const cp = this.primaryBase?.cp.alive ? this.primaryBase.cp : null;
    if (cp && this.planner && this.primaryBase) {
      this.activeEnemyBaseCount++;
      this.primaryBase.lodAccum += dt;
      this.primaryBase.lodTimer -= dt;
      const cadence = this.cachedSurvivalPlannerCadence(state, this.primaryBase, dt);
      if (this.primaryBase.lodTimer <= 0) {
        const plannerDt = Math.max(dt, this.primaryBase.lodAccum);
        this.primaryBase.lodAccum = 0;
        this.primaryBase.lodTimer = cadence;
        const startedAt = performance.now();
        const spent = this.planner.update(state, cp, plannerDt, this.enemyResources);
        const elapsed = performance.now() - startedAt;
        this.lastPlannerUpdateMs += elapsed;
        this.lastPlannerMaxMs = Math.max(this.lastPlannerMaxMs, elapsed);
        this.enemyResources = Math.max(0, this.enemyResources - spent);
        // Drain planner chat narration and forward to HUD.
        for (const msg of this.planner.drainChats()) {
          hud.showAIChat('BASE', msg, Colors.alert1);
        }
      }
    }

    for (const base of this.extraBases) {
      if (!base.cp.alive) continue;
      this.activeEnemyBaseCount++;
      const baseDifficultyIncomeMul = [0.55, 0.8, 1.0, 1.2, 1.45, 1.85][difficultyIndex(base.config.difficulty)];
      base.resources += base.incomeMul *
        (BASELINE_RESOURCE_GAIN * baseDifficultyIncomeMul + poweredFactories * RESOURCE_GAIN_RATE) *
        dt;
      base.lodAccum += dt;
      base.lodTimer -= dt;
      const cadence = this.cachedSurvivalPlannerCadence(state, base, dt);
      if (base.lodTimer > 0) continue;
      const plannerDt = Math.max(dt, base.lodAccum);
      base.lodAccum = 0;
      base.lodTimer = cadence;
      const startedAt = performance.now();
      const spent = base.planner.update(state, base.cp, plannerDt, base.resources);
      const elapsed = performance.now() - startedAt;
      this.lastPlannerUpdateMs += elapsed;
      this.lastPlannerMaxMs = Math.max(this.lastPlannerMaxMs, elapsed);
      base.resources = Math.max(0, base.resources - spent);
      for (const msg of base.planner.drainChats()) {
        hud.showAIChat('BASE', msg, Colors.alert1);
      }
    }
    this.tickCache.token = -1;

    // Periodic player threat evaluation.
    this.threatEvalTimer -= dt;
    if (this.threatEvalTimer <= 0) {
      this.threatEvalTimer = THREAT_EVAL_INTERVAL;
      this.evaluatePlayerThreat(state);
    }

    // Tick stagnation timer and update urgency.
    this.secsSinceLastWave += dt;
    this.updateStrategicUrgency(state);

    // Turrets
    this.turretCheckTimer -= dt;
    if (this.turretCheckTimer <= 0) {
      this.turretCheckTimer = TURRET_FIRE_CHECK_INTERVAL;
      this.updateTurrets(state);
    }
    this.fireTurrets(state);

    // Ships only spawn from POWERED, finished shipyards. The CP no longer
    // produces fighters directly.
    this.updateEnemyShipyards(state);
    this.tickCache.token = -1;

    // Combat AI for already-launched fighters.
    this.updateEnemyFighters(state, dt);
  }

  private checkVictory(state: GameState): boolean {
    const enemyCPs = state.buildings.filter(
      (b) => b.alive && b.type === EntityType.CommandPost && b.team === Team.Enemy,
    );
    return enemyCPs.length === 0;
  }

  private checkDefeat(state: GameState): boolean {
    switch (this.config.defeatCondition) {
      case 'disabled': return false;
      case 'cp_destroyed':
        return state.getPlayerCommandPost() === null;
      case 'ship_and_no_cp':
        return !state.player.alive && state.getPlayerCommandPost() === null;
    }
  }

  private createEnemyBase(state: GameState, basePos: Vec2, config: PracticeConfig = this.config): EnemyBaseRuntime {
    const cp = new CommandPost(basePos, Team.Enemy);
    if (isSynonymousFaction(state.factionByTeam, Team.Enemy)) cp.synonymousVisualKind = 'base';
    state.addEntity(cp);
    state.ensureConfluenceSeedCircle(Team.Enemy, basePos);
    state.ensureSynonymousSeedSwarm(Team.Enemy, basePos);

    const planner = new EnemyBasePlanner(Team.Enemy, config, Math.floor(Math.random() * 0xffffff));
    planner.init(state, cp);
    return {
      cp,
      planner,
      config,
      incomeMul: config.enemyIncomeMul,
      resources: config.enemyStartingResources,
      lodTimer: 0,
      lodAccum: 0,
      lodCheckTimer: 0,
      lodCadence: 0,
    };
  }

  private cachedSurvivalPlannerCadence(state: GameState, base: EnemyBaseRuntime, dt: number): number {
    if (!this.survivalMode) return 0;
    base.lodCheckTimer -= dt;
    if (base.lodCheckTimer <= 0) {
      base.lodCheckTimer = SURVIVAL_BASE_LOD_CHECK_INTERVAL;
      base.lodCadence = this.survivalPlannerCadence(state, base);
    }
    return base.lodCadence;
  }

  private survivalPlannerCadence(state: GameState, base: EnemyBaseRuntime): number {
    if (!this.survivalMode) return 0;
    if (base.cp.health < base.cp.maxHealth) return 0;
    const playerDist = state.player.position.distanceTo(base.cp.position);
    if (playerDist <= 2800) return 0;
    if (this.baseHasNearbyCombat(state, base.cp.position, 1200)) return 0;
    if (playerDist <= 5200) return 0.5;
    return 2.0;
  }

  private baseHasNearbyCombat(state: GameState, pos: Vec2, radius: number): boolean {
    const nearby = state.queryEntitiesInRange(pos, radius, this.nearbyCombatScratch);
    for (const entity of nearby) {
      if (entity instanceof FighterShip) {
        if (entity.alive && !entity.docked) return true;
      } else if (entity instanceof ProjectileBase && entity.alive) {
        return true;
      }
    }
    return false;
  }

  private updateSurvivalDestroyedBaseCount(): void {
    const bases = [
      ...(this.primaryBase ? [this.primaryBase] : []),
      ...this.extraBases,
    ];
    for (const base of bases) {
      if (base.cp.alive || this.countedDestroyedBaseIds.has(base.cp.id)) continue;
      this.countedDestroyedBaseIds.add(base.cp.id);
      this.score.basesDestroyed++;
    }
  }

  private spawnSurvivalBase(state: GameState, hud: HUD): void {
    const playerPos = state.player.position;
    const existing = state.buildings.filter((b) => b.alive && b.type === EntityType.CommandPost);
    let bestPos: Vec2 | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 24; i++) {
      const angle = randomRange(0, Math.PI * 2);
      const dist = randomRange(2200, 4200);
      const raw = new Vec2(
        Math.max(300, Math.min(WORLD_WIDTH - 300, playerPos.x + Math.cos(angle) * dist)),
        Math.max(300, Math.min(WORLD_HEIGHT - 300, playerPos.y + Math.sin(angle) * dist)),
      );
      const cell = worldToCell(raw);
      const pos = footprintCenter(cell.cx, cell.cy, footprintForBuildingType(EntityType.CommandPost));
      const nearest = existing.reduce((min, b) => Math.min(min, b.position.distanceTo(pos)), Infinity);
      const score = nearest + playerPos.distanceTo(pos) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
    if (!bestPos) return;
    const nextBaseNumber = this.extraBases.length + 1;
    const rawRank = this.config.survivalAiRank + nextBaseNumber * SURVIVAL_BASE_RANK_ESCALATION;
    const rank = clampRank(rawRank);
    const postCapTier = Math.max(0, Math.ceil((rawRank - SURVIVAL_CHEATER_RANK) / SURVIVAL_BASE_RANK_ESCALATION));
    const cheaterBase = postCapTier > 0;
    const config = {
      ...this.config,
      difficulty: rankedDifficultyName(rank),
      survivalAiRank: rank,
      enemyIncomeMul: cheaterBase
        ? Math.max(this.config.enemyIncomeMul, 1.25 + postCapTier * SURVIVAL_POST_CAP_INCOME_STEP)
        : this.config.enemyIncomeMul,
      enemyStartingResources: cheaterBase
        ? this.config.enemyStartingResources + postCapTier * SURVIVAL_POST_CAP_STARTING_RESOURCES_STEP
        : this.config.enemyStartingResources,
      enemyBuildSpeedMul: cheaterBase
        ? this.config.enemyBuildSpeedMul + postCapTier * SURVIVAL_POST_CAP_BUILD_SPEED_STEP
        : this.config.enemyBuildSpeedMul,
      enemyMaxBuilders: cheaterBase
        ? this.config.enemyMaxBuilders + Math.floor((postCapTier - 1) / SURVIVAL_POST_CAP_BUILDER_STEP_INTERVAL) + 1
        : this.config.enemyMaxBuilders,
    };
    this.extraBases.push(this.createEnemyBase(state, bestPos, config));
    const modifierText = cheaterBase
      ? ` cheater tier ${postCapTier}, ${config.enemyStartingResources} resources`
      : '';
    hud.showMessage(`Survival escalation: rank ${rank}${modifierText} enemy base is constructing!`, Colors.alert1, 6);
    Audio.playSound('enemyhere');
  }

  private refreshTickCache(state: GameState): PracticeTickCache {
    const token = Math.floor(state.gameTime * 60);
    if (this.tickCache.token === token) return this.tickCache;

    this.tickCache.token = token;
    this.tickCache.poweredEnemyFactories = 0;
    this.tickCache.poweredEnemyShipyards = 0;
    this.tickCache.playerShipyards = 0;
    this.tickCache.playerTurrets = 0;
    this.tickCache.attackingEnemyFighters = 0;
    this.tickCache.playerMassDrivers.length = 0;
    this.tickCache.turrets.length = 0;
    this.tickCache.poweredEnemyShipyardsList.length = 0;
    this.tickCache.stagedEnemyFighters.length = 0;

    for (const b of state.buildings) {
      if (!b.alive) continue;
      if (b.team === Team.Enemy) {
        if (b instanceof TurretBase && b.buildProgress >= 1 && b.powered) this.tickCache.turrets.push(b);
        if (b.powered && b.buildProgress >= 1) {
          if (b.type === EntityType.Factory) this.tickCache.poweredEnemyFactories++;
          else if (b instanceof Shipyard) {
            this.tickCache.poweredEnemyShipyards++;
            this.tickCache.poweredEnemyShipyardsList.push(b);
          }
        }
      } else if (b.team === Team.Player) {
        if (b instanceof Shipyard) this.tickCache.playerShipyards++;
        if (b instanceof TurretBase) {
          if (b.buildProgress >= 1 && b.powered) this.tickCache.turrets.push(b);
          this.tickCache.playerTurrets++;
          if (b.type === EntityType.MassDriverTurret) this.tickCache.playerMassDrivers.push(b);
        }
      }
    }

    for (const f of state.fighters) {
      if (!f.alive || f.docked || f.team !== Team.Enemy || isBuilderDrone(f)) continue;
      if (f.order === 'attack') {
        this.tickCache.attackingEnemyFighters++;
      } else if (f.order === 'waypoint' || f.order === 'follow' || f.order === 'protect') {
        this.tickCache.stagedEnemyFighters.push(f);
      }
    }

    return this.tickCache;
  }

  // --------------------------------------------------------------------
  // Turrets — unchanged from the previous Practice impl.
  // --------------------------------------------------------------------

  private updateTurrets(state: GameState): void {
    const phase = Math.floor(state.gameTime / TURRET_FIRE_CHECK_INTERVAL);
    for (const b of this.refreshTickCache(state).turrets) {
      if (!b.alive) continue;
      if (this.shouldSkipDormantEnemyTurretAcquire(state, b)) continue;
      if (!b.targetEntity || ((b.id + phase) % 2) === 0) {
        state.acquireTurretTarget(b);
      }
    }
  }

  private shouldSkipDormantEnemyTurretAcquire(state: GameState, turret: TurretBase): boolean {
    if (!this.survivalMode || turret.team !== Team.Enemy) return false;
    if (turret.targetEntity && isCombatTargetValid(turret, turret.targetEntity, turret.range)) return false;
    const dx = turret.position.x - state.player.position.x;
    const dy = turret.position.y - state.player.position.y;
    return dx * dx + dy * dy > DORMANT_ENEMY_TURRET_RANGE_SQ;
  }

  private fireTurrets(state: GameState): void {
    for (const b of this.refreshTickCache(state).turrets) {
      if (!b.alive) continue;
      if (!b.canFire()) continue;

      const target = b.targetEntity;
      if (!target) continue;
      const aim = b.computeAim(target);
      const angle = aimAngle(aim);
      if (b.type !== EntityType.RegenTurret && b.type !== EntityType.ExciterTurret && angle === null) continue;
      if (angle !== null) b.turretAngle = angle;
      if (b.type === EntityType.RegenTurret) {
        b.consumeShot();
        target.repair(10);
        state.particles.emitHealing(target.position);
        const beamTarget = target.position;
        b.showBeam(beamTarget);
        Audio.playSoundAt('regenbullet', b.position);
      } else if (b.type === EntityType.MissileTurret) {
        b.consumeShot();
        if (isSynonymousFaction(state.factionByTeam, b.team)) {
          const beam = new Laser(b.team, b.position.clone(), target.position.clone(), b);
          beam.damage = 1;
          beam.lifetime = 0.055;
          state.addEntity(beam);
          Audio.playSoundAt('laser', b.position);
        } else {
          state.addEntity(new Missile(b.team, b.position.clone(), angle ?? b.turretAngle, b, target));
          Audio.playSoundAt('missile', b.position);
        }
      } else if (b.type === EntityType.GatlingTurret) {
        b.consumeShot();
        const spread = (Math.random() - 0.5) * WEAPON_STATS.gatlingturret.spread;
        const fireAngle = (angle ?? b.turretAngle) + spread;
        if (isLegacyGraphics()) {
          state.addEntity(new GatlingTurretBullet(b.team, b.position.clone(), fireAngle, b));
        } else {
          state.gatlingField.spawn(b.team, b.position.x, b.position.y, fireAngle, b);
        }
        Audio.playLimitedSoundAt('shortbullet', b.position, MAX_AUDIBLE_GATLING_TURRETS);
      } else if (b.type === EntityType.ExciterTurret) {
        const fireAngle = b.position.angleTo(target.position);
        b.turretAngle = fireAngle;
        const end = b.position.add(new Vec2(Math.cos(fireAngle), Math.sin(fireAngle)).scale(WEAPON_STATS.exciterbeam.range));
        b.consumeShot();
        state.addEntity(new ExciterBeam(b.team, b.position.clone(), end, b));
        damageLaserLine(state, null, b, b.position, end, WEAPON_STATS.exciterbeam.damage, 4);
        Audio.playSoundAt('exciterbeam', b.position);
      } else if (b.type === EntityType.MassDriverTurret) {
        b.consumeShot();
        state.addEntity(new MassDriverBullet(b.team, b.position.clone(), angle ?? b.turretAngle, b));
        Audio.playSoundAt('massdriverbullet', b.position);
      } else {
        b.consumeShot();
        state.addEntity(new Bullet(b.team, b.position.clone(), angle ?? b.turretAngle, b));
        Audio.playSoundAt('fire', b.position);
      }
      recordCombatAimSample({
        shooterId: b.id,
        targetId: target.id,
        shooter: b.position.clone(),
        target: target.position.clone(),
        targetVelocity: target.velocity.clone(),
        aimPoint: aim.aimPoint.clone(),
        spawn: b.position.clone(),
        range: b.range,
        interceptValid: aim.valid && !aim.usedFallback,
        createdAt: state.gameTime,
      });
    }
  }

  // --------------------------------------------------------------------
  // Enemy ship production — gated on `powered` and finished construction.
  // --------------------------------------------------------------------

  private updateEnemyShipyards(state: GameState): void {
    for (const b of this.refreshTickCache(state).poweredEnemyShipyardsList) {
      if (!b.alive || !b.powered) continue;
      if (this.shouldSkipDormantEnemyShipyard(state, b)) continue;

      if (b.shouldSpawnShip()) {
        // Cycle through Red/Green/Blue groups so fighters are naturally distributed
        // across all three groups for later group-based tactical orders.
        const groupIndex = this._spawnGroupCounter++ % SPAWN_GROUPS.length;
        const spawnGroup = SPAWN_GROUPS[groupIndex];
        const synonymous = isSynonymousFaction(state.factionByTeam, Team.Enemy);
        const zenith = isZenithDifficulty(this.config.difficulty);
        const fighter = synonymous && b.type === EntityType.BomberYard
          ? new SynonymousNovaBomberShip(b.bayPosition(), Team.Enemy, spawnGroup, b)
          : synonymous
            ? new SynonymousFighterShip(b.bayPosition(), Team.Enemy, spawnGroup, b, zenith || state.researchedItems.has('fighterHp1'))
            : b.type === EntityType.BomberYard
              ? new BomberShip(b.bayPosition(), Team.Enemy, spawnGroup, b)
              : b.type === EntityType.SwarmYard
                ? new SwarmShip(b.bayPosition(), Team.Enemy, spawnGroup, b)
                : new FighterShip(b.position.clone(), Team.Enemy, spawnGroup, b);
        if (zenith && !(fighter instanceof SynonymousNovaBomberShip)) {
          fighter.upgradeToAdvanced();
          fighter.enableShield();
        } else if (fighter.team === Team.Player) {
          for (const key of FIGHTER_UPGRADE_RESEARCH_KEYS) {
            if (state.researchedItems.has(key)) applyFighterResearchUpgrade(fighter, key);
          }
        }
        fighter.launch();
        b.activeShips++;
        state.addEntity(fighter);

        if (this.shouldStageEnemyWaves()) {
          fighter.order = 'waypoint';
          fighter.targetPos = this.enemyRallyPoint(state, b.position, b.activeShips);
        } else {
          const target = this.findNearestPlayerBuilding(state, b.position);
          if (target) {
            fighter.order = 'attack';
            fighter.targetPos = target.position.clone();
          }
        }
      }
    }
  }

  private shouldSkipDormantEnemyShipyard(state: GameState, yard: Shipyard): boolean {
    if (!this.survivalMode || yard.team !== Team.Enemy) return false;
    const dx = yard.position.x - state.player.position.x;
    const dy = yard.position.y - state.player.position.y;
    return dx * dx + dy * dy > DORMANT_ENEMY_TURRET_RANGE_SQ;
  }

  private updateEnemyFighters(state: GameState, dt: number): void {
    this.updateEnemyAttackWaves(state, dt);
    // Determine the best strategic target based on the planner's doctrine.
    let doctrineTarget: { position: Vec2 } | null = null;
    if (this.planner) {
      const harassPos = this.planner.getSuggestedHarassTarget(state);
      if (harassPos) doctrineTarget = { position: harassPos };
    }

    const idx = difficultyIndex(this.config.difficulty);
    // Group-based tactics activate on Hard+ (idx >= 2).
    const useGroupTactics = idx >= 2;

    // Pre-compute group-specific targets once per tick for efficiency.
    // Blue group: chase the player hero ship.
    const playerHeroPos = (useGroupTactics && state.player.alive)
      ? state.player.position.clone() : null;

    // Green group: scout/flank around the player's base from a perpendicular angle.
    // Compute a flanking offset from the enemy CP toward the main target.
    let greenFlankTarget: Vec2 | null = null;
    if (useGroupTactics) {
      const mainBuilding = this.findNearestPlayerBuilding(state, state.player.position);
      if (mainBuilding) {
        const cpPos = state.getEnemyCommandPost()?.position;
        if (cpPos) {
          const toTarget = mainBuilding.position.clone().sub(cpPos);
          const len = toTarget.length();
          if (len > 10) {
            const perpX = -toTarget.y / len;
            const perpY = toTarget.x / len;
            const flankDist = 170 + (mainBuilding.position.x % FLANK_POSITION_VARIANCE);
            greenFlankTarget = new Vec2(
              mainBuilding.position.x + perpX * flankDist,
              mainBuilding.position.y + perpY * flankDist,
            );
          }
        } else {
          greenFlankTarget = mainBuilding.position.clone();
        }
      }
    }

    for (const f of state.fighters) {
      if (!f.alive || f.docked || f.team !== Team.Enemy) continue;
      // Skip builder drones — they are utility units, not combatants.
      if (isBuilderDrone(f)) continue;

      if (this.shouldStageEnemyWaves() && (f.order === 'waypoint' || f.order === 'follow' || f.order === 'protect')) {
        continue;
      }

      // Blue group continuously refreshes its target to track the player hero.
      if (useGroupTactics && f.group === ShipGroup.Blue && playerHeroPos && f.order === 'attack') {
        f.targetPos = playerHeroPos.clone();
      }

      if (f.order === 'idle' || !f.targetPos) {
        if (useGroupTactics) {
          if (f.group === ShipGroup.Blue && playerHeroPos) {
            // Blue group: chase the player's hero ship relentlessly.
            f.order = 'attack';
            f.targetPos = playerHeroPos.clone();
          } else if (f.group === ShipGroup.Green && greenFlankTarget) {
            // Green group: flank the player's base from the side.
            f.order = 'attack';
            f.targetPos = greenFlankTarget.clone();
          } else {
            // Red group (and fallback): doctrine-based or direct attack.
            const target = doctrineTarget ?? this.findNearestPlayerBuilding(state, f.position);
            if (target) {
              f.order = 'attack';
              f.targetPos = target.position.clone();
            }
          }
        } else {
          // Original behaviour for Easy/Normal.
          const target = doctrineTarget ?? this.findNearestPlayerBuilding(state, f.position);
          if (target) {
            f.order = 'attack';
            f.targetPos = target.position.clone();
          }
        }
      }

      if (f.canFire()) {
        const nearby = state.queryEntitiesInRange(f.position, f.weaponRange, this.enemyFighterTargetScratch);
        for (const e of nearby) {
          if (isCombatTargetValid(f, e, f.weaponRange)) {
            const isBomber = f instanceof BomberShip;
            const isSwarm = f instanceof SwarmShip;
            if (isSwarm) {
              const end = e.position.clone();
              f.consumeShot(f.fireRate);
              state.addEntity(new SwarmFighterLaser(f.team, f.position.clone(), end, f));
              damageLaserLineLimited(state, null, f.position.clone(), end, f.weaponDamage, 1, 1, f);
              recordCombatAimSample({
                shooterId: f.id,
                targetId: e.id,
                shooter: f.position.clone(),
                target: e.position.clone(),
                targetVelocity: e.velocity.clone(),
                aimPoint: end,
                spawn: f.position.clone(),
                range: f.weaponRange,
                interceptValid: true,
                createdAt: state.gameTime,
              });
              break;
            }
            const projectileSpeed = isBomber ? WEAPON_STATS.bigmissile.speed : isSwarm ? WEAPON_STATS.laser.speed : WEAPON_STATS.fire.speed;
            const aim = aimAtEntity(f, e, projectileSpeed, {
              maxPredictionTime: isBomber ? 0.7 : 1.0,
              fallback: isSwarm ? 'current' : 'shortPrediction',
            });
            const fireAngle = aimAngle(aim);
            if (fireAngle === null) continue;
            let firedAimPoint = aim.aimPoint.clone();
            if (f instanceof SynonymousNovaBomberShip) {
              const charged = f.consumeChargedNova();
              if (charged) {
                state.addEntity(new SynonymousNovaBomb(f.team, f.position.clone(), fireAngle, charged.aoeRadius, charged.damage, charged.travel, f));
              } else {
                f.beginNovaCharge(aim.aimPoint);
              }
            } else if (f instanceof BomberShip) {
              f.consumeShot(WEAPON_STATS.bigmissile.fireRate);
              state.addEntity(new BomberMissile(f.team, f.position.clone(), fireAngle, f));
            } else if (f instanceof SynonymousFighterShip) {
              f.markCombatSplit();
              f.consumeShot(f.fireRate);
              for (let i = 0; i < f.droneCount; i++) {
                const start = f.firingOrigin(i);
                const laserAim = aimAtEntity(f, e, WEAPON_STATS.laser.speed, { fallback: 'current' });
                const end = laserAim.aimPoint.clone();
                const laser = new SynonymousDroneLaser(f.team, start, end, f);
                state.addEntity(laser);
                damageLaserLineLimited(state, null, start, end, f.weaponDamage, 3, 2, f);
              }
            } else {
              f.consumeShot(WEAPON_STATS.fire.fireRate);
              const bullet = new Bullet(f.team, f.position.clone(), fireAngle, f, e);
              bullet.damage = f.weaponDamage;
              state.addEntity(bullet);
            }
            recordCombatAimSample({
              shooterId: f.id,
              targetId: e.id,
              shooter: f.position.clone(),
              target: e.position.clone(),
              targetVelocity: e.velocity.clone(),
              aimPoint: firedAimPoint,
              spawn: f.position.clone(),
              range: f.weaponRange,
              interceptValid: aim.valid && !aim.usedFallback,
              createdAt: state.gameTime,
            });
            break;
          }
        }
      }
    }
  }

  private shouldStageEnemyWaves(): boolean {
    return difficultyIndex(this.config.difficulty) >= 2;
  }

  private enemyRallyPoint(state: GameState, fallback: Vec2, salt: number): Vec2 {
    const cp = state.getEnemyCommandPost();
    const mainShip = state.aiPlayerShip?.alive ? state.aiPlayerShip.position : null;
    const center = mainShip ?? cp?.position ?? fallback;
    const angle = salt * 2.399963 + state.gameTime * 0.05;
    const radius = Math.min(AI_MAIN_SHIP_ORDER_RADIUS * 0.35, 120 + (salt % 5) * 18);
    return new Vec2(
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
    );
  }

  private updateEnemyAttackWaves(state: GameState, dt: number): void {
    if (!this.shouldStageEnemyWaves()) return;
    this.enemyWaveTimer -= dt;
    const staged = this.refreshTickCache(state).stagedEnemyFighters;
    const idx = difficultyIndex(this.config.difficulty);
    const threshold = this.enemyWaveLaunchThreshold(state, idx);

    // Launch if: enough fighters staged OR the wave timer expired (max wait).
    const readyToLaunch = staged.length >= threshold || this.enemyWaveTimer <= 0;
    if (!readyToLaunch) return;
    if (staged.length === 0) {
      // Nothing to send but timer expired — reset timer and wait for production.
      const baseInterval = [0, 0, 34, 28, 22, 12][idx];
      this.enemyWaveTimer = Math.max(8, baseInterval * 0.5);
      return;
    }

    const target = isZenithDifficulty(this.config.difficulty)
      ? this.findZenithAssaultTarget(state) ?? { position: state.player.position }
      : this.findNearestPlayerBuilding(state, state.player.position) ?? { position: state.player.position };

    // On Expert+ (idx >= 3), split the wave into groups that attack from
    // different angles, making it harder for the player to defend a single side.
    if (idx >= 3) {
      const cpPos = state.getEnemyCommandPost()?.position;
      const toTarget = cpPos
        ? target.position.clone().sub(cpPos)
        : new Vec2(1, 0);
      const len = toTarget.length();
      const perpX = len > 10 ? -toTarget.y / len : 0;
      const perpY = len > 10 ? toTarget.x / len : 1;
      const flankDist = 160;

      for (const f of staged) {
        f.order = 'attack';
        if (f.group === ShipGroup.Blue && state.player.alive) {
          // Blue group goes directly for the player hero ship.
          f.targetPos = state.player.position.clone();
        } else if (f.group === ShipGroup.Green) {
          // Green group flanks from the left (perpendicular to the approach).
          f.targetPos = new Vec2(
            target.position.x + perpX * flankDist,
            target.position.y + perpY * flankDist,
          );
        } else {
          // Red group attacks the primary target head-on.
          f.targetPos = target.position.clone();
        }
      }
    } else {
      for (const f of staged) {
        f.order = 'attack';
        f.targetPos = target.position.clone();
      }
    }
    this.tickCache.token = -1;

    // Track the launch and reset stagnation timer.
    this.secsSinceLastWave = 0;
    this.planner?.notifyAttackLaunched();

    // Reset wave cooldown. After a failed wave, shorten the wait proportionally
    // (minimum = 40% of base interval) so we don't idle too long after a failed
    // attack. After success, use the full interval.
    const baseInterval = [0, 0, 34, 28, 22, 12][idx];
    const failedPenalty = Math.max(0, this.consecutiveFailedWaves - 1) * 4;
    this.enemyWaveTimer = Math.max(Math.round(baseInterval * 0.4), baseInterval - failedPenalty);
  }

  /**
   * Dynamic wave launch threshold.
   *
   * The threshold scales with:
   *   • Difficulty (higher = larger desired waves).
   *   • Game time (midgame/lategame → larger waves).
   *   • AI shipyard count (more yards = can field bigger waves).
   *   • Consecutive failed waves (increase desired size after failures).
   *   • Player defence strength (more turrets = need bigger wave).
   *
   * The wave timer acts as a hard ceiling — after maxWaitSecs the AI
   * launches whatever it has so it never stalls indefinitely.
   */
  private enemyWaveLaunchThreshold(state: GameState, idx: number): number {
    // Base threshold per difficulty.
    let base = [0, 0, 5, 8, 10, 18][idx];

    // Scale with game time: +1 per 2 minutes past 2 minutes, capped.
    const gameTimeMins = state.gameTime / 60;
    const timeBonus = idx >= 2 ? Math.min(8, Math.floor(Math.max(0, gameTimeMins - 2) / 2)) : 0;

    // Scale with AI shipyard count: more yards → larger desired wave.
    const aiShipyardCount = this.refreshTickCache(state).poweredEnemyShipyards;
    const yardBonus = Math.max(0, aiShipyardCount - 1); // 0 for 1 yard, +1 per extra yard

    // Scale with consecutive failures: failed waves push us to want bigger groups.
    const failureBonus = Math.min(6, this.consecutiveFailedWaves * 2);

    // Player turrets count as defensive pressure.
    const playerTurretCount = this.refreshTickCache(state).playerTurrets;
    const defenseBonus = Math.min(idx >= 5 ? 8 : 4, Math.floor(playerTurretCount / 3));

    const threshold = base + timeBonus + yardBonus + failureBonus + defenseBonus;

    // Hard cap: never demand more fighters than we can realistically produce.
    const maxFeasible = Math.max(base + 2, aiShipyardCount * 4);
    return Math.min(threshold, maxFeasible);
  }

  // ---------------------------------------------------------------------------
  // Player threat profiling
  // ---------------------------------------------------------------------------

  /**
   * Periodically classify what the player is doing.
   * Feeds into reactive turret selection in the planner.
   */
  private evaluatePlayerThreat(state: GameState): void {
    const tickCache = this.refreshTickCache(state);
    const playerShipyards = tickCache.playerShipyards;
    const playerTurrets = tickCache.playerTurrets;
    const playerResearch = state.researchedItems.size;

    // Classify strategy.
    let strategy: PlayerStrategy = 'unknown';
    if (playerShipyards >= 4) {
      strategy = 'swarming';
    } else if (playerResearch >= 3 && playerShipyards <= 2) {
      strategy = 'teching';
    } else if (playerTurrets >= 6 && playerShipyards <= 1) {
      strategy = 'turtling';
    } else if (playerShipyards >= 2 && playerTurrets <= 2) {
      strategy = 'rushing';
    }

    this.playerStrategy = strategy;

    // Push profile to planner.
    this.planner?.notifyPlayerThreat(strategy, playerShipyards, playerTurrets, playerResearch);
  }

  // ---------------------------------------------------------------------------
  // Strategic urgency + anti-stall
  // ---------------------------------------------------------------------------

  /**
   * Called every tick. Evaluates stagnation and escalates urgency when the AI
   * hasn't launched a meaningful attack for too long, ensuring it can't sit
   * passively for 10+ minutes.
   */
  private updateStrategicUrgency(state: GameState): void {
    if (!this.planner) return;
    const idx = difficultyIndex(this.config.difficulty);
    if (idx < 2) return; // Easy / Normal don't use urgency

    const stagnationThreshold = STAGNATION_THRESHOLDS[idx];
    const criticalThreshold   = stagnationThreshold + CRITICAL_STALL_EXTRA;

    let newUrgency = 0;
    if (this.secsSinceLastWave >= criticalThreshold) {
      newUrgency = 2; // Critical stall — override almost everything
    } else if (this.secsSinceLastWave >= stagnationThreshold) {
      newUrgency = 1; // Elevated — boost shipyard priority
    }
    // Also elevate if the AI has repeatedly failed waves.
    if (this.consecutiveFailedWaves >= 3) newUrgency = Math.max(newUrgency, 1);
    if (this.consecutiveFailedWaves >= 5) newUrgency = Math.max(newUrgency, 2);

    if (newUrgency !== this.urgencyLevel) {
      this.urgencyLevel = newUrgency;
      this.planner.setStrategicUrgency(newUrgency);
    }

    // If urgency is high and the wave timer is long, shorten it so we launch sooner.
    if (newUrgency >= 2 && this.enemyWaveTimer > 15) {
      this.enemyWaveTimer = 15;
    } else if (newUrgency >= 1 && this.enemyWaveTimer > 25) {
      this.enemyWaveTimer = 25;
    }

    // Detect failed waves: a wave that launched but died quickly without doing
    // damage.  We approximate "failed" as: attack fighters exist and were sent
    // > 8 s ago, but there are now none left alive in attacking state.
    // (Lightweight — no per-frame scan; done here every dt as a state transition.)
    this.updateFailedWaveDetection(state);
  }

  /**
   * Detect when attack waves fail (all sent fighters die quickly without
   * scoring damage).  Uses a simple heuristic: if we recently launched a wave
   * (secsSinceLastWave < 60) but there are no living attacking enemy fighters,
   * it's likely the wave was repelled.  Reset counter when a new wave launches
   * successfully.
   *
   * This runs every game tick but is O(fighters) which is cheap.
   */
  private _prevLivingAttackers: number = 0;
  private _waveJustLaunched: boolean = false;

  private updateFailedWaveDetection(state: GameState): void {
    const tickCache = this.refreshTickCache(state);
    const attackers = tickCache.attackingEnemyFighters;

    // Rising edge: wave just launched.
    if (!this._waveJustLaunched && attackers > 0 && this._prevLivingAttackers === 0) {
      this._waveJustLaunched = true;
    }
    // Falling edge: wave ended (all attackers gone within the recent-launch window).
    if (this._waveJustLaunched && attackers === 0 && this.secsSinceLastWave < WAVE_COMPLETION_WINDOW) {
      // If the entire wave died quickly with no staged units left to replace them,
      // treat this as a failed (repelled) wave.
      const stagedLeft = tickCache.stagedEnemyFighters.length;
      if (stagedLeft === 0 && this.secsSinceLastWave < QUICK_FAILURE_THRESHOLD) {
        this.consecutiveFailedWaves++;
      } else {
        // Wave lasted a reasonable amount of time or there are already more staged
        // fighters — consider it a success and reset the failure counter fully.
        this.consecutiveFailedWaves = 0;
      }
      this._waveJustLaunched = false;
    }

    this._prevLivingAttackers = attackers;
  }

  private damageSynonymousFighterLaser(state: GameState, start: Vec2, end: Vec2, source: FighterShip): void {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 0) return;
    const hits: Array<{ target: Entity; t: number; hitPoint: Vec2 }> = [];
    for (const target of state.allEntities()) {
      if (!target.alive || target.team === source.team || target.team === Team.Neutral) continue;
      const tx = target.position.x - start.x;
      const ty = target.position.y - start.y;
      const t = Math.max(0, Math.min(1, (tx * dx + ty * dy) / lenSq));
      const px = start.x + dx * t;
      const py = start.y + dy * t;
      if (Math.hypot(target.position.x - px, target.position.y - py) <= target.radius + 3) hits.push({ target, t, hitPoint: new Vec2(px, py) });
    }
    hits.sort((a, b) => a.t - b.t);
    for (let i = 0; i < Math.min(2, hits.length); i++) {
      const target = hits[i].target;
      target.takeDamage(1, source);
      state.recentlyDamaged.add(target.id);
      if (target instanceof BuildingBase && target.alive) {
        let inward = target.position.sub(hits[i].hitPoint);
        if (inward.length() <= 0.001) inward = new Vec2(1, 0);
        inward = inward.normalize();
        state.particles.emitBuildingDamageSparks(
          target.position.sub(inward.scale(target.radius)),
          Math.atan2(-inward.y, -inward.x),
        );
      }
    }
  }

  private findNearestPlayerBuilding(
    state: GameState, pos: Vec2,
  ): { position: Vec2 } | null {
    let best: { position: Vec2 } | null = null;
    let bestDist = Infinity;
    for (const b of state.buildings) {
      if (!b.alive || b.team !== Team.Player) continue;
      const d = b.position.distanceTo(pos);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    if (state.player.alive) {
      const d = state.player.position.distanceTo(pos);
      if (d < bestDist) best = state.player;
    }
    return best;
  }

  private findZenithAssaultTarget(state: GameState): { position: Vec2 } | null {
    let best: { position: Vec2; score: number } | null = null;
    for (const b of state.buildings) {
      if (!b.alive || b.team !== Team.Player) continue;
      let priority = 1;
      if (b instanceof TurretBase) {
        priority = b.type === EntityType.MassDriverTurret ? 8 : 10;
      } else if (b instanceof Shipyard) {
        priority = 9;
      } else if (b.type === EntityType.ResearchLab) {
        priority = 8;
      } else if (b.type === EntityType.Factory || b.type === EntityType.PowerGenerator) {
        priority = 6;
      } else if (b.type === EntityType.CommandPost) {
        priority = 4;
      }
      const massDriverPenalty = this.nearPlayerMassDriver(state, b.position) ? 220 : 0;
      const distance = state.player.position.distanceTo(b.position);
      const score = priority * 100 - distance * 0.02 - massDriverPenalty;
      if (!best || score > best.score) best = { position: b.position.clone(), score };
    }
    return best ? { position: best.position } : null;
  }

  private nearPlayerMassDriver(state: GameState, pos: Vec2): boolean {
    for (const b of this.refreshTickCache(state).playerMassDrivers) {
      if (b.position.distanceTo(pos) <= 360) return true;
    }
    return false;
  }

  /** Optional: planner snapshot for debug overlays. */
  getPlannerSnapshot() {
    return this.planner?.snapshot() ?? null;
  }

  /**
   * Returns strategy debug info for the AI debug overlay.
   * Includes: urgency, player strategy, wave state, staged count.
   */
  getStrategyDebugInfo(state: GameState): {
    urgency: number;
    playerStrategy: PlayerStrategy;
    secsSinceLastWave: number;
    consecutiveFailedWaves: number;
    stagedCount: number;
    waveLaunchThreshold: number;
    currentShipyards: number;
    targetShipyards: number;
    aiBuildingCounts: Record<string, number>;
    aiQueuedBuildingCounts: Record<string, number>;
  } | null {
    if (!this.planner) return null;
    const idx = difficultyIndex(this.config.difficulty);
    const snapshot = this.planner.snapshot();
    const staged = this.refreshTickCache(state).stagedEnemyFighters.length;
    return {
      urgency:               this.urgencyLevel,
      playerStrategy:        this.playerStrategy,
      secsSinceLastWave:     this.secsSinceLastWave,
      consecutiveFailedWaves: this.consecutiveFailedWaves,
      stagedCount:           staged,
      waveLaunchThreshold:   this.enemyWaveLaunchThreshold(state, idx),
      currentShipyards:      this.planner.getShipyardCount(state),
      targetShipyards:       this.planner.getTargetShipyardCount(state),
      aiBuildingCounts:      snapshot.buildingCounts,
      aiQueuedBuildingCounts: snapshot.queuedBuildingCounts,
    };
  }

  /** Returns the base planner for coordinator-interface access by VsAIDirector. */
  getPlanner(): EnemyBasePlanner | null {
    return this.planner;
  }
}
