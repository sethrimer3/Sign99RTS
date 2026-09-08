/**
 * Vs. AI bot-player main ship + strategic controller.
 *
 * Architecture:
 *   • {@link AIShip} extends PlayerShip so it inherits the same physics,
 *     battery, and rendering. It exposes `desiredMove` (unit-vector intent)
 *     and `desiredAim` (world point) which the director sets.
 *   • {@link VsAIDirector} runs at a difficulty-scaled cadence and decides
 *     what the ship should do this beat: patrol, harass an exposed
 *     conduit, attack the nearest player asset, or retreat to its CP.
 *
 * Vision model (cheap, deterministic):
 *   • If `cheatFullMapKnowledge` is set, the AI sees everything.
 *   • Otherwise, only player entities within `visionRadius` of any
 *     friendly unit, building, or the AI ship are considered "known".
 *     We also remember last-seen positions for a short window so the AI
 *     can return to a target after losing sight of it.
 *
 * APM ticker:
 *   • Each high-level action (issue order, change target, fire special)
 *     consumes one of N action-budget tokens that refill at the
 *     configured APM rate. This is what prevents Nightmare from being
 *     instant-perfect.
 */

import { Vec2, randomRange, wrapAngle } from './math.js';
import { Camera } from './camera.js';
import { PlayerShip } from './ship.js';
import { Team, Entity } from './entities.js';
import { Colors, Color, colorToCSS } from './colors.js';
import { Bullet } from './projectile.js';
import { CrossLaserMine } from './mine.js';
import { Audio } from './audio.js';
import { GameState } from './gamestate.js';
import { CommandPost, Shipyard, PowerGenerator } from './building.js';
import { TurretBase } from './turret.js';
import { VsAIConfig, effectiveApm, effectiveDifficultyScalar } from './vsaiconfig.js';
import type { EnemyBasePlanner } from './enemybaseplanner.js';
import { aimAngle, aimAtEntity, recordCombatAimSample } from './targeting.js';
import {
  MINE_BATTERY_COST,
  MINE_COOLDOWN_SECS,
  MINE_INITIAL_SPEED_MAX,
  MINE_INITIAL_SPEED_MIN,
  WEAPON_STATS,
} from './constants.js';
import { teamColor, isHostile } from './teamutils.js';
import { buildingBlocksShips, buildingShipCollisionRect } from './buildingCollision.js';
import { GRID_CELL_SIZE } from './grid.js';

const VISION_RADIUS = 900;
const RETREAT_HEALTH_FRACTION = 0.35;
/** Health fraction at which the AI rallies back to aggression after retreating. */
const RALLY_HEALTH_FRACTION = 0.65;
const PRIMARY_FIRE_COOLDOWN = 0.18;
const RETREAT_NAV_REFRESH_SECONDS = 0.35;
const RETREAT_NAV_REFRESH_DISTANCE = 100;
const AI_MINE_DEPLOY_OFFSET = 34;

/** AI chat badge and color for the rival ship in Vs AI mode. */
export const AI_CHAT_PREFIX = 'RIVAL';
export const AI_CHAT_COLOR: Color = Colors.alert1;

/**
 * AI-controlled main ship. Lives in the same container as `state.player`
 * by being added to a parallel slot on GameState (see
 * `state.aiPlayerShip`). It is *not* added to fighter list.
 */
export class AIShip extends PlayerShip {
  /** Unit vector the director wants the ship to thrust along. (0,0) = idle. */
  desiredMove: Vec2 = new Vec2(0, 0);
  /** World point to aim at. */
  desiredAim: Vec2 = new Vec2(0, 0);
  /** When true, the ship attempts to fire its primary each tick. */
  wantsFire: boolean = false;

  constructor(position: Vec2, team: Team = Team.Enemy) {
    super(position, team);
    this.health = this.maxHealth;
  }

  /** Replace the keyboard-driven input loop with director-driven intent. */
  protected override handleInput(dt: number): void {
    // Movement
    const m = this.desiredMove;
    const len = m.length();
    if (len > 0.01) {
      const ux = m.x / len;
      const uy = m.y / len;
      this.velocity = this.velocity.add(
        new Vec2(ux * this.thrustPower * dt, uy * this.thrustPower * dt),
      );
      this.thrustDir = new Vec2(ux, uy);
      this.isThrusting = true;
    } else {
      this.isThrusting = false;
    }

    // Aim
    const desired = Math.atan2(
      this.desiredAim.y - this.position.y,
      this.desiredAim.x - this.position.x,
    );
    let delta = wrapAngle(desired - this.angle);
    const maxStep = this.turnRate * dt;
    if (delta > maxStep) delta = maxStep;
    else if (delta < -maxStep) delta = -maxStep;
    this.angle = wrapAngle(this.angle + delta);
  }

  /** Distinct silhouette / colour treatment for the rival main ship. */
  override draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    super.draw(ctx, camera);
    if (!this.alive) return;
    // Add a "rival ring" — a dashed outer halo so the AI ship reads as
    // a unique entity rather than just another enemy fighter.
    const screen = camera.worldToScreen(this.position);
    const r = this.radius * camera.zoom;
    const color = teamColor(this.team);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(this.angle);
    ctx.strokeStyle = colorToCSS(color, 0.75);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r * 0.10, -r * 0.38);
    ctx.lineTo(-r * 1.30, -r * 1.14);
    ctx.lineTo(-r * 0.78, -r * 0.20);
    ctx.moveTo(-r * 0.10, r * 0.38);
    ctx.lineTo(-r * 1.30, r * 1.14);
    ctx.lineTo(-r * 0.78, r * 0.20);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = colorToCSS(color, 0.45);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Vs. AI director
// ---------------------------------------------------------------------------

type Goal = 'patrol' | 'harass' | 'attack' | 'retreat' | 'defend' | 'chase' | 'build' | 'scout';

interface KnownTarget {
  entity: Entity;
  lastSeenPos: Vec2;
  lastSeenTime: number;
}

// Varied phrases for each goal — cycled to avoid repetition.
const GOAL_PHRASES: Record<Goal, string[]> = {
  patrol:  [
    'Patrolling the perimeter.',
    'Scouting the sector.',
    'Holding position.',
    'Sweeping the zone.',
  ],
  harass:  [
    "Targeting your power grid!",
    "Going after your shipyard!",
    "Disrupting your supply lines.",
    "Cutting your infrastructure!",
  ],
  attack:  [
    'Moving to attack!',
    'Engaging your position!',
    'Pressing the offensive!',
    'You cannot hide from me.',
  ],
  retreat: [
    'Hull integrity critical — falling back!',
    'Retreating to repair!',
    'Taking cover — not done yet.',
    'Tactical withdrawal in progress.',
  ],
  defend:  [
    'Intercepting threat near base!',
    'Defending command post!',
    'You will not breach our perimeter.',
    'Scrambling to defend!',
  ],
  chase:   [
    "You can't run forever!",
    'Finishing the fight!',
    'Pursuing — your ship is almost gone!',
    "I see you're damaged. Surrender.",
  ],
  build:   [
    'Moving to construction range.',
    'Advancing to place structures.',
    'Expanding the base perimeter.',
    'Positioning for construction.',
  ],
  scout:   [
    'Moving to observe your position.',
    'Checking your defenses.',
    'Scouting the perimeter.',
    'Advancing to gather intelligence.',
  ],
};

export class VsAIDirector {
  readonly config: VsAIConfig;
  readonly ship: AIShip;
  /** Action budget for APM-based throttling. */
  private actionTokens: number = 0;
  /** When the director last replanned. */
  private replanTimer: number = 0;
  /** Current high-level goal. */
  goal: Goal = 'patrol';
  /** Previous goal — used to detect goal changes for chat narration. */
  private prevGoal: Goal = 'patrol';
  /** Cached current target world position. */
  goalTarget: Vec2 | null = null;
  /** Last-seen player entities. Pruned by age. */
  private memory: Map<number, KnownTarget> = new Map();
  /** Reaction-delay timer so low-difficulty AIs are sluggish. */
  private reactionTimer: number = 0;
  /** Cycling index used to vary chat phrases within a goal. */
  private chatPhraseIndex: number = 0;
  /** Minimum time between chat messages (prevents spam). */
  private chatCooldown: number = 0;
  /**
   * Pending AI chat messages for the caller to drain each tick.
   * Each entry is a string the game should display to the player.
   */
  private pendingChats: string[] = [];
  /**
   * Strafe direction toggle timer.  Flips sign every 2 s so the AI
   * doesn't circle-strafe in a predictable fixed direction.
   */
  private strafeDirTimer: number = 0;
  /** Current strafe direction sign (+1 or -1). */
  private strafeDirSign: number = 1;
  private retreatRallyPoint: Vec2 | null = null;
  private retreatTargetAdjusted = false;
  private retreatNavCache: {
    target: Vec2;
    from: Vec2;
    navTarget: Vec2;
    nextUpdateAt: number;
  } | null = null;
  /**
   * Cooldown (seconds) before the director will pick a 'scout' goal again.
   * Initialized to a positive value so scouting doesn't happen at game-start.
   */
  private scoutCooldown: number = 30;
  private zenithShieldInitialized = false;
  /**
   * Optional reference to the base planner for coordination.
   * When set, the director can escort construction sites, defend damaged
   * rings, and harass the player's most valuable asset.
   */
  planner: EnemyBasePlanner | null = null;

  constructor(ship: AIShip, config: VsAIConfig) {
    this.ship = ship;
    this.config = config;
  }

  /**
   * Drain and return any pending AI chat messages accumulated since the
   * last call. The caller (game.ts) forwards these to hud.showAIChat().
   */
  drainChats(): string[] {
    if (this.pendingChats.length === 0) return [];
    const msgs = this.pendingChats.slice();
    this.pendingChats = [];
    return msgs;
  }

  // -------------------------------------------------------------------
  // Per-tick update
  // -------------------------------------------------------------------

  update(state: GameState, dt: number): void {
    if (!this.ship.alive) return;
    if (!this.zenithShieldInitialized && this.config.difficulty === 'Zenith') {
      this.ship.applyResearchUpgrade('shipShield2');
      this.zenithShieldInitialized = true;
    }

    // Refill APM tokens (cap at 1 second worth so they don't accumulate forever).
    const apm = effectiveApm(this.config);
    const tokensPerSec = apm / 60.0;
    this.actionTokens = Math.min(tokensPerSec, this.actionTokens + tokensPerSec * dt);

    // Decay chat cooldown.
    if (this.chatCooldown > 0) this.chatCooldown = Math.max(0, this.chatCooldown - dt);

    // Decay scout cooldown.
    if (this.scoutCooldown > 0) this.scoutCooldown = Math.max(0, this.scoutCooldown - dt);

    // Update vision memory.
    this.refreshVision(state);

    // Periodically rethink the high-level goal. The interval shrinks with difficulty.
    this.replanTimer -= dt;
    if (this.replanTimer <= 0) {
      this.replanTimer = this.replanInterval();
      if (this.spendToken()) {
        this.replan(state);
      }
    }

    // Rally check: if we were retreating and health has recovered, go back on the offensive.
    if (this.goal === 'retreat' && this.ship.healthFraction >= RALLY_HEALTH_FRACTION) {
      this.goal = 'attack';
      this.goalTarget = this.findAttackTarget(state)?.lastSeenPos.clone() ?? null;
      this.retreatRallyPoint = null;
      this.retreatNavCache = null;
      this.emitChat('attack');
    }

    // Tick the reaction-delay then resolve micro behavior.
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);
    this.driveShip(state, dt);
  }

  private replanInterval(): number {
    return interpolateDifficulty([4.0, 2.5, 1.6, 1.0, 0.18, 0.08], this.config);
  }

  private spendToken(): boolean {
    if (this.actionTokens >= 1) {
      this.actionTokens -= 1;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Chat narration
  // -------------------------------------------------------------------

  private emitChat(goal: Goal): void {
    // Only chat when the goal has meaningfully changed and the cooldown expired.
    if (this.chatCooldown > 0) return;
    const phrases = GOAL_PHRASES[goal];
    const text = phrases[this.chatPhraseIndex % phrases.length];
    this.chatPhraseIndex++;
    this.pendingChats.push(text);
    // Longer cooldown on Easy (less chatty rival) to match its sluggish personality.
    this.chatCooldown = interpolateDifficulty([12, 8, 5, 4, 1.5, 0.8], this.config);
  }

  // -------------------------------------------------------------------
  // Vision
  // -------------------------------------------------------------------

  private refreshVision(state: GameState): void {
    const fullKnowledge = this.config.cheatFullMapKnowledge;
    // Drop stale memories (older than 30s) regardless.
    const STALE_AFTER = 30;
    for (const [id, info] of this.memory) {
      if (state.gameTime - info.lastSeenTime > STALE_AFTER) {
        this.memory.delete(id);
      }
    }
    const hostile = (team: Team): boolean => isHostile(this.ship.team, team);

    if (fullKnowledge) {
      // Remember every hostile entity instantly.
      for (const ship of state.playerShips.values()) {
        if (ship.alive && hostile(ship.team)) this.observe(ship, state.gameTime);
      }
      for (const b of state.buildings) {
        if (b.alive && hostile(b.team)) this.observe(b, state.gameTime);
      }
      for (const f of state.fighters) {
        if (f.alive && hostile(f.team)) this.observe(f, state.gameTime);
      }
      return;
    }
    // Limited vision: union of vision discs around AI ship + each friendly unit/building.
    const observers: Vec2[] = [this.ship.position];
    for (const b of state.buildings) {
      if (b.alive && b.team === this.ship.team) observers.push(b.position);
    }
    for (const f of state.fighters) {
      if (f.alive && f.team === this.ship.team) observers.push(f.position);
    }

    const visible = (p: Vec2): boolean => {
      for (const o of observers) {
        if (o.distanceTo(p) <= VISION_RADIUS) return true;
      }
      return false;
    };

    for (const ship of state.playerShips.values()) {
      if (ship.alive && hostile(ship.team) && visible(ship.position)) {
        this.observe(ship, state.gameTime);
      }
    }
    for (const b of state.buildings) {
      if (!b.alive || !hostile(b.team)) continue;
      if (visible(b.position)) this.observe(b, state.gameTime);
    }
    for (const f of state.fighters) {
      if (!f.alive || !hostile(f.team)) continue;
      if (visible(f.position)) this.observe(f, state.gameTime);
    }
  }

  private observe(e: Entity, time: number): void {
    this.memory.set(e.id, {
      entity: e,
      lastSeenPos: e.position.clone(),
      lastSeenTime: time,
    });
  }

  // -------------------------------------------------------------------
  // Strategic replan
  // -------------------------------------------------------------------

  private replan(state: GameState): void {
    this.prevGoal = this.goal;

    // Retreat first if low health.
    if (this.ship.healthFraction < RETREAT_HEALTH_FRACTION) {
      this.setGoal('retreat', state);
      const cp = this.findOwnCP(state);
      this.goalTarget = cp ? this.findRetreatRallyPoint(state, cp, this.ship) : null;
      this.reactionTimer = this.reactionDelay();
      return;
    }

    // Chase when a known hostile ship is very low HP — pursue before it can escape.
    const woundedHostile = this.findWoundedHostileShip(state);
    if (woundedHostile) {
      this.setGoal('chase', state);
      this.goalTarget = woundedHostile.position.clone();
      this.reactionTimer = this.reactionDelay() * 0.5; // faster reaction for chase
      return;
    }

    const cp = this.findOwnCP(state);
    const idx = Math.floor(effectiveDifficultyScalar(this.config));

    // 1. Defensive override — planner signals a high-priority defense point.
    //    Only on Hard+ (idx >= 2): easier difficulties use simpler reactive defense
    //    to keep the AI feeling sluggish and beatable.
    if (this.planner && idx >= 2) {
      const defPoint = this.planner.getHighestPriorityDefensePoint(state);
      if (defPoint) {
        this.setGoal('defend', state);
        this.goalTarget = defPoint;
        this.reactionTimer = this.reactionDelay();
        return;
      }
    }

    // 2. Generic CP defense — nearest player entity threatening our CP.
    if (cp) {
      const closestThreat = this.findClosestPlayerEntityNear(cp.position, 600);
      if (closestThreat) {
        this.setGoal('defend', state);
        this.goalTarget = closestThreat.position.clone();
        this.reactionTimer = this.reactionDelay();
        return;
      }
    }

    // 3. Harass / attack logic takes priority over construction errands so
    // the rival ship stays active once it has found player assets.
    const harassTarget = this.findHarassTarget(state);
    const attackTarget = this.findAttackTarget(state);
    const preferHarass = idx >= 2 && harassTarget;

    if (preferHarass) {
      this.setGoal('harass', state);
      this.goalTarget = harassTarget!.lastSeenPos.clone();
      this.reactionTimer = this.reactionDelay();
      return;
    }

    if (attackTarget) {
      this.setGoal('attack', state);
      this.goalTarget = attackTarget.lastSeenPos.clone();
      this.reactionTimer = this.reactionDelay();
      return;
    }

    // 4. Build/escort construction sites only while there is no known target.
    if (this.planner && idx >= 1) {
      const pendingSite = this.planner.getNearestPendingConstructionSite(this.ship.position);
      if (pendingSite && pendingSite.distanceTo(this.ship.position) > 900) {
        this.setGoal('build', state);
        this.goalTarget = pendingSite;
        this.reactionTimer = this.reactionDelay();
        return;
      }
    }

    // 5. Escort active construction sites (Hard+).
    if (this.planner && idx >= 2) {
      const sites = this.planner.getActiveConstructionSites();
      if (sites.length > 0) {
        // Pick the outermost construction site (furthest from CP) to escort.
        const cpPos = cp ? cp.position : this.ship.position;
        let farthest = sites[0];
        let farthestDist = farthest.distanceTo(cpPos);
        for (const s of sites) {
          const d = s.distanceTo(cpPos);
          if (d > farthestDist) { farthestDist = d; farthest = s; }
        }
        // Escort outermost construction site only during active raids — this
        // way the AI ship protects vulnerable builders when fighters are
        // away raiding, rather than always shadowing construction.
        const raidTarget = this.planner.getActiveRaidTarget();
        if (raidTarget) {
          this.setGoal('patrol', state);
          this.goalTarget = farthest;
          this.reactionTimer = this.reactionDelay();
          return;
        }
      }
    }

    // 6. Use planner's suggested harass target on higher difficulty.
    if (this.planner && idx >= 2) {
      const harassPos = this.planner.getSuggestedHarassTarget(state);
      if (harassPos) {
        this.setGoal('harass', state);
        this.goalTarget = harassPos;
        this.reactionTimer = this.reactionDelay();
        return;
      }
    }

    // 7. Scout the player's base periodically on Normal+.
    // This makes the AI hero actively probe enemy defenses rather than
    // always retreating to its own CP when idle.
    if (idx >= 1 && this.scoutCooldown <= 0) {
      const scoutTarget = this.findPlayerBaseArea(state);
      if (scoutTarget) {
        this.setGoal('scout', state);
        this.goalTarget = scoutTarget;
        this.scoutCooldown = interpolateDifficulty([0, 58, 40, 25, 14, 8], this.config);
        this.reactionTimer = this.reactionDelay();
        return;
      }
    }

    this.setGoal('patrol', state);
    const center = cp ? cp.position : this.ship.position;
    const angle = Math.random() * Math.PI * 2;
    const radius = 220;
    this.goalTarget = new Vec2(
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
    );
    this.reactionTimer = this.reactionDelay();
  }

  /**
   * Set the current goal and emit a chat message when it differs from the
   * previous one.  Identical consecutive goals are silently collapsed.
   */
  private setGoal(goal: Goal, _state: GameState): void {
    if (this.goal !== goal) {
      this.goal = goal;
      if (goal !== 'retreat') {
        this.retreatRallyPoint = null;
        this.retreatNavCache = null;
        this.retreatTargetAdjusted = false;
      }
      this.emitChat(goal);
    }
  }

  private reactionDelay(): number {
    return interpolateDifficulty([0.6, 0.35, 0.18, 0.08, 0.0, 0.0], this.config);
  }

  private findOwnCP(state: GameState): CommandPost | null {
    for (const b of state.buildings) {
      if (b.alive && b.team === this.ship.team && b instanceof CommandPost) {
        return b;
      }
    }
    return null;
  }

  /** Any living hostile ship (human or AI) relative to this AI's team. */
  private hostileShips(state: GameState): PlayerShip[] {
    const result: PlayerShip[] = [];
    for (const ship of state.playerShips.values()) {
      if (ship.alive && isHostile(this.ship.team, ship.team)) result.push(ship);
    }
    return result;
  }

  /** Nearest living hostile ship to a world position, or null if none. */
  private nearestHostileShip(state: GameState, pos: Vec2): PlayerShip | null {
    let best: PlayerShip | null = null;
    let bestDist = Infinity;
    for (const ship of this.hostileShips(state)) {
      const d = ship.position.distanceTo(pos);
      if (d < bestDist) { bestDist = d; best = ship; }
    }
    return best;
  }

  /** A known, visible hostile ship whose health has dropped below the finishing threshold. */
  private findWoundedHostileShip(state: GameState): PlayerShip | null {
    let best: PlayerShip | null = null;
    let bestDist = Infinity;
    for (const ship of this.hostileShips(state)) {
      if (ship.healthFraction >= 0.25 || !this.memory.has(ship.id)) continue;
      const d = ship.position.distanceTo(this.ship.position);
      if (d < bestDist) { bestDist = d; best = ship; }
    }
    return best;
  }

  /** Soft "harass" target: an exposed player generator or shipyard. */
  private findHarassTarget(state: GameState): KnownTarget | null {
    let best: KnownTarget | null = null;
    let bestScore = -Infinity;
    for (const m of this.memory.values()) {
      const e = m.entity;
      if (!e.alive || !isHostile(this.ship.team, e.team)) continue;
      let priority = 0;
      if (e instanceof PowerGenerator) priority = 5;
      else if (e instanceof Shipyard) priority = 4;
      else if (e instanceof TurretBase) priority = -2; // avoid hard targets
      else if (e instanceof CommandPost) priority = 2;
      if (priority <= 0) continue;
      const routeCost = state.scoreShipRoute(this.ship.position, m.lastSeenPos, this.ship.team, this.ship.radius, Math.floor(effectiveDifficultyScalar(this.config)));
      const score = priority * 100 - routeCost;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** Generic attack target: the nearest known player asset. */
  private findAttackTarget(state: GameState): KnownTarget | null {
    let best: KnownTarget | null = null;
    let bestDist = Infinity;
    for (const m of this.memory.values()) {
      if (!m.entity.alive || !isHostile(this.ship.team, m.entity.team)) continue;
      // Prefer damaged targets — weight distance by inverse health fraction.
      const healthBias = m.entity instanceof PlayerShip
        ? (1.0 - Math.max(0, m.entity.healthFraction)) * 200
        : 0;
      const routeCost = state.scoreShipRoute(this.ship.position, m.lastSeenPos, this.ship.team, this.ship.radius, Math.floor(effectiveDifficultyScalar(this.config)));
      const d = routeCost - healthBias;
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  private findClosestPlayerEntityNear(pos: Vec2, radius: number): Entity | null {
    let best: Entity | null = null;
    let bestDist = radius;
    for (const m of this.memory.values()) {
      if (!m.entity.alive || !isHostile(this.ship.team, m.entity.team)) continue;
      const d = m.lastSeenPos.distanceTo(pos);
      if (d < bestDist) {
        bestDist = d;
        best = m.entity;
      }
    }
    return best;
  }

  /**
   * Find a scout destination near the player's base. Returns a point somewhat
   * close to the player's last-known CP or player ship, offset by a random
   * angle so repeated scouts approach from different directions.
   */
  private findPlayerBaseArea(state: GameState): Vec2 | null {
    // Prefer a known hostile CP from memory.
    for (const m of this.memory.values()) {
      if (m.entity instanceof CommandPost && isHostile(this.ship.team, m.entity.team)) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 90 + Math.random() * 160;
        return new Vec2(
          m.lastSeenPos.x + Math.cos(angle) * dist,
          m.lastSeenPos.y + Math.sin(angle) * dist,
        );
      }
    }
    // Fall back to somewhere near the nearest known hostile ship.
    const nearestShip = this.nearestHostileShip(state, this.ship.position);
    if (nearestShip) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * 130;
      return new Vec2(
        nearestShip.position.x + Math.cos(angle) * dist,
        nearestShip.position.y + Math.sin(angle) * dist,
      );
    }
    return null;
  }

  private findRetreatRallyPoint(state: GameState, cp: CommandPost, ship: AIShip): Vec2 {
    if (this.retreatRallyPoint && !this.pointBlocksShip(state, this.retreatRallyPoint, ship.radius)) {
      return this.retreatRallyPoint.clone();
    }

    const angles = [
      ship.position.angleTo(cp.position) + Math.PI,
      0,
      Math.PI * 0.5,
      Math.PI,
      Math.PI * 1.5,
      Math.PI * 0.25,
      Math.PI * 0.75,
      Math.PI * 1.25,
      Math.PI * 1.75,
    ];
    const distances = [160, 220, 260, 120];
    let best: Vec2 | null = null;
    let bestScore = Infinity;

    for (const distance of distances) {
      for (const angle of angles) {
        const candidate = new Vec2(
          cp.position.x + Math.cos(angle) * distance,
          cp.position.y + Math.sin(angle) * distance,
        );
        if (this.pointBlocksShip(state, candidate, ship.radius)) continue;
        const directPenalty = this.lineHitsBlockingBuilding(state, ship.position, candidate, ship.radius) ? 650 : 0;
        const threatPenalty = this.localRetreatThreat(state, candidate) * 320;
        const baseDistancePenalty = Math.abs(distance - 190);
        const shipDistancePenalty = ship.position.distanceTo(candidate) * 0.08;
        const score = directPenalty + threatPenalty + baseDistancePenalty + shipDistancePenalty;
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    }

    if (!best) {
      const away = ship.position.sub(cp.position).normalize();
      const dir = away.length() > 0 ? away : new Vec2(1, 0);
      best = cp.position.add(dir.scale(220));
    }

    this.retreatTargetAdjusted = best.distanceTo(cp.position) > 1;
    this.retreatRallyPoint = best.clone();
    this.retreatNavCache = null;
    return best.clone();
  }

  private pointBlocksShip(state: GameState, point: Vec2, radius: number): boolean {
    for (const b of state.buildings) {
      if (!b.alive || b.buildProgress < 1 || !buildingBlocksShips(b)) continue;
      const rect = buildingShipCollisionRect(b, radius + 6);
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        return true;
      }
    }
    return false;
  }

  private lineHitsBlockingBuilding(state: GameState, from: Vec2, to: Vec2, radius: number): boolean {
    for (const b of state.buildings) {
      if (!b.alive || b.buildProgress < 1 || !buildingBlocksShips(b)) continue;
      const rect = buildingShipCollisionRect(b, radius + 8);
      if (from.x >= rect.left && from.x <= rect.right && from.y >= rect.top && from.y <= rect.bottom) return true;
      if (to.x >= rect.left && to.x <= rect.right && to.y >= rect.top && to.y <= rect.bottom) return true;
      const corners = [
        new Vec2(rect.left, rect.top),
        new Vec2(rect.right, rect.top),
        new Vec2(rect.right, rect.bottom),
        new Vec2(rect.left, rect.bottom),
      ];
      for (let i = 0; i < 4; i++) {
        if (this.segmentsIntersect(from, to, corners[i], corners[(i + 1) % 4])) return true;
      }
    }
    return false;
  }

  private segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
    const ccw = (p1: Vec2, p2: Vec2, p3: Vec2) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  private localRetreatThreat(state: GameState, pos: Vec2): number {
    let threat = 0;
    for (const b of state.buildings) {
      if (!b.alive || !isHostile(this.ship.team, b.team) || !(b instanceof TurretBase)) continue;
      const d = b.position.distanceTo(pos);
      if (d <= b.range * 1.15) threat += 1 - d / (b.range * 1.15);
    }
    for (const f of state.fighters) {
      if (!f.alive || f.docked || !isHostile(this.ship.team, f.team)) continue;
      const d = f.position.distanceTo(pos);
      if (d <= 280) threat += 0.35 * (1 - d / 280);
    }
    return threat;
  }

  // -------------------------------------------------------------------
  // Ship micro
  // -------------------------------------------------------------------

  private driveShip(state: GameState, dt: number): void {
    // Tick the strafe direction timer and flip sign when it expires.
    this.strafeDirTimer -= dt;
    if (this.strafeDirTimer <= 0) {
      this.strafeDirSign *= -1;
      this.strafeDirTimer = 2.0; // flip direction every 2 s
    }

    state.aiDebug = {
      goal: this.goal,
      healthFraction: this.ship.healthFraction,
      retreatTarget: this.goal === 'retreat' ? this.goalTarget?.clone() ?? null : null,
      cachedNavigationTarget: this.retreatNavCache?.navTarget.clone() ?? null,
      retreatTargetAdjusted: this.retreatTargetAdjusted,
    };

    if (this.reactionTimer > 0 || !this.goalTarget) {
      // While reaction delay is ticking, coast (no thrust, no aim change).
      this.ship.desiredMove.set(0, 0);
      this.ship.wantsFire = false;
      return;
    }

    const target = this.zenithShieldSupportTarget(state) ?? this.goalTarget;
    const intelligence = Math.floor(effectiveDifficultyScalar(this.config));
    const moveTarget = this.goal === 'retreat'
      ? this.resolveRetreatMoveTarget(state, target, intelligence)
      : state.resolveShipNavigationTarget(this.ship, target, intelligence);
    state.aiDebug = {
      goal: this.goal,
      healthFraction: this.ship.healthFraction,
      retreatTarget: this.goal === 'retreat' ? target.clone() : null,
      cachedNavigationTarget: this.retreatNavCache?.navTarget.clone() ?? null,
      retreatTargetAdjusted: this.retreatTargetAdjusted,
    };
    const toTarget = new Vec2(moveTarget.x - this.ship.position.x,
                              moveTarget.y - this.ship.position.y);
    const dist = toTarget.length();

    const liveGoalEntity = this.findLiveGoalEntity();
    const aim = liveGoalEntity
      ? aimAtEntity(this.ship, liveGoalEntity, WEAPON_STATS.fire.speed, { maxPredictionTime: 1.0, fallback: 'shortPrediction' })
      : null;
    const aimPoint = aim?.valid ? aim.aimPoint : target;
    this.ship.desiredAim = aimPoint.clone();

    // Move strategy depends on goal.
    if (this.goal === 'retreat') {
      // Move toward the goal and don't fire.
      this.setMove(toTarget);
      this.ship.wantsFire = false;
    } else if (this.goal === 'patrol' || this.goal === 'build') {
      // Mosey toward the patrol point at half thrust.
      this.setMove(toTarget, this.goal === 'build' ? 0.85 : 0.5);
      this.ship.wantsFire = false;
    } else if (this.goal === 'scout') {
      // Scout: advance toward player's base at moderate speed; fire
      // opportunistically at anything visible along the way.
      this.setMove(toTarget, 0.72);
      this.ship.wantsFire = dist <= 320;
    } else if (this.goal === 'chase') {
      // Full-speed pursuit, firing opportunistically.
      this.setMove(toTarget);
      this.ship.wantsFire = dist <= 380;
    } else {
      // attack / harass / defend: orbit at engagement range.
      const ENGAGE_R = 280;
      if (dist > ENGAGE_R + 80) {
        this.setMove(toTarget); // close in
      } else if (dist < ENGAGE_R - 80) {
        this.setMove(toTarget.scale(-1)); // back off
      } else {
        // Strafe perpendicular to maintain a moving target.  Alternate
        // direction every ~2 s so the AI doesn't circle predictably.
        const perp = new Vec2(-toTarget.y * this.strafeDirSign, toTarget.x * this.strafeDirSign);
        this.setMove(perp, 0.7);
      }
      this.ship.wantsFire = dist <= ENGAGE_R + 100;
    }

    // Resolve actual fire.
    if (this.ship.wantsFire && this.ship.canFirePrimary()) {
      const fireAngle = aim ? aimAngle(aim) : this.ship.angle;
      if (fireAngle === null) {
        this.ship.wantsFire = false;
      } else {
      this.ship.consumePrimaryFire(PRIMARY_FIRE_COOLDOWN);
      state.addEntity(new Bullet(this.ship.team, this.ship.position.clone(),
        fireAngle, this.ship, liveGoalEntity ?? this.nearestHostileShip(state, this.ship.position)));
      Audio.playSoundAt('fire', this.ship.position);
      if (liveGoalEntity && aim) {
        recordCombatAimSample({
          shooterId: this.ship.id,
          targetId: liveGoalEntity.id,
          shooter: this.ship.position.clone(),
          target: liveGoalEntity.position.clone(),
          targetVelocity: liveGoalEntity.velocity.clone(),
          aimPoint: aim.aimPoint.clone(),
          spawn: this.ship.position.clone(),
          range: 380,
          interceptValid: aim.valid && !aim.usedFallback,
          createdAt: state.gameTime,
        });
      }
      }
    }

    // Special ability — used sparingly during combat. On Hard+ the mine fires
    // without spending an APM token; the ship cooldown still limits repeats.
    const idx = Math.floor(effectiveDifficultyScalar(this.config));
    if (this.isCombatGoal() && idx >= 2 && this.ship.canFireSpecial()) {
      this.deploySingleMine(state, target);
    } else if (this.isCombatGoal() && idx < 2 && this.ship.canFireSpecial() && this.spendToken()) {
      this.deploySingleMine(state, target);
    }
  }

  private isCombatGoal(): boolean {
    // 'scout' is intentionally excluded — it's a movement goal, not a dedicated combat state.
    return this.goal === 'attack' || this.goal === 'harass' || this.goal === 'defend' || this.goal === 'chase';
  }

  private zenithShieldSupportTarget(state: GameState): Vec2 | null {
    if (this.config.difficulty !== 'Zenith' || !this.ship.shieldUnlocked || !this.isCombatGoal()) return null;
    const fighters = state.fighters.filter((f) =>
      f.alive && !f.docked && f.team === this.ship.team && f.order === 'attack' &&
      f.position.distanceTo(this.ship.position) < 900,
    );
    if (fighters.length < 4) return null;
    const center = fighters
      .reduce((sum, f) => sum.add(f.position), new Vec2(0, 0))
      .scale(1 / fighters.length);
    const ownCp = this.findOwnCP(state);
    const anchor = ownCp?.position ?? this.ship.position;
    const towardBase = anchor.sub(center);
    const dir = towardBase.length() > 1 ? towardBase.normalize() : new Vec2(1, 0);
    return center.add(dir.scale(120));
  }

  private deploySingleMine(state: GameState, aimWorld: Vec2): void {
    if (this.ship.specialFireTimer > 0 || this.ship.battery < MINE_BATTERY_COST) return;

    const angle = this.ship.position.angleTo(aimWorld);
    const spawn = new Vec2(
      this.ship.position.x + Math.cos(angle) * AI_MINE_DEPLOY_OFFSET,
      this.ship.position.y + Math.sin(angle) * AI_MINE_DEPLOY_OFFSET,
    );
    const speed = randomRange(MINE_INITIAL_SPEED_MIN, MINE_INITIAL_SPEED_MAX);
    state.addEntity(new CrossLaserMine(this.ship.team, spawn, angle, speed, this.ship, state));
    this.ship.specialFireTimer = MINE_COOLDOWN_SECS;
    this.ship.battery -= MINE_BATTERY_COST;
    Audio.playSoundAt('missile', this.ship.position);
  }

  /** Set ship's desired move vector. `scale` 0..1 reduces effective magnitude. */
  private setMove(v: Vec2, scale: number = 1.0): void {
    const len = v.length();
    if (len < 1e-3) {
      this.ship.desiredMove.set(0, 0);
      return;
    }
    this.ship.desiredMove = new Vec2((v.x / len) * scale, (v.y / len) * scale);
  }

  private resolveRetreatMoveTarget(state: GameState, target: Vec2, intelligence: number): Vec2 {
    const cached = this.retreatNavCache;
    const targetMovedSq = cached ? (target.x - cached.target.x) ** 2 + (target.y - cached.target.y) ** 2 : Infinity;
    const shipMovedSq = cached ? (this.ship.position.x - cached.from.x) ** 2 + (this.ship.position.y - cached.from.y) ** 2 : Infinity;
    const cachedBlocked = cached ? this.pointBlocksShip(state, cached.navTarget, this.ship.radius) : true;
    if (
      cached &&
      state.gameTime < cached.nextUpdateAt &&
      targetMovedSq < GRID_CELL_SIZE ** 2 &&
      shipMovedSq < RETREAT_NAV_REFRESH_DISTANCE ** 2 &&
      !cachedBlocked
    ) {
      return cached.navTarget.clone();
    }

    const navTarget = state.resolveShipNavigationTarget(this.ship, target, intelligence);
    this.retreatNavCache = {
      target: target.clone(),
      from: this.ship.position.clone(),
      navTarget: navTarget.clone(),
      nextUpdateAt: state.gameTime + RETREAT_NAV_REFRESH_SECONDS,
    };
    return navTarget;
  }

  private findLiveGoalEntity(): Entity | null {
    if (!this.goalTarget) return null;
    let best: Entity | null = null;
    let bestDist = 90;
    for (const m of this.memory.values()) {
      if (!m.entity.alive || !isHostile(this.ship.team, m.entity.team)) continue;
      const d = m.entity.position.distanceTo(this.goalTarget);
      if (d < bestDist) {
        bestDist = d;
        best = m.entity;
      }
    }
    return best;
  }
}

function interpolateDifficulty(values: number[], cfg: VsAIConfig): number {
  const scalar = effectiveDifficultyScalar(cfg);
  const lo = Math.max(0, Math.min(values.length - 1, Math.floor(scalar)));
  const hi = Math.max(0, Math.min(values.length - 1, Math.ceil(scalar)));
  const t = scalar - lo;
  return values[lo] + (values[hi] - values[lo]) * t;
}

