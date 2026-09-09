/**
 * Concentric-ring base planner for the Practice enemy — full architecture upgrade.
 *
 * The planner now operates in three distinct phases:
 *
 *   1. Plan generation (init + ring advance):
 *      Computes explicit conduit ring cells and spoke cells using geometry
 *      utilities from aibaseplan.ts. Assigns building slots within each ring
 *      according to the chosen doctrine. Plans are deterministic and seeded.
 *
 *   2. Build queue management (periodic replan):
 *      Prioritises spoke conduit → inner ring conduit → inner ring buildings →
 *      outer ring conduit → outer ring buildings. Uses AIScore to skip
 *      dangerously exposed building slots on lower difficulties.
 *
 *   3. Adaptive behavior (ongoing tracking):
 *      Records player actions (conduit cuts, builder kills, rushes) and adjusts
 *      spoke redundancy, escort behavior, and repair priority in response.
 *
 * Coordinator interface (used by VsAIDirector):
 *   getHighestPriorityDefensePoint()  — where to defend
 *   getActiveConstructionSites()      — current builder targets
 *   getWeakestRingSegment()           — most incomplete ring zone
 *   getSuggestedHarassTarget()        — best player asset to attack
 *   getCurrentDoctrine()              — active doctrine type
 *   getActiveRaidTarget()             — current raid objective position
 *
 * Performance notes:
 *   • Ring cells are computed once at init; only re-generated on ring advance.
 *   • Queue walk fires on a timer, not every tick.
 *   • AIScore uses lazy per-cell caching; only queried for building slots.
 *   • No grid-wide scans occur during normal play.
 */

import { Vec2 } from './math.js';
import { Team } from './entities.js';
import { GameState } from './gamestate.js';
import { isHostile } from './teamutils.js';
import { BuildingBase, CommandPost, Shipyard, PowerGenerator, ResearchLab, Factory } from './building.js';
import { TurretBase } from './turret.js';
import { GRID_CELL_SIZE, cellCenter, cellKey, footprintCenter } from './grid.js';
import { CONDUIT_COST, RESEARCH_COST, RESEARCH_TIME, TICK_RATE, WORLD_WIDTH, WORLD_HEIGHT } from './constants.js';
import { buildDefForEntityType, createBuildingFromDef, getBuildDef } from './builddefs.js';
import type { BuildDef } from './builddefs.js';
import { BuilderDrone, isBuilderDrone } from './builderdrone.js';
import type { BuildOrder } from './builderdrone.js';
import {
  PracticeConfig,
  difficultyIndex,
  difficultyTickMul,
  isZenithDifficulty,
} from './practiceconfig.js';
import {
  generateRingCells,
  generateRingBuildingSlots,
  generateSpokeCells,
  generateBastionLoop,
  hash01plan,
  traceLine,
  AI_RING_THICKNESS_CONDUITS,
  AI_RING_SPACING_CONDUITS,
  RingPlan,
  BastionPlan,
} from './aibaseplan.js';
import { DoctrineType, Doctrine, DOCTRINES, pickDoctrine } from './aidoctrine.js';
import { RaidPlanner } from './airaids.js';
import { AIScore, cellOf } from './aiscore.js';
import { isConfluenceFaction } from './confluence.js';
import { footprintForBuildingType } from './buildingfootprint.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlannerSnapshot {
  currentRing: number;
  buildsPlaced: number;
  builderCount: number;
  queueSize: number;
  doctrine: DoctrineType;
  ringCount: number;
  /** Fraction of all ring conduit cells queued so far [0,1]. */
  conduitProgress: number;
  // -- Strategic debug fields -------------------------------------------------
  /** Current urgency level (0=normal, 1=elevated, 2=high). */
  urgencyLevel: number;
  /** Desired shipyard count based on difficulty + game time. */
  targetShipyardCount: number;
  /** Actual alive, powered, finished shipyard count. */
  currentShipyardCount: number;
  /** Current player strategy classification. */
  playerStrategy: PlayerStrategy;
  /** Seconds since the last major attack wave was launched. */
  secsSinceLastAttack: number;
  /** Placed ring-slot structures by build key. */
  buildingCounts: Record<string, number>;
  /** Queued or actively constructing structures by build key. */
  queuedBuildingCounts: Record<string, number>;
}

/** Lightweight classification of what the player appears to be doing. */
export type PlayerStrategy = 'unknown' | 'rushing' | 'turtling' | 'teching' | 'swarming';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Maximum number of radial spokes regardless of doctrine or adaptive additions. */
const MAX_SPOKES = 8;
const AI_INNER_RING_RADIUS_CELLS = 7;
const AI_RING_STEP_CELLS = AI_RING_THICKNESS_CONDUITS + AI_RING_SPACING_CONDUITS;
/** Grid-cell radius within which a player approaching the Command Post triggers a rush alert. */
const CP_RUSH_DETECTION_CELLS = 12;
const AUTO_CONDUIT_BUILD_SECONDS = 0.45;
const AUTO_STRUCTURE_PLACEMENT_SECONDS = 1.6;

/** 4-connected cardinal neighbour offsets for grid-neighbour operations. */
const CARDINAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

// ---------------------------------------------------------------------------
// Internal: adaptive-behavior counters
// ---------------------------------------------------------------------------

interface AdaptiveStats {
  conduitCutsObserved: number;
  builderKillsObserved: number;
  commandPostRushes: number;
  lastBuilderKillTime: number;
  unpoweredSegments: Map<string, { count: number; lastTime: number; redundantLinks: number }>;
}

/** Player strategic profile used to guide reactive turret and wave decisions. */
interface PlayerThreatState {
  strategy: PlayerStrategy;
  shipyardCount: number;
  turretCount: number;
  researchCount: number;
  lastEval: number;
}

interface ActiveAutoBuild {
  order: BuildOrder;
  remaining: number;
}

// ---------------------------------------------------------------------------
// EnemyBasePlanner
// ---------------------------------------------------------------------------

export class EnemyBasePlanner {
  readonly team: Team;
  private rootCommandPost: CommandPost | null = null;
  readonly config: PracticeConfig;

  /** Command Post grid cell — center of all ring geometry. */
  private centerCx: number = 0;
  private centerCy: number = 0;
  /** Deterministic seed. Ring geometry is reproducible within a match. */
  private readonly seed: number;

  // -- Doctrine ---------------------------------------------------------------

  private doctrineType: DoctrineType;
  private doctrine: Doctrine;

  // -- Plan state -------------------------------------------------------------

  private rings: RingPlan[] = [];
  /** Spoke paths: one array of cells per spoke, ordered center → outer. */
  private spokes: Array<Array<{ cx: number; cy: number }>> = [];
  /** Per-spoke queue pointer: how many cells have been issued as orders. */
  private spokeQueuePtrs: number[] = [];
  /** Forward bastions (Raider / Adaptive only). */
  private bastions: BastionPlan[] = [];
  /** Ring currently being filled. */
  private currentRing: number = 0;
  /** Number of rings to keep planned; grows outward for as long as space/resources allow. */
  private plannedRingCount: number = 0;
  /** Total build completions since init. */
  buildsPlaced: number = 0;
  /** Additional spokes added by adaptive behavior. */
  private extraSpokes: number = 0;

  // -- Queue + claimed sets ---------------------------------------------------

  /** Pending build orders to dispatch to idle builders. */
  private queue: BuildOrder[] = [];
  /** Build orders currently being placed by the AI main ship. */
  private activeAutoBuilds: ActiveAutoBuild[] = [];
  /** Keys of conduit cells that have been queued (avoids double-queuing). */
  private claimedConduitKeys: Set<string> = new Set();
  /** Keys of building cells that have been queued (avoids double-queuing). */
  private claimedBuildingKeys: Set<string> = new Set();
  /** Cells reserved by queued or active AI build orders. */
  private reservedCells: Set<string> = new Set();
  private protectiveWallKeys: Set<string> = new Set();
  private backfillKeys: Set<string> = new Set();

  // -- Timers -----------------------------------------------------------------

  private tickTimer: number = 0;
  private auditTimer: number = 0;
  private rebuildTimers: number[] = [];
  /** Accumulates time (seconds) since the last successful ring advancement. */
  private ringAdvanceStuckTimer: number = 0;
  /** Anti-stall: how long since the last major attack was signalled. */
  private secsSinceLastAttack: number = 0;
  /** Anti-stall: seconds since we last checked / forced shipyard scaling. */
  private shipyardScaleTimer: number = 0;
  private aiResearchedItems: Set<string> = new Set();
  private aiResearchProgress: { item: string; remaining: number } | null = null;

  // -- Chat narration ---------------------------------------------------------

  /**
   * Pending AI commentary lines for the caller (practicemode.ts) to drain
   * each tick and forward to hud.showAIChat().
   */
  private pendingChats: string[] = [];
  /** Minimum gap between chat posts from the planner (prevents spam). */
  private chatCooldown: number = 0;
  /** Index cycled through per-event phrase lists to add variety. */
  private chatPhraseIndex: number = 0;

  // -- Subsystems -------------------------------------------------------------

  builders: BuilderDrone[] = [];
  private raidPlanner: RaidPlanner = new RaidPlanner();
  private aiScore: AIScore = new AIScore();

  // -- Adaptive state ---------------------------------------------------------

  private adaptive: AdaptiveStats = {
    conduitCutsObserved: 0,
    builderKillsObserved: 0,
    commandPostRushes: 0,
    lastBuilderKillTime: -9999,
    unpoweredSegments: new Map(),
  };

  // -- Strategic state --------------------------------------------------------

  /**
   * Urgency level set by PracticeMode when attacks stagnate.
   * 0 = normal, 1 = elevated (AI has failed multiple waves), 2 = high (AI is stalling).
   * Higher urgency boosts shipyard / offensive build priority.
   */
  private urgencyLevel: number = 0;

  /** Player strategic profile — updated externally by PracticeMode. */
  private playerThreat: PlayerThreatState = {
    strategy: 'unknown',
    shipyardCount: 0,
    turretCount: 0,
    researchCount: 0,
    lastEval: -999,
  };

  private usesConduits(state: GameState): boolean {
    return !isConfluenceFaction(state.factionByTeam, this.team);
  }

  /** Nearest living hostile ship (human or AI) to a world position, or null if none. */
  private nearestHostileShip(state: GameState, pos: Vec2): { position: Vec2; alive: boolean } | null {
    let best: { position: Vec2; alive: boolean } | null = null;
    let bestDist = Infinity;
    for (const ship of state.playerShips.values()) {
      if (!ship.alive || !isHostile(this.team, ship.team)) continue;
      const d = ship.position.distanceTo(pos);
      if (d < bestDist) { bestDist = d; best = ship; }
    }
    return best;
  }

  constructor(team: Team, config: PracticeConfig, seed: number = 1337) {
    this.team = team;
    this.config = config;
    this.seed = seed;
    this.doctrineType = isZenithDifficulty(config.difficulty) ? 'swarm' : pickDoctrine(seed);
    this.doctrine = DOCTRINES[this.doctrineType];
    this.plannedRingCount = this.doctrine.ringRecipes.length;
  }

  // ---------------------------------------------------------------------------
  // Chat narration
  // ---------------------------------------------------------------------------

  /**
   * Drain and return any pending commentary lines since the last call.
   * Called by PracticeMode.update(); messages are forwarded to HUD.showAIChat().
   */
  drainChats(): string[] {
    if (this.pendingChats.length === 0) return [];
    const msgs = this.pendingChats.slice();
    this.pendingChats = [];
    return msgs;
  }

  private emitPlannerChat(phrases: string[]): void {
    if (this.chatCooldown > 0) return;
    const text = phrases[this.chatPhraseIndex % phrases.length];
    this.chatPhraseIndex++;
    this.pendingChats.push(text);
    this.chatCooldown = 14; // seconds between planner messages
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  /**
   * Seed the base: plant the initial conduit cross, generate the full ring
   * plan, and spawn the first builder drone.
   */
  init(state: GameState, cp: CommandPost): void {
    this.rootCommandPost = cp;
    const c = cellOf(cp.position);
    this.centerCx = c.cx;
    this.centerCy = c.cy;

    if (this.usesConduits(state)) {
      const initCells: Array<[number, number]> = [[0,0],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of initCells) {
        const cx = this.centerCx + dx;
        const cy = this.centerCy + dy;
        state.grid.addConduit(cx, cy, this.team);
        this.claimedConduitKeys.add(cellKey(cx, cy));
      }
      state.power.markDirty();
    }

    this.generatePlan();
    this.replanQueue(state);
  }

  // ---------------------------------------------------------------------------
  // Plan generation
  // ---------------------------------------------------------------------------

  /**
   * Compute ring conduit loops, spoke paths, and building slot positions from
   * the active doctrine and seed. Safe to call again when parameters change
   * (e.g., extra spokes from adaptive behavior).
   */
  private generatePlan(): void {
    const idx  = difficultyIndex(this.config.difficulty);
    const recipes = this.doctrine.ringRecipes;
    const gapProb  = this.doctrine.gapProbPerDifficulty[idx];
    const numSpokes = Math.min(
      this.doctrine.spokesPerDifficulty[idx] + this.extraSpokes,
      MAX_SPOKES,
    );
    const ringCount = Math.max(this.plannedRingCount, recipes.length);
    const outerRadius = this.ringRadiusForIndex(Math.max(0, ringCount - 1));

    // --- Rings ---------------------------------------------------------------
    const prevRings = this.rings;
    this.rings = [];
    for (let r = 0; r < ringCount; r++) {
      const recipe = this.recipeForRing(r);
      const radiusCells = this.ringRadiusForIndex(r);
      // Use ~π × radius angular slots for a smooth ring.
      const numSlots = Math.max(16, Math.round(Math.PI * radiusCells));
      const conduitCells = generateRingCells(
        this.centerCx, this.centerCy,
        radiusCells, numSlots, gapProb,
        this.seed + r * 100,
        AI_RING_THICKNESS_CONDUITS,
      );
      const rawSlots = generateRingBuildingSlots(
        this.centerCx, this.centerCy,
        radiusCells, recipe, conduitCells,
        this.seed + r * 100 + 50,
      );
      const buildingSlots = rawSlots.map((s) => ({
        ...s,
        queued: false,
        placed: false,
        connectorCells: [] as Array<{ cx: number; cy: number }>,
        connectorQueuePtr: -1, // -1 = candidate not yet found
      }));

      // Preserve queue pointer from a previous plan if this ring already existed.
      const prev = prevRings[r];
      const conduitQueuePtr = prev ? Math.min(prev.conduitQueuePtr, conduitCells.length) : 0;

      this.rings.push({
        ringIndex: r,
        radiusCells,
        role: recipe.role,
        conduitCells,
        conduitQueuePtr,
        buildingSlots,
      });
    }

    // --- Spokes --------------------------------------------------------------
    const prevPtrs = this.spokeQueuePtrs.slice();
    this.spokes = generateSpokeCells(
      this.centerCx, this.centerCy,
      outerRadius, numSpokes, this.seed + 1000,
    );
    this.spokeQueuePtrs = this.spokes.map((_, i) => prevPtrs[i] ?? 0);

    // --- Bastions (Raider / Adaptive doctrine) --------------------------------
    if (this.doctrine.useForwardBastions && this.bastions.length === 0) {
      this.generateBastions(outerRadius);
    }
  }

  private generateBastions(outerRadius: number): void {
    const idx = difficultyIndex(this.config.difficulty);
    const count = 1 + idx; // Easy=1, Nightmare=5, Zenith=6
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.seed * 0.001 + i * 0.5;
      const dist  = outerRadius + 5;
      const anchorCx = this.centerCx + Math.round(Math.cos(angle) * dist);
      const anchorCy = this.centerCy + Math.round(Math.sin(angle) * dist);
      const loop  = generateBastionLoop(anchorCx, anchorCy, this.seed + 2000 + i);

      this.bastions.push({
        anchorCx, anchorCy,
        conduitCells: loop,
        conduitQueuePtr: 0,
        generatorSlot: { cx: anchorCx, cy: anchorCy - 2 },
        turretSlots: [
          { cx: anchorCx + 2, cy: anchorCy, queued: false, placed: false },
          { cx: anchorCx - 2, cy: anchorCy, queued: false, placed: false },
        ],
        spokeBackCells: [],
        status: 'planned',
      });
    }
  }

  private ringRadiusForIndex(index: number): number {
    return AI_INNER_RING_RADIUS_CELLS + index * AI_RING_STEP_CELLS;
  }

  private recipeForRing(index: number) {
    const recipes = this.doctrine.ringRecipes;
    if (index < recipes.length) return recipes[index];
    const outerRecipes = recipes.slice(Math.max(0, recipes.length - 2));
    return outerRecipes[(index - recipes.length) % Math.max(1, outerRecipes.length)];
  }

  // ---------------------------------------------------------------------------
  // Per-tick update
  // ---------------------------------------------------------------------------

  update(state: GameState, cp: CommandPost, dt: number, enemyResources: number): number {
    // Decay chat cooldown.
    if (this.chatCooldown > 0) this.chatCooldown = Math.max(0, this.chatCooldown - dt);

    // Tick stagnation timer.
    this.secsSinceLastAttack += dt;
    this.shipyardScaleTimer += dt;

    // 1. Builder lifecycle.
    this.processBuilderRebuilds(state, cp, dt);
    this.assignRepairTargets(state);
    let spent = this.updateAIResearch(state, dt, enemyResources);
    spent += this.dispatchAutoBuilds(state, cp, enemyResources - spent);
    this.collectFinishedAutoBuilds(state, dt);
    this.collectFinishedBuilds(state);

    // 2. Adaptive counters.
    this.updateAdaptive(state);

    // 3. Raid planner.
    this.raidPlanner.update(state, dt, this.doctrineType, this.config.difficulty);

    // 4. Periodic replan.
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) {
      this.tickTimer = this.basePlannerInterval();
      this.maybeAdvanceRing(state);
      this.replanQueue(state);
      // Anti-stall: periodically force shipyard orders into the queue front
      // when the AI is below its target shipyard count and has resources.
      this.maybeForceShipyardScaling(state, enemyResources - spent);
      spent += this.dispatchAutoBuilds(state, cp, enemyResources - spent);
    }

    // 5. Narrate notable events.
    this.updateChatNarration(state);
    return spent;
  }

  private updateChatNarration(state: GameState): void {
    const cp = this.rootCommandPost?.alive ? this.rootCommandPost : null;
    if (!cp) return;

    // Announce if a hostile ship is rushing the command post.
    const rusher = this.nearestHostileShip(state, cp.position);
    if (rusher
        && rusher.position.distanceTo(cp.position) < GRID_CELL_SIZE * CP_RUSH_DETECTION_CELLS) {
      this.emitPlannerChat([
        'Intruder detected near command post!',
        'Enemy is attacking our core!',
        'You dare breach our perimeter?!',
        'All units — defend the command post!',
      ]);
    }
  }

  // ---------------------------------------------------------------------------
  // Adaptive behavior
  // ---------------------------------------------------------------------------

  private updateAdaptive(state: GameState): void {
    this.auditTimer -= 1;
    if (this.auditTimer <= 0) {
      this.auditTimer = Math.max(30, 120 - difficultyIndex(this.config.difficulty) * 15);
      this.auditConstructionState(state);
    }

    // Track builder attrition.
    const aliveCount = this.builders.filter((b) => b.alive).length;
    const expected   = this.config.enemyMaxBuilders;
    if (aliveCount < expected - this.adaptive.builderKillsObserved) {
      this.adaptive.builderKillsObserved++;
      this.adaptive.lastBuilderKillTime = state.gameTime;
      this.emitPlannerChat([
        'Builder unit lost — dispatching replacement.',
        'Our worker drone was destroyed!',
        'Construction interrupted — rebuilding.',
        "You destroyed our builder. We'll send another.",
      ]);
    }

    // Track Command Post rushes.
    const cp = this.rootCommandPost?.alive ? this.rootCommandPost : null;
    if (cp) {
      const rusher = this.nearestHostileShip(state, cp.position);
      if (rusher && rusher.position.distanceTo(cp.position) < GRID_CELL_SIZE * 10) {
        this.adaptive.commandPostRushes++;
      }
    }

    // Adaptive doctrine: add redundant spokes if player keeps cutting conduits.
    if (this.doctrineType === 'adaptive'
        && this.adaptive.conduitCutsObserved > 3
        && this.extraSpokes < 2) {
      this.extraSpokes++;
      this.generatePlan();
      this.claimedConduitKeys.clear();
      this.claimedBuildingKeys.clear();
    }
  }

  private auditConstructionState(state: GameState): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const order = this.queue[i];
      const valid = order.kind === 'conduit'
        ? state.isConduitPlacementCellClear(order.cx, order.cy).valid || state.grid.hasConduit(order.cx, order.cy)
        : state.getStructureFootprintStatus(order.def, order.cx, order.cy).valid;
      if (!valid) {
        this.releaseOrderReservation(order);
        this.queue.splice(i, 1);
      }
    }
    if (difficultyIndex(this.config.difficulty) >= 1 && this.usesConduits(state)) {
      this.auditPowerRestoration(state);
    }
  }

  private auditPowerRestoration(state: GameState): void {
    const idx = difficultyIndex(this.config.difficulty);
    const maxOrders = [0, 2, 4, 7, 10, 14][idx];
    let added = 0;
    const unpowered: BuildingBase[] = [];
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team || b.buildProgress < 1 || b.powered || b instanceof PowerGenerator) continue;
      const priority = this.powerRepairPriority(b);
      let insertAt = unpowered.length;
      while (insertAt > 0 && this.powerRepairPriority(unpowered[insertAt - 1]) < priority) insertAt--;
      unpowered.splice(insertAt, 0, b);
      if (unpowered.length > maxOrders * 2) unpowered.length = maxOrders * 2;
    }

    for (const b of unpowered) {
      if (added >= maxOrders) break;
      const c = cellOf(b.position);
      const segmentKey = this.segmentKeyForCell(c.cx, c.cy);
      const stat = this.adaptive.unpoweredSegments.get(segmentKey) ?? { count: 0, lastTime: 0, redundantLinks: 0 };
      if (state.gameTime - stat.lastTime > 8) stat.count++;
      stat.lastTime = state.gameTime;
      this.adaptive.unpoweredSegments.set(segmentKey, stat);

      const path = this.findPowerRepairPath(state, c.cx, c.cy, idx >= 3 ? 18 : 12);
      if (path.length > 0) added += this.enqueueConduitPath(state, path, maxOrders - added);

      if (idx >= 3 && stat.count >= [99, 99, 3, 2, 1, 1][idx] && stat.redundantLinks < [0, 0, 1, 2, 3, 4][idx]) {
        const redundant = this.findRedundantRingConnector(state, c.cx, c.cy);
        if (redundant.length > 0) {
          added += this.enqueueConduitPath(state, redundant, maxOrders - added);
          stat.redundantLinks++;
        }
      }
    }
  }

  private powerRepairPriority(b: BuildingBase): number {
    if (b instanceof Shipyard) return 8;
    if (b instanceof ResearchLab) return 7;
    if (b instanceof TurretBase) return 6;
    if (b instanceof Factory) return 5;
    return 2;
  }

  private segmentKeyForCell(cx: number, cy: number): string {
    const dx = cx - this.centerCx;
    const dy = cy - this.centerCy;
    const ring = Math.max(0, Math.round((Math.hypot(dx, dy) - AI_INNER_RING_RADIUS_CELLS) / AI_RING_STEP_CELLS));
    const angle = Math.atan2(dy, dx);
    const segment = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 12) % 12;
    return `${ring}:${segment}`;
  }

  private findPowerRepairPath(state: GameState, cx: number, cy: number, maxDistance: number): Array<{ cx: number; cy: number }> {
    let best: Array<{ cx: number; cy: number }> = [];
    let bestLen = Infinity;
    const visitTarget = (t: { cx: number; cy: number }): void => {
      if (!state.power.isCellEnergized(this.team, t.cx, t.cy) && state.grid.conduitTeam(t.cx, t.cy) !== this.team) return;
      const d = Math.abs(t.cx - cx) + Math.abs(t.cy - cy);
      if (d <= 1 || d > maxDistance || d >= bestLen) return;
      const path = traceLine(t.cx, t.cy, cx, cy).slice(1);
      if (path.some((cell) => !state.grid.hasConduit(cell.cx, cell.cy) && !this.canAIPlaceConduit(state, cell.cx, cell.cy))) return;
      best = path;
      bestLen = d;
    };
    for (const spoke of this.spokes) {
      for (const t of spoke) visitTarget(t);
    }
    for (const ring of this.rings) {
      for (const t of ring.conduitCells) visitTarget(t);
    }
    return best;
  }

  private findRedundantRingConnector(state: GameState, cx: number, cy: number): Array<{ cx: number; cy: number }> {
    const ringIndex = Math.max(1, Math.round((Math.hypot(cx - this.centerCx, cy - this.centerCy) - AI_INNER_RING_RADIUS_CELLS) / AI_RING_STEP_CELLS));
    const inner = this.rings[Math.max(0, ringIndex - 1)];
    const outer = this.rings[Math.min(this.rings.length - 1, ringIndex)];
    if (!inner || !outer) return [];
    let source = inner.conduitCells[0];
    let best = Infinity;
    for (const c of inner.conduitCells) {
      if (!state.power.isCellEnergized(this.team, c.cx, c.cy)) continue;
      const d = Math.abs(c.cx - cx) + Math.abs(c.cy - cy);
      if (d < best) { best = d; source = c; }
    }
    const target = outer.conduitCells.reduce((acc, c) => {
      const da = Math.abs(acc.cx - cx) + Math.abs(acc.cy - cy);
      const db = Math.abs(c.cx - cx) + Math.abs(c.cy - cy);
      return db < da ? c : acc;
    }, outer.conduitCells[0]);
    if (!source || !target) return [];
    return traceLine(source.cx, source.cy, target.cx, target.cy).slice(1);
  }

  private enqueueConduitPath(state: GameState, path: Array<{ cx: number; cy: number }>, limit: number): number {
    let added = 0;
    for (const cell of path) {
      if (added >= limit) break;
      const k = cellKey(cell.cx, cell.cy);
      if (this.claimedConduitKeys.has(k) || state.grid.hasConduit(cell.cx, cell.cy)) {
        this.claimedConduitKeys.add(k);
        continue;
      }
      if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) continue;
      this.claimedConduitKeys.add(k);
      this.reserveCells([cell]);
      this.queue.unshift({ kind: 'conduit', cx: cell.cx, cy: cell.cy });
      added++;
    }
    return added;
  }

  /** Called by PracticeMode when the player destroys an enemy conduit. */
  notifyConduitDestroyed(pos: Vec2): void {
    this.adaptive.conduitCutsObserved++;
    const c = cellOf(pos);
    const key = this.segmentKeyForCell(c.cx, c.cy);
    const stat = this.adaptive.unpoweredSegments.get(key) ?? { count: 0, lastTime: 0, redundantLinks: 0 };
    stat.count++;
    this.adaptive.unpoweredSegments.set(key, stat);
    this.raidPlanner.notifyStructureDestroyed(pos);
  }

  /** Called by PracticeMode when the player destroys an enemy building. */
  notifyBuildingDestroyed(pos: Vec2): void {
    this.raidPlanner.notifyStructureDestroyed(pos);
    // Unclaim the building cell so it can be re-planned.
    const cx = Math.floor(pos.x / GRID_CELL_SIZE);
    const cy = Math.floor(pos.y / GRID_CELL_SIZE);
    this.claimedBuildingKeys.delete(cellKey(cx, cy));
    for (const [dx, dy] of CARDINAL_OFFSETS) {
      this.claimedBuildingKeys.delete(cellKey(cx + dx, cy + dy));
    }
    // Reset queued flags so the slot can be re-issued.
    for (const ring of this.rings) {
      for (const slot of ring.buildingSlots) {
        if (Math.abs(slot.cx - cx) <= 1 && Math.abs(slot.cy - cy) <= 1) {
          slot.queued = false;
          slot.placed = false;
          slot.connectorCells = [];
          slot.connectorQueuePtr = -1;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ring advancement
  // ---------------------------------------------------------------------------

  private maybeAdvanceRing(state: GameState): void {
    if (this.currentRing >= this.rings.length - 1) {
      if (this.canPlanAnotherRing()) {
        this.plannedRingCount++;
        this.generatePlan();
      }
      if (this.currentRing >= this.rings.length - 1) return;
    }
    const ring = this.rings[this.currentRing];
    const idx = difficultyIndex(this.config.difficulty);
    const interval = this.basePlannerInterval();

    // Count conduit cells that are actually placed in the grid.
    const totalConduit = ring.conduitCells.length;
    if (totalConduit === 0) {
      this.ringAdvanceStuckTimer = 0;
      this.currentRing++;
      return;
    }
    let placedConduit = 0;
    for (const cell of ring.conduitCells) {
      if (state.grid.hasConduit(cell.cx, cell.cy)) placedConduit++;
    }
    const conduitFrac = placedConduit / totalConduit;

    // Count building slots that are actually placed.
    const slots = ring.buildingSlots;
    const buildingFrac = slots.length > 0
      ? slots.filter((s) => s.placed).length / slots.length
      : 1.0;

    // Thresholds scale with difficulty: higher difficulty → more complete ring
    // required before expanding.  Conduit completion is weighted more heavily
    // because unpowered rings waste build effort.
    const reqConduit  = [0.45, 0.55, 0.65, 0.75, 0.85, 0.9][idx];
    const reqBuilding = [0.20, 0.30, 0.40, 0.50, 0.60, 0.55][idx];
    const ready = conduitFrac >= reqConduit && buildingFrac >= reqBuilding;

    if (!ready) {
      // Stuck-safety: if the ring is stalling (blocked slots, map edge, etc.)
      // force-advance after ~90 s so the outer rings still get built.
      this.ringAdvanceStuckTimer += interval;
      const STUCK_THRESHOLD = 90;
      if (this.ringAdvanceStuckTimer < STUCK_THRESHOLD) return;
    }

    this.ringAdvanceStuckTimer = 0;
    const center = cellCenter(this.centerCx, this.centerCy);
    const worldR  = ring.radiusCells * GRID_CELL_SIZE;
    state.ringEffects.spawnPowerWave(
      center,
      Math.max(40, worldR - GRID_CELL_SIZE),
      worldR + GRID_CELL_SIZE * 2,
      1.6,
      1.0 + 0.15 * idx,
    );
    const nextRingNum = this.currentRing + 1;
    this.currentRing++;
    if (this.currentRing >= this.rings.length - 2 && this.canPlanAnotherRing()) {
      this.plannedRingCount++;
      this.generatePlan();
    }

    // Announce ring expansion to the player.
    this.emitPlannerChat([
      `Ring ${nextRingNum} construction commencing!`,
      `Expanding base — perimeter ring ${nextRingNum} online.`,
      `Our base grows. Ring ${nextRingNum} now active.`,
      `Defensive ring ${nextRingNum} is coming online.`,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Build queue management
  // ---------------------------------------------------------------------------

  private basePlannerInterval(): number {
    return Math.max(0.22, 4.0 / difficultyTickMul(this.config.difficulty));
  }

  private canPlanAnotherRing(): boolean {
    const nextRadius = this.ringRadiusForIndex(this.plannedRingCount);
    const marginCells = Math.min(
      this.centerCx,
      this.centerCy,
      Math.floor(WORLD_WIDTH / GRID_CELL_SIZE) - this.centerCx,
      Math.floor(WORLD_HEIGHT / GRID_CELL_SIZE) - this.centerCy,
    );
    return nextRadius + 10 < marginCells;
  }

  /**
   * Fill the queue with the next highest-priority build orders.
   *
   * Ordering (highest to lowest):
   *   1. Spoke conduit cells (inner → outer), all spokes in parallel.
   *   2. Ring conduit cells for the current ring (inner → outer).
   *   3. Building slots for the current ring.
   *   4. Conduit and buildings for already-completed rings (infill).
   *   5. Bastion construction (Raider / Adaptive, Hard+).
   */
  private replanQueue(state: GameState): void {
    const idx = difficultyIndex(this.config.difficulty);
    const TARGET = [5, 8, 12, 18, 28, 42][idx];
    while (this.queue.length < TARGET) {
      const order = this.nextBuildOrder(state);
      if (!order) break;
      this.queue.push(order);
    }
  }

  private nextBuildOrder(state: GameState): BuildOrder | null {
    const useConduits = this.usesConduits(state);
    // --- 1. Spoke cells — build inner cells first so power reaches rings early.
    for (let si = 0; useConduits && si < this.spokes.length; si++) {
      const spoke = this.spokes[si];
      let ptr = this.spokeQueuePtrs[si];
      // Advance past cells already laid.
      while (ptr < spoke.length) {
        const cell = spoke[ptr];
        const k = cellKey(cell.cx, cell.cy);
        if (state.grid.hasConduit(cell.cx, cell.cy) || this.claimedConduitKeys.has(k)) {
          this.claimedConduitKeys.add(k);
          ptr++;
        } else {
          break;
        }
      }
      this.spokeQueuePtrs[si] = ptr;

      if (ptr < spoke.length) {
        const cell = spoke[ptr];
        const k = cellKey(cell.cx, cell.cy);
        if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) {
          this.spokeQueuePtrs[si]++;
          continue;
        }
        this.claimedConduitKeys.add(k);
        this.reserveCells([{ cx: cell.cx, cy: cell.cy }]);
        this.spokeQueuePtrs[si]++;
        return { kind: 'conduit', cx: cell.cx, cy: cell.cy };
      }
    }

    // --- 2 + 4. Ring conduit cells -------------------------------------------
    for (let r = 0; useConduits && r <= this.currentRing && r < this.rings.length; r++) {
      const order = this.nextRingConduitOrder(state, this.rings[r]);
      if (order) return order;
    }

    const backfillOrder = this.nextInnerBackfillOrder(state);
    if (backfillOrder) return backfillOrder;

    // --- 3 + 4. Ring building slots ------------------------------------------
    for (let r = 0; r <= this.currentRing && r < this.rings.length; r++) {
      const order = this.nextBuildingSlotOrder(state, this.rings[r]);
      if (order) return order;
    }

    // --- 5. Bastion construction (Hard+) ------------------------------------
    if (this.bastions.length > 0 && difficultyIndex(this.config.difficulty) >= 2) {
      return this.nextBastionOrder(state);
    }

    return null;
  }

  private nextRingConduitOrder(
    state: GameState, ring: RingPlan,
  ): BuildOrder | null {
    while (ring.conduitQueuePtr < ring.conduitCells.length) {
      const cell = ring.conduitCells[ring.conduitQueuePtr];
      ring.conduitQueuePtr++;
      const k = cellKey(cell.cx, cell.cy);
      if (this.claimedConduitKeys.has(k)) continue;
      if (state.grid.hasConduit(cell.cx, cell.cy)) {
        this.claimedConduitKeys.add(k); continue;
      }
      if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) continue;
      this.claimedConduitKeys.add(k);
      this.reserveCells([{ cx: cell.cx, cy: cell.cy }]);
      return { kind: 'conduit', cx: cell.cx, cy: cell.cy };
    }
    return null;
  }

  private nextInnerBackfillOrder(state: GameState): BuildOrder | null {
    const idx = difficultyIndex(this.config.difficulty);
    // Easy doesn't do backfill; Normal+ does once ring 1 is active (was ring 2).
    if (idx < 1 || this.currentRing < 1 || this.rings.length < 1) return null;

    // Relaxed turret gating: only require 1+ turrets on Normal, 2+ on Hard+.
    // (Previously required 3-5 turrets at Hard+, which delayed shipyards far too long.)
    const turretCoverage = this.countEnemyBuildings(state, (b) => b instanceof TurretBase);
    if (turretCoverage < [99, 1, 1, 2, 2, 0][idx]) return null;

    // Desired counts scale with difficulty AND with urgencyLevel.
    // Base targets per difficulty: Easy=0, Normal=2, Hard=4, Expert=6, Nightmare=8, Zenith=14 fighter yards.
    const urgencyBonus = this.urgencyLevel; // +1 or +2 extra yards when stalling
    const gameTime = state.gameTime;
    // Time-based escalation: every 3 minutes (180 s) add 1 more desired yard at Hard+.
    // Capped at +4 to prevent runaway queue saturation in very long games.
    const timeBonus = idx >= 2 ? Math.min(4, Math.floor(gameTime / 180)) : 0;

    const desired = [
      { key: 'fighteryard', count: [0, 2, 4, 6, 8, 14][idx] + urgencyBonus + timeBonus },
      { key: 'researchlab', count: [0, 1, 2, 3, 4, 5][idx] },
      { key: 'bomberyard',  count: [0, 0, 5, 5, 5, 5][idx] },
      { key: 'swarmyard',   count: this.targetSwarmYardCount(state) },
      { key: 'factory',     count: [0, 1, 1, 2, 3, 3][idx] },
    ];

    for (const want of desired) {
      if (!this.canAIUseAdvancedYard(want.key)) continue;
      const def = getBuildDef(want.key);
      if (!def) continue;
      const current = this.countEnemyBuildings(state, (b) => buildDefForEntityType(b.type)?.key === want.key);
      const alreadyQueued = this.queue.filter((order) => order.kind === 'building' && order.def.key === want.key).length
        + this.activeAutoBuilds.filter((active) => active.order.kind === 'building' && active.order.def.key === want.key).length;
      if (current + alreadyQueued >= want.count) continue;

      // Allow placing in rings 0 through currentRing (wider search at higher difficulty/urgency).
      const maxRing = Math.min(
        this.currentRing,
        Math.min(2 + Math.floor(idx / 2) + this.urgencyLevel, this.rings.length - 1),
      );
      for (let r = 0; r <= maxRing; r++) {
        const ring = this.rings[r];
        const attempts = Math.max(10, ring.conduitCells.length);
        for (let n = 0; n < attempts; n++) {
          const h = Math.floor(hash01plan(this.seed + want.key.length * 17, r * 97 + n, 9001) * Math.max(1, ring.conduitCells.length));
          const anchor = ring.conduitCells[h];
          if (!anchor) continue;
          const cell = this.findBestBuildingCell(state, anchor.cx, anchor.cy, def, ring);
          if (!cell) continue;
          const k = `${want.key}:${cellKey(cell.cx, cell.cy)}`;
          if (this.backfillKeys.has(k)) continue;
          this.backfillKeys.add(k);
          this.claimedBuildingKeys.add(cellKey(cell.cx, cell.cy));
          this.reserveBuildingFootprint(def, cell.cx, cell.cy);
          return { kind: 'building', cx: cell.cx, cy: cell.cy, def, layConduitFirst: false };
        }
      }
    }
    return null;
  }

  private nextBuildingSlotOrder(
    state: GameState, ring: RingPlan,
  ): BuildOrder | null {
    for (const slot of ring.buildingSlots) {
      if (slot.placed) continue;

      let def = getBuildDef(slot.buildingKey);
      if (!def) { slot.queued = true; continue; }
      if (!this.canAIUseAdvancedYard(def.key)) continue;
      if (def.key === 'powergenerator' && !this.shouldPlacePowerGeneratorHere(state, ring, slot.cx, slot.cy)) {
        const replacement = this.replacementForRedundantGenerator(ring);
        const replacementDef = getBuildDef(replacement);
        if (!replacementDef) { slot.queued = true; continue; }
        if (!this.canAIUseAdvancedYard(replacementDef.key)) continue;
        slot.buildingKey = replacement;
        def = replacementDef;
      }

      // --- Phase A: dispatch pending connector conduits first ---
      if (slot.connectorQueuePtr >= 0) {
        while (slot.connectorQueuePtr < slot.connectorCells.length) {
          const cell = slot.connectorCells[slot.connectorQueuePtr];
          slot.connectorQueuePtr++;
          const k = cellKey(cell.cx, cell.cy);
          if (this.claimedConduitKeys.has(k) || state.grid.hasConduit(cell.cx, cell.cy)) {
            this.claimedConduitKeys.add(k);
            continue;
          }
          if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) continue;
          this.claimedConduitKeys.add(k);
          this.reserveCells([cell]);
          return { kind: 'conduit', cx: cell.cx, cy: cell.cy };
        }
        // All connectors done; fall through to dispatch the building order.
      }

      // --- Phase B: dispatch the building order ---
      if (slot.queued) continue; // already dispatched

      // If candidate position has not been found yet, find it now.
      if (slot.connectorQueuePtr < 0) {
        const candidate = this.findBestBuildingCell(state, slot.cx, slot.cy, def, ring);
        if (!candidate) continue;

        // On lower difficulties, avoid building in hostile fire zones.
        if (difficultyIndex(this.config.difficulty) < 3) {
          const threat = this.aiScore.threatAt(state, this.team, candidate.cx, candidate.cy);
          if (threat > 55) continue;
        }

        // Lock candidate and compute connector path.
        slot.cx = candidate.cx;
        slot.cy = candidate.cy;
        this.claimedBuildingKeys.add(cellKey(candidate.cx, candidate.cy));
        this.reserveBuildingFootprint(def, candidate.cx, candidate.cy);
        slot.connectorCells = this.computeConnectorPath(state, candidate.cx, candidate.cy, def, ring);
        slot.connectorQueuePtr = 0;

        // Dispatch first connector if any (subsequent ones come via Phase A).
        while (slot.connectorQueuePtr < slot.connectorCells.length) {
          const cell = slot.connectorCells[slot.connectorQueuePtr];
          slot.connectorQueuePtr++;
          const k = cellKey(cell.cx, cell.cy);
          if (this.claimedConduitKeys.has(k) || state.grid.hasConduit(cell.cx, cell.cy)) {
            this.claimedConduitKeys.add(k);
            continue;
          }
          if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) continue;
          this.claimedConduitKeys.add(k);
          this.reserveCells([cell]);
          return { kind: 'conduit', cx: cell.cx, cy: cell.cy };
        }
        // No connectors needed — fall through to building dispatch immediately.
      }

      // Validate footprint one more time before dispatching.
      if (!state.getStructureFootprintStatus(def, slot.cx, slot.cy).valid) continue;

      slot.queued = true;
      return { kind: 'building', cx: slot.cx, cy: slot.cy, def, layConduitFirst: false };
    }
    return null;
  }

  /**
   * Compute a short 4-connected conduit path from the nearest planned or
   * active conduit cell to the building footprint's border.
   *
   * Returns an empty array if the building is already adjacent to power
   * (no gap to bridge), or if the nearest conduit is too far away (> 5 cells).
   * The anchor conduit cell itself is excluded from the result (already
   * planned/built).  Cells that fall inside the building footprint are also
   * excluded.
   */
  private computeConnectorPath(
    state: GameState,
    cx: number, cy: number,
    def: BuildDef,
    ring: RingPlan,
  ): Array<{ cx: number; cy: number }> {
    const fp = def.footprintCells;
    const originCx = cx - Math.floor(fp / 2);
    const originCy = cy - Math.floor(fp / 2);

    // Collect border cells (one cell outside the footprint on every side).
    const borderCells: Array<{ cx: number; cy: number }> = [];
    for (let bx = originCx - 1; bx <= originCx + fp; bx++) {
      borderCells.push({ cx: bx, cy: originCy - 1 });
      borderCells.push({ cx: bx, cy: originCy + fp });
    }
    for (let by = originCy; by < originCy + fp; by++) {
      borderCells.push({ cx: originCx - 1, cy: by });
      borderCells.push({ cx: originCx + fp, cy: by });
    }

    // Find nearest claimed conduit cell to any border cell.
    let nearestConduit: { cx: number; cy: number } | null = null;
    let nearestBorder: { cx: number; cy: number } | null = null;
    let nearestDist = Infinity;

    const searchCells = [...ring.conduitCells, ...this.spokes.flat()];
    for (const rc of searchCells) {
      const k = cellKey(rc.cx, rc.cy);
      if (!this.claimedConduitKeys.has(k) && !state.grid.hasConduit(rc.cx, rc.cy)) continue;
      for (const bc of borderCells) {
        const d = Math.abs(rc.cx - bc.cx) + Math.abs(rc.cy - bc.cy);
        if (d < nearestDist) {
          nearestDist = d;
          nearestConduit = rc;
          nearestBorder = bc;
        }
      }
    }

    // No connector needed if already adjacent or too far to bridge sensibly.
    if (!nearestConduit || !nearestBorder || nearestDist <= 1 || nearestDist > 5) {
      return [];
    }

    // Generate 4-connected path; skip anchor and cells inside footprint.
    const fullPath = traceLine(
      nearestConduit.cx, nearestConduit.cy,
      nearestBorder.cx, nearestBorder.cy,
    );
    const result: Array<{ cx: number; cy: number }> = [];
    for (const cell of fullPath.slice(1)) {
      if (cell.cx >= originCx && cell.cx < originCx + fp &&
          cell.cy >= originCy && cell.cy < originCy + fp) break;
      result.push(cell);
    }
    return result;
  }
  private nextBastionOrder(state: GameState): BuildOrder | null {
    for (const bastion of this.bastions) {
      if (bastion.status === 'abandoned') continue;

      // Conduit loop first.
      if (this.usesConduits(state)) {
        const conduitOrder = this.nextBastionConduitOrder(state, bastion);
        if (conduitOrder) return conduitOrder;
      }

      // Generator.
      if (bastion.generatorSlot) {
        const gs = bastion.generatorSlot;
        const k = cellKey(gs.cx, gs.cy);
        if (!this.claimedBuildingKeys.has(k)) {
          const def = getBuildDef('powergenerator');
          if (def && this.canAIPlaceStructure(state, def, gs.cx, gs.cy)) {
            this.claimedBuildingKeys.add(k);
            this.reserveBuildingFootprint(def, gs.cx, gs.cy);
            if (bastion.status === 'planned') bastion.status = 'constructing';
            return { kind: 'building', cx: gs.cx, cy: gs.cy, def, layConduitFirst: false };
          }
        }
      }

      // Turrets.
      for (const ts of bastion.turretSlots) {
        if (ts.queued || ts.placed) continue;
        const referenceRing = this.rings[this.currentRing] ?? this.rings[this.rings.length - 1];
        const def = getBuildDef(referenceRing ? this.chooseTurretForSlot(referenceRing) : 'missileturret');
        if (!def) continue;
        const k = cellKey(ts.cx, ts.cy);
        if (this.claimedBuildingKeys.has(k)) continue;
        if (!this.canAIPlaceStructure(state, def, ts.cx, ts.cy)) continue;
        ts.queued = true;
        this.claimedBuildingKeys.add(k);
        this.reserveBuildingFootprint(def, ts.cx, ts.cy);
        return { kind: 'building', cx: ts.cx, cy: ts.cy, def, layConduitFirst: false };
      }
    }
    return null;
  }

  private nextBastionConduitOrder(
    state: GameState, bastion: BastionPlan,
  ): BuildOrder | null {
    while (bastion.conduitQueuePtr < bastion.conduitCells.length) {
      const cell = bastion.conduitCells[bastion.conduitQueuePtr];
      bastion.conduitQueuePtr++;
      const k = cellKey(cell.cx, cell.cy);
      if (this.claimedConduitKeys.has(k)) continue;
      if (state.grid.hasConduit(cell.cx, cell.cy)) {
        this.claimedConduitKeys.add(k); continue;
      }
      if (!this.canAIPlaceConduit(state, cell.cx, cell.cy)) continue;
      this.claimedConduitKeys.add(k);
      this.reserveCells([{ cx: cell.cx, cy: cell.cy }]);
      if (bastion.status === 'planned') bastion.status = 'constructing';
      return { kind: 'conduit', cx: cell.cx, cy: cell.cy };
    }
    return null;
  }

  private isCellInBounds(_state: GameState, cx: number, cy: number): boolean {
    const x = (cx + 0.5) * GRID_CELL_SIZE;
    const y = (cy + 0.5) * GRID_CELL_SIZE;
    return x > 0 && x < WORLD_WIDTH && y > 0 && y < WORLD_HEIGHT;
  }

  private canAIPlaceConduit(state: GameState, cx: number, cy: number): boolean {
    if (this.reservedCells.has(cellKey(cx, cy))) return false;
    return state.isConduitPlacementCellClear(cx, cy).valid;
  }

  private canAIPlaceStructure(state: GameState, def: BuildDef, cx: number, cy: number): boolean {
    const origin = { cx: cx - Math.floor(def.footprintCells / 2), cy: cy - Math.floor(def.footprintCells / 2) };
    for (let y = origin.cy; y < origin.cy + def.footprintCells; y++) {
      for (let x = origin.cx; x < origin.cx + def.footprintCells; x++) {
        if (this.reservedCells.has(cellKey(x, y))) return false;
      }
    }
    if (!state.getStructureFootprintStatus(def, cx, cy).valid) return false;
    if (!this.usesConduits(state)) return true;
    return this.isNearPlannedPower(state, origin.cx, origin.cy, def.footprintCells);
  }

  private shouldPlacePowerGeneratorHere(state: GameState, ring: RingPlan, cx: number, cy: number): boolean {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx <= 1) return true;
    if (ring.role === 'forward' || this.doctrine.useLocalPowerIslands) return true;
    const def = getBuildDef('powergenerator');
    if (!def) return true;
    const origin = { cx: cx - Math.floor(def.footprintCells / 2), cy: cy - Math.floor(def.footprintCells / 2) };
    let energizedBorder = 0;
    let enemyConduits = 0;
    for (let y = origin.cy - 2; y <= origin.cy + def.footprintCells + 1; y++) {
      for (let x = origin.cx - 2; x <= origin.cx + def.footprintCells + 1; x++) {
        const near = x < origin.cx || x >= origin.cx + def.footprintCells || y < origin.cy || y >= origin.cy + def.footprintCells;
        if (!near) continue;
        if (state.power.isCellEnergized(this.team, x, y)) energizedBorder++;
        if (state.grid.conduitTeam(x, y) === this.team || this.claimedConduitKeys.has(cellKey(x, y))) enemyConduits++;
      }
    }
    if (energizedBorder >= 3 || enemyConduits >= 4) return false;
    return ring.ringIndex >= this.currentRing && ring.role === 'picket';
  }

  private replacementForRedundantGenerator(ring: RingPlan): string {
    if (ring.role === 'production') {
      if (this.playerThreat.strategy === 'rushing' || this.playerThreat.strategy === 'unknown') {
        return this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret', 'fighteryard']);
      }
      // Prefer bomber yards at higher difficulty; also switch if AI is stalling
      // to push offensive capability harder.
      return (difficultyIndex(this.config.difficulty) >= 3 || this.urgencyLevel >= 2)
        ? 'bomberyard' : 'fighteryard';
    }
    if (ring.role === 'innerDefense') {
      return this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret', 'wall']);
    }
    // For picket and forward rings, pick turret type reactively.
    if (ring.role === 'picket' || ring.role === 'forward') return this.chooseTurretForSlot(ring);
    return 'researchlab';
  }

  private findBestBuildingCell(
    state: GameState,
    preferredCx: number,
    preferredCy: number,
    def: BuildDef,
    ring: RingPlan,
  ): { cx: number; cy: number } | null {
    let best: { cx: number; cy: number; score: number } | null = null;
    const angle = Math.atan2(preferredCy - this.centerCy, preferredCx - this.centerCx);
    // Place buildings just outside the ring conduit band so their inner
    // footprint border is adjacent to the ring outer edge.  This guarantees
    // that isNearPlannedPower passes without requiring extra connector cells.
    //   minOffset = floor(fp/2) + ring_thickness
    // For fp=3: minOffset=3  → footprint at R+2..R+4, border at R+1 ✓
    // For fp=4: minOffset=4  → footprint at R+2..R+5, border at R+1 ✓
    const minOffset = Math.floor(def.footprintCells / 2) + AI_RING_THICKNESS_CONDUITS;
    for (let radial = minOffset; radial <= minOffset + 5; radial++) {
      for (let tangent = -6; tangent <= 6; tangent++) {
        const cx = this.centerCx + Math.round(Math.cos(angle) * (ring.radiusCells + radial) - Math.sin(angle) * tangent);
        const cy = this.centerCy + Math.round(Math.sin(angle) * (ring.radiusCells + radial) + Math.cos(angle) * tangent);
        if (this.claimedBuildingKeys.has(cellKey(cx, cy))) continue;
        if (!this.canAIPlaceStructure(state, def, cx, cy)) continue;
        const threat = this.aiScore.threatAt(state, this.team, cx, cy);
        const nearby = this.nearbyFriendlyBuildingCount(state, cx, cy, 7);
        const spacing = isZenithDifficulty(this.config.difficulty) ? nearby * 14 : -nearby * 20;
        const score = -Math.abs(tangent) * 3 - radial - threat + spacing;
        if (!best || score > best.score) best = { cx, cy, score };
      }
    }
    return best ? { cx: best.cx, cy: best.cy } : null;
  }

  private nearbyFriendlyBuildingCount(state: GameState, cx: number, cy: number, radiusCells: number): number {
    let count = 0;
    const r2 = radiusCells * radiusCells;
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team) continue;
      const bx = Math.floor(b.position.x / GRID_CELL_SIZE);
      const by = Math.floor(b.position.y / GRID_CELL_SIZE);
      const dx = bx - cx;
      const dy = by - cy;
      if (dx * dx + dy * dy <= r2) count++;
    }
    return count;
  }

  private countEnemyBuildings(state: GameState, predicate: (b: BuildingBase) => boolean): number {
    let count = 0;
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team) continue;
      if (predicate(b)) count++;
    }
    return count;
  }

  private countEnemyBuildingsByKey(state: GameState, key: string): number {
    return this.countEnemyBuildings(state, (b) => buildDefForEntityType(b.type)?.key === key);
  }

  private queuedBuildingCount(key: string): number {
    return this.queue.filter((order) => order.kind === 'building' && order.def.key === key).length
      + this.activeAutoBuilds.filter((active) => active.order.kind === 'building' && active.order.def.key === key).length;
  }

  private canAIUseAdvancedYard(key: string): boolean {
    if (key !== 'bomberyard' && key !== 'swarmyard') return true;
    return this.aiResearchedItems.has(key);
  }

  private targetSwarmYardCount(state: GameState): number {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx < 3) return 0;
    const fighterYards = this.countEnemyBuildingsByKey(state, 'fighteryard') + this.queuedBuildingCount('fighteryard');
    if (fighterYards < 8 && !this.aiResearchedItems.has('swarmyard')) return 0;
    return [0, 0, 0, 2, 4, 5][idx];
  }

  private isNearPlannedPower(state: GameState, originCx: number, originCy: number, size: number): boolean {
    for (let y = originCy - 1; y <= originCy + size; y++) {
      for (let x = originCx - 1; x <= originCx + size; x++) {
        const border = x === originCx - 1 || x === originCx + size || y === originCy - 1 || y === originCy + size;
        if (!border) continue;
        const k = cellKey(x, y);
        if (this.claimedConduitKeys.has(k)) return true;
        if (state.grid.conduitTeam(x, y) === this.team) return true;
        if (state.power.isCellEnergized(this.team, x, y)) return true;
      }
    }
    return false;
  }

  private reserveBuildingFootprint(def: BuildDef, cx: number, cy: number): void {
    const origin = { cx: cx - Math.floor(def.footprintCells / 2), cy: cy - Math.floor(def.footprintCells / 2) };
    const cells: Array<{ cx: number; cy: number }> = [];
    for (let y = origin.cy; y < origin.cy + def.footprintCells; y++) {
      for (let x = origin.cx; x < origin.cx + def.footprintCells; x++) cells.push({ cx: x, cy: y });
    }
    this.reserveCells(cells);
  }

  private reserveCells(cells: Array<{ cx: number; cy: number }>): void {
    for (const c of cells) this.reservedCells.add(cellKey(c.cx, c.cy));
  }

  private enqueueProtectiveWallsForBuilding(state: GameState, buildingCx: number, buildingCy: number, def: BuildDef): void {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx <= 0) return;
    const wallDef = getBuildDef('wall');
    if (!wallDef) return;

    let cap = [0, 2, 4, 7, 10, 4][idx];
    const fp = def.footprintCells;
    const originCx = buildingCx - Math.floor(fp / 2);
    const originCy = buildingCy - Math.floor(fp / 2);
    const candidates: Array<{ cx: number; cy: number }> = [];
    const step = Math.max(1, wallDef.footprintCells);
    const pushWallLine = (x0: number, x1: number, y: number): void => {
      for (let x = x0; x <= x1; x += step) candidates.push({ cx: x, cy: y });
    };
    const pushWallColumn = (x: number, y0: number, y1: number): void => {
      for (let y = y0; y <= y1; y += step) candidates.push({ cx: x, cy: y });
    };

    if (def.key === 'fighteryard' || def.key === 'bomberyard') {
      pushWallLine(originCx, originCx + fp - 1, originCy - 1);
      pushWallColumn(originCx - 1, originCy, originCy + fp - 2);
      pushWallColumn(originCx + fp, originCy, originCy + fp - 2);
    } else if (def.key === 'researchlab') {
      pushWallLine(originCx, originCx + fp - 1, originCy - 1);
      pushWallColumn(originCx - 1, originCy + 1, originCy + fp - 1);
      pushWallColumn(originCx + fp, originCy + 1, originCy + fp - 1);
      cap = Math.min(cap, 5);
    } else if (
      def.key === 'missileturret' ||
      def.key === 'gatlingturret' ||
      def.key === 'exciterturret' ||
      def.key === 'massdriverturret' ||
      def.key === 'regenturret'
    ) {
      const buildingCenter = cellCenter(buildingCx, buildingCy);
      const threatPos = this.nearestHostileShip(state, buildingCenter)?.position ?? null;
      const towardThreatX = threatPos ? Math.sign(threatPos.x - buildingCenter.x) : 1;
      const towardThreatY = threatPos ? Math.sign(threatPos.y - buildingCenter.y) : 0;
      if (Math.abs(towardThreatX) >= Math.abs(towardThreatY)) {
        pushWallColumn(originCx + (towardThreatX > 0 ? fp : -1), originCy, originCy + fp - 1);
      } else {
        pushWallLine(originCx, originCx + fp - 1, originCy + (towardThreatY > 0 ? fp : -1));
      }
      cap = Math.min(cap, 3);
    } else {
      return;
    }

    for (const wall of candidates) {
      if (cap <= 0) break;
      const k = cellKey(wall.cx, wall.cy);
      if (this.protectiveWallKeys.has(k) || this.claimedBuildingKeys.has(k)) continue;
      if (!this.canAIPlaceStructure(state, wallDef, wall.cx, wall.cy)) continue;
      this.protectiveWallKeys.add(k);
      this.claimedBuildingKeys.add(k);
      this.reserveBuildingFootprint(wallDef, wall.cx, wall.cy);
      this.queue.push({ kind: 'building', cx: wall.cx, cy: wall.cy, def: wallDef, layConduitFirst: false });
      cap--;
    }
  }

  private releaseOrderReservation(order: BuildOrder): void {
    if (order.kind === 'conduit') {
      this.reservedCells.delete(cellKey(order.cx, order.cy));
      return;
    }
    const origin = { cx: order.cx - Math.floor(order.def.footprintCells / 2), cy: order.cy - Math.floor(order.def.footprintCells / 2) };
    for (let y = origin.cy; y < origin.cy + order.def.footprintCells; y++) {
      for (let x = origin.cx; x < origin.cx + order.def.footprintCells; x++) {
        this.reservedCells.delete(cellKey(x, y));
      }
    }
  }

  private releasePlacedBuildingReservation(ent: BuildingBase, cx: number, cy: number): void {
    const size = footprintForBuildingType(ent.type);
    const origin = { cx: cx - Math.floor(size / 2), cy: cy - Math.floor(size / 2) };
    for (let y = origin.cy; y < origin.cy + size; y++) {
      for (let x = origin.cx; x < origin.cx + size; x++) {
        this.reservedCells.delete(cellKey(x, y));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Builder management
  // ---------------------------------------------------------------------------

  private assignRepairTargets(state: GameState): void {
    const damaged: BuildingBase[] = [];
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team) continue;
      if (b.buildProgress < 1) continue;
      if (b.healthFraction >= 0.99) continue;
      damaged.push(b);
    }

    if (damaged.length === 0) {
      for (const b of this.builders) {
        if (b.mode === 'repair') { b.repairTarget = null; b.mode = 'build'; }
      }
      return;
    }

    const priorityOf = (b: BuildingBase): number => {
      if (b instanceof PowerGenerator) return 0;
      if (b instanceof CommandPost)    return 1;
      if (b instanceof Shipyard)       return 2;
      if (b instanceof TurretBase)     return 3;
      if (b instanceof ResearchLab)    return 4;
      if (b instanceof Factory)        return 4;
      return 5;
    };
    damaged.sort((a, b) => {
      const pa = priorityOf(a), pb = priorityOf(b);
      return pa !== pb ? pa - pb : a.healthFraction - b.healthFraction;
    });

    const claimed = new Set<number>();
    for (const drone of this.builders) {
      if (drone.mode === 'repair' && drone.repairTarget?.alive
          && drone.repairTarget.healthFraction < 0.99) {
        claimed.add(drone.repairTarget.id);
      }
    }

    const idx = difficultyIndex(this.config.difficulty);
    const maxRepairers = Math.max(1, Math.floor(
      this.builders.length * [0.4, 0.5, 0.6, 0.7, 0.8, 0.9][idx],
    ));
    const currentRepairers = this.builders.filter((b) => b.mode === 'repair' && b.alive).length;

    let promotions = maxRepairers - currentRepairers;
    for (const drone of this.builders) {
      if (promotions <= 0) break;
      if (!drone.alive || drone.isBuilding || drone.mode === 'repair') continue;
      const target = damaged.find((b) => !claimed.has(b.id));
      if (!target) break;
      drone.mode = 'repair';
      drone.repairTarget = target;
      if (drone.buildOrder) {
        this.queue.unshift(drone.buildOrder);
        drone.buildOrder = null;
      }
      claimed.add(target.id);
      promotions--;
    }

    for (const drone of this.builders) {
      if (drone.mode !== 'repair') continue;
      const t = drone.repairTarget;
      if (!t || !t.alive || t.healthFraction >= 0.99) {
        drone.mode = 'build';
        drone.repairTarget = null;
      }
    }
  }

  private dispatchIdleBuilders(enemyResources: number): number {
    if (this.queue.length === 0) return 0;
    let spent = 0;
    for (const b of this.builders) {
      if (!b.alive || b.mode === 'repair' || b.buildOrder || b.isBuilding) continue;
      const orderIndex = this.pickAffordableOrderIndex(enemyResources - spent);
      if (orderIndex < 0) break;
      const [order] = this.queue.splice(orderIndex, 1);
      spent += this.orderCost(order);
      b.buildOrder = order;
    }
    return spent;
  }

  private dispatchAutoBuilds(state: GameState, cp: CommandPost, enemyResources: number): number {
    if (this.queue.length === 0) return 0;
    const idx = difficultyIndex(this.config.difficulty);
    const maxActive = [1, 1, 2, 3, 4, 6][idx];
    let spent = 0;
    while (this.activeAutoBuilds.length < maxActive) {
      const orderIndex = this.pickAffordableAutoOrderIndex(enemyResources - spent);
      if (orderIndex < 0) break;
      const [order] = this.queue.splice(orderIndex, 1);
      spent += this.orderCost(order);
      this.activeAutoBuilds.push({
        order,
        remaining: order.kind === 'conduit' ? AUTO_CONDUIT_BUILD_SECONDS : AUTO_STRUCTURE_PLACEMENT_SECONDS,
      });
    }
    return spent;
  }

  private pickAffordableAutoOrderIndex(enemyResources: number): number {
    const affordable: Array<{ index: number; order: BuildOrder; priority: number; cost: number }> = [];
    for (let i = 0; i < this.queue.length; i++) {
      const order = this.queue[i];
      const cost = this.orderCost(order);
      if (cost > enemyResources) continue;
      affordable.push({ index: i, order, priority: this.orderStrategicPriority(order), cost });
    }
    if (affordable.length === 0) return -1;
    if (difficultyIndex(this.config.difficulty) <= 1) return affordable[0].index;
    affordable.sort((a, b) => {
      const pa = b.priority - a.priority;
      if (pa !== 0) return pa;
      return a.index - b.index;
    });
    return affordable[0].index;
  }

  private pickAffordableOrderIndex(enemyResources: number): number {
    const idx = difficultyIndex(this.config.difficulty);
    const affordable: Array<{ index: number; order: BuildOrder; priority: number; cost: number }> = [];
    for (let i = 0; i < this.queue.length; i++) {
      const order = this.queue[i];
      const cost = this.orderCost(order);
      if (cost <= enemyResources) {
        affordable.push({ index: i, order, priority: this.orderStrategicPriority(order), cost });
      }
    }
    if (affordable.length === 0) return -1;

    if (idx <= 1) return affordable[0].index;

    const topPriority = Math.max(...this.queue.map((order) => this.orderStrategicPriority(order)));
    const topQueued = this.queue.find((order) => this.orderStrategicPriority(order) === topPriority);
    const topCost = topQueued ? this.orderCost(topQueued) : 0;
    const shouldSaveForTop = topQueued && topCost > enemyResources && topCost - enemyResources < this.savingsPatience();
    if (shouldSaveForTop && enemyResources < this.bankPressureThreshold()) return -1;

    affordable.sort((a, b) => {
      const pa = b.priority - a.priority;
      if (pa !== 0) return pa;
      const spend = b.cost - a.cost;
      if (spend !== 0) return spend;
      return a.index - b.index;
    });
    return affordable[0].index;
  }

  private orderCost(order: BuildOrder): number {
    return order.kind === 'conduit' ? CONDUIT_COST : order.def.cost;
  }

  private updateAIResearch(state: GameState, dt: number, availableResources: number): number {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx < 2) return 0;
    if (!this.hasPoweredResearchLab(state)) return 0;

    let costSpent = 0;
    if (this.aiResearchProgress) {
      this.aiResearchProgress.remaining -= dt * [0, 0, 1.0, 1.2, 1.45, 2.0][idx];
      if (this.aiResearchProgress.remaining <= 0) {
        this.aiResearchedItems.add(this.aiResearchProgress.item);
        this.aiResearchProgress = null;
      }
    } else {
      const next = this.nextAIResearchItem(state);
      if (next) {
        const cost = RESEARCH_COST[next as keyof typeof RESEARCH_COST] ?? 0;
        if (availableResources >= cost) {
          const ticks = RESEARCH_TIME[next as keyof typeof RESEARCH_TIME];
          if (ticks !== undefined) {
            this.aiResearchProgress = { item: next, remaining: ticks / TICK_RATE };
            costSpent = cost;
          }
        }
      }
    }

    this.syncEnemyResearchLabActivity(state);
    return costSpent;
  }

  private syncEnemyResearchLabActivity(state: GameState): void {
    const isResearching = this.aiResearchProgress !== null;
    for (const b of state.buildings) {
      if (b.alive && b.team === this.team && b instanceof ResearchLab) {
        b.isResearching = isResearching && b.powered && b.buildProgress >= 1;
      }
    }
  }

  isResearchActive(): boolean {
    return this.aiResearchProgress !== null;
  }

  private hasPoweredResearchLab(state: GameState): boolean {
    return this.countEnemyBuildings(
      state,
      (b) => b instanceof ResearchLab && b.powered && b.buildProgress >= 1,
    ) > 0;
  }

  private nextAIResearchItem(state: GameState): string | null {
    const idx = difficultyIndex(this.config.difficulty);
    if (!this.aiResearchedItems.has('bomberyard')) return 'bomberyard';
    const fighterYards = this.countEnemyBuildingsByKey(state, 'fighteryard') + this.queuedBuildingCount('fighteryard');
    if (idx >= 3 && fighterYards >= 8 && !this.aiResearchedItems.has('swarmyard')) return 'swarmyard';
    return null;
  }

  private orderStrategicPriority(order: BuildOrder): number {
    if (order.kind === 'conduit') return 105;
    switch (order.def.key) {
      case 'powergenerator': return 100;
      case 'researchlab': return 95;
      case 'fighteryard':
      case 'bomberyard':
      case 'swarmyard':
        // When the AI is stalling or urgency is elevated, boost offensive
        // production buildings above almost everything (even conduits at level 2).
        if (this.urgencyLevel >= 2) return 110;
        if (this.urgencyLevel >= 1) return 102;
        return 90;
      case 'factory': return 78;
      case 'massdriverturret':
      case 'exciterturret':
      case 'regenturret': return 72;
      case 'gatlingturret': return 68;
      case 'missileturret': return 66;
      case 'wall': return 35;
      default: return 50;
    }
  }

  private savingsPatience(): number {
    return [0, 25, 90, 170, 260, 380][difficultyIndex(this.config.difficulty)];
  }

  private bankPressureThreshold(): number {
    return [0, 80, 180, 320, 520, 760][difficultyIndex(this.config.difficulty)];
  }

  private collectFinishedBuilds(state: GameState): void {
    for (const b of this.builders) {
      if (!b.alive) continue;
      const result = b.consumeFinishedBuild();
      if (!result) continue;

      if (result.kind === 'conduit') {
        this.reservedCells.delete(cellKey(result.cx, result.cy));
        if (state.isConduitPlacementCellClear(result.cx, result.cy).valid) {
          state.grid.addConduit(result.cx, result.cy, this.team);
        } else if (!state.grid.hasConduit(result.cx, result.cy)) {
          this.claimedConduitKeys.delete(cellKey(result.cx, result.cy));
        }
        state.power.markDirty();
      } else {
        this.releasePlacedBuildingReservation(result.ent, result.cx, result.cy);
        const def = buildDefForEntityType(result.ent.type);
        if (!def || !state.getStructureFootprintStatus(def, result.cx, result.cy).valid) continue;
        state.addEntity(result.ent);
        state.applyConfluencePlacement(this.team, result.ent.position, String(result.ent.id));
        this.buildsPlaced++;
        state.recentEnemyConstructions.push({
          pos: result.ent.position.clone(),
          time: state.gameTime,
        });
        state.power.markDirty();
        // Announce significant buildings.
        if (result.ent instanceof Shipyard) {
          this.emitPlannerChat([
            'Shipyard online — fighters launching soon!',
            'Ship production facility constructed!',
            'Our shipyard is operational. Prepare for our fleet.',
            'Fighter yard complete — reinforcements incoming!',
          ]);
        } else if (result.ent instanceof PowerGenerator) {
          this.emitPlannerChat([
            'Power generator online — base expanding.',
            'New power grid sector activated.',
            'Energy infrastructure complete.',
          ]);
        }
        this.markBuildingPlaced(result.cx, result.cy);
        if (def) this.enqueueProtectiveWallsForBuilding(state, result.cx, result.cy, def);
      }
    }
  }

  private collectFinishedAutoBuilds(state: GameState, dt: number): void {
    for (let i = this.activeAutoBuilds.length - 1; i >= 0; i--) {
      const active = this.activeAutoBuilds[i];
      active.remaining -= dt * this.config.enemyBuildSpeedMul * [0.85, 1.0, 1.15, 1.30, 1.50, 2.1][difficultyIndex(this.config.difficulty)];
      if (active.remaining > 0) continue;

      const order = active.order;
      this.activeAutoBuilds.splice(i, 1);

      if (order.kind === 'conduit') {
        this.reservedCells.delete(cellKey(order.cx, order.cy));
        if (state.isConduitPlacementCellClear(order.cx, order.cy).valid) {
          state.grid.addConduit(order.cx, order.cy, this.team);
        } else if (!state.grid.hasConduit(order.cx, order.cy)) {
          this.claimedConduitKeys.delete(cellKey(order.cx, order.cy));
        }
        state.power.markDirty();
        continue;
      }

      this.releaseOrderReservation(order);
      if (!state.getStructureFootprintStatus(order.def, order.cx, order.cy).valid) continue;
      const ent = createBuildingFromDef(order.def, footprintCenter(order.cx, order.cy, order.def.footprintCells), this.team);
      if (ent.buildProgress < 1) ent.buildProgress = 0.05;
      state.addEntity(ent);
      state.applyConfluencePlacement(this.team, ent.position, String(ent.id));
      this.buildsPlaced++;
      state.recentEnemyConstructions.push({
        pos: ent.position.clone(),
        time: state.gameTime,
      });
      state.power.markDirty();
      if (ent instanceof Shipyard) {
        this.emitPlannerChat([
          'Shipyard online - fighters launching soon!',
          'Ship production facility constructed!',
          'Our shipyard is operational. Prepare for our fleet.',
          'Fighter yard complete - reinforcements incoming!',
        ]);
      } else if (ent instanceof PowerGenerator) {
        this.emitPlannerChat([
          'Power generator online - base expanding.',
          'New power grid sector activated.',
          'Energy infrastructure complete.',
        ]);
      }
      this.markBuildingPlaced(order.cx, order.cy);
      this.enqueueProtectiveWallsForBuilding(state, order.cx, order.cy, order.def);
    }
  }

  private markBuildingPlaced(cx: number, cy: number): void {
    const k = cellKey(cx, cy);
    for (const ring of this.rings) {
      for (const slot of ring.buildingSlots) {
        if (cellKey(slot.cx, slot.cy) === k) {
          slot.placed = true;
          slot.queued = true;
          return;
        }
      }
    }
    for (const bastion of this.bastions) {
      if (bastion.generatorSlot
          && cellKey(bastion.generatorSlot.cx, bastion.generatorSlot.cy) === k) {
        return;
      }
      for (const ts of bastion.turretSlots) {
        if (cellKey(ts.cx, ts.cy) === k) {
          ts.placed = true;
          return;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Builder lifecycle
  // ---------------------------------------------------------------------------

  livingBuilders(): number {
    this.builders = this.builders.filter((b) => b.alive);
    return this.builders.length;
  }

  private processBuilderRebuilds(state: GameState, cp: CommandPost, dt: number): void {
    for (const b of this.builders) {
      if (!b.alive && b.buildOrder) this.releaseOrderReservation(b.buildOrder);
    }
    this.builders = this.builders.filter((b) => b.alive);
    this.rebuildTimers.length = 0;
  }

  private spawnBuilder(state: GameState, cp: CommandPost): void {
    const drone = new BuilderDrone(cp.position.clone(), this.team, 'build');
    const idx   = difficultyIndex(this.config.difficulty);
    drone.speedMul     = [0.85, 1.0, 1.15, 1.30, 1.50, 2.0][idx] * this.config.enemyBuildSpeedMul;
    drone.buildSpeedMul = drone.speedMul;
    state.addEntity(drone);
    this.builders.push(drone);
  }

  // ---------------------------------------------------------------------------
  // Coordinator interface (used by VsAIDirector)
  // ---------------------------------------------------------------------------

  /** Returns the world position most in need of defense, or null. */
  getHighestPriorityDefensePoint(state: GameState): Vec2 | null {
    let best: Vec2 | null = null;
    let bestScore = 0; // only return if actually damaged
    for (const b of state.buildings) {
      if (!b.alive || b.team !== this.team) continue;
      const p = b instanceof PowerGenerator ? 3
        : b instanceof CommandPost ? 5
        : b instanceof Shipyard    ? 2
        : b instanceof TurretBase  ? 1
        : 0;
      const score = p * (1 - b.healthFraction) * 100;
      if (score > bestScore) { bestScore = score; best = b.position.clone(); }
    }
    return best;
  }

  /** Returns world positions of active construction sites. */
  getActiveConstructionSites(): Vec2[] {
    const activeSites = this.activeAutoBuilds.map((b) => cellCenter(b.order.cx, b.order.cy));
    const queuedStructure = this.queue
      .filter((order) => order.kind === 'building')
      .slice(0, 4)
      .map((order) => cellCenter(order.cx, order.cy));
    return activeSites.concat(queuedStructure).concat(this.builders
      .filter((b) => b.alive && b.buildOrder !== null)
      .map((b) => cellCenter(b.buildOrder!.cx, b.buildOrder!.cy)));
  }

  getNearestPendingConstructionSite(from: Vec2): Vec2 | null {
    let best: Vec2 | null = null;
    let bestDist = Infinity;
    const consider = (pos: Vec2): void => {
      const d = pos.distanceTo(from);
      if (d < bestDist) {
        bestDist = d;
        best = pos;
      }
    };
    for (const active of this.activeAutoBuilds) consider(cellCenter(active.order.cx, active.order.cy));
    for (const order of this.queue) {
      if (order.kind !== 'building') continue;
      consider(cellCenter(order.cx, order.cy));
    }
    return best;
  }

  /**
   * Returns the center of the innermost ring that still has conduit cells
   * left to queue — indicates where expansion is currently lagging.
   */
  getWeakestRingSegment(): Vec2 | null {
    for (const ring of this.rings) {
      if (ring.conduitQueuePtr < ring.conduitCells.length) {
        return cellCenter(this.centerCx, this.centerCy + ring.radiusCells);
      }
    }
    return null;
  }

  /** Returns the hostile building most valuable to attack (for VsAIDirector harass). */
  getSuggestedHarassTarget(state: GameState): Vec2 | null {
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (const b of state.buildings) {
      if (!b.alive || !isHostile(this.team, b.team)) continue;
      const s = b instanceof PowerGenerator ? 5
        : b instanceof Shipyard   ? 4
        : b instanceof ResearchLab ? 3
        : b instanceof Factory     ? 2
        : b instanceof CommandPost ? 1
        : 0;
      if (s > bestScore) { bestScore = s; best = b.position.clone(); }
    }
    return best;
  }

  getCurrentDoctrine(): DoctrineType { return this.doctrineType; }

  getActiveRaidTarget(): Vec2 | null { return this.raidPlanner.getActiveTarget(); }

  // ---------------------------------------------------------------------------
  // Strategic interface (called by PracticeMode)
  // ---------------------------------------------------------------------------

  /**
   * Set the urgency level for offensive production.
   *   0 = normal behaviour.
   *   1 = elevated — AI has failed several waves; boost shipyard priority.
   *   2 = high — AI is stalling hard; shipyards jump above almost everything.
   */
  setStrategicUrgency(level: number): void {
    this.urgencyLevel = Math.max(0, Math.min(2, Math.round(level)));
  }

  /** Notify the planner that an attack wave launched (resets stagnation timer). */
  notifyAttackLaunched(): void {
    this.secsSinceLastAttack = 0;
  }

  /** Update the planner's view of the player's strategic profile. */
  notifyPlayerThreat(strategy: PlayerStrategy, shipyardCount: number, turretCount: number, researchCount: number): void {
    this.playerThreat = { strategy, shipyardCount, turretCount, researchCount, lastEval: 0 };
  }

  /** How many alive, powered, finished shipyards this AI team has. */
  getShipyardCount(state: GameState): number {
    return this.countEnemyBuildings(
      state,
      (b) => b instanceof Shipyard && b.powered && b.buildProgress >= 1,
    );
  }

  /**
   * Target shipyard count based on difficulty and game time.
   * This is what the AI is trying to build towards.
   */
  getTargetShipyardCount(state: GameState): number {
    const idx = difficultyIndex(this.config.difficulty);
    const urgencyBonus = this.urgencyLevel;
    // Cap at +4 to match the backfill timeBonus cap (prevents unreachable targets).
    const timeBonus = idx >= 2 ? Math.min(4, Math.floor(state.gameTime / 180)) : 0;
    // Base: Easy=1, Normal=3, Hard=5, Expert=7, Nightmare=10, Zenith=16 + time + urgency
    return [1, 3, 5, 7, 10, 16][idx] + urgencyBonus + timeBonus;
  }

  // ---------------------------------------------------------------------------
  // Anti-stall: force shipyard scaling when below target
  // ---------------------------------------------------------------------------

  /**
   * Periodically called from update(). When the AI has been below its target
   * shipyard count and has the resources, inject a fighter-yard build order
   * near the front of the queue so it doesn't sit idle.
   */
  private maybeForceShipyardScaling(state: GameState, availableResources: number): void {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx < 2) return; // Only Hard+ gets this treatment

    // Check every 15 seconds (or sooner when urgent).
    const checkInterval = this.urgencyLevel >= 1 ? 8 : 15;
    if (this.shipyardScaleTimer < checkInterval) return;
    this.shipyardScaleTimer = 0;

    const current = this.getShipyardCount(state);
    const target  = this.getTargetShipyardCount(state);
    if (current >= target) return;

    const forcedKey = this.forcedShipyardBuildKey(state);
    const def = getBuildDef(forcedKey);
    if (!def) return;
    if (availableResources < def.cost) return;

    // Check we're not already queuing one.
    const alreadyQueued =
      this.queue.filter((o) => o.kind === 'building' && o.def.key === forcedKey).length +
      this.activeAutoBuilds.filter((a) => a.order.kind === 'building' && a.order.def.key === forcedKey).length;
    if (alreadyQueued >= 2) return;

    // Find a valid location in the accessible rings.
    const maxRing = Math.min(this.currentRing, this.rings.length - 1);
    for (let r = maxRing; r >= 0; r--) {
      const ring = this.rings[r];
      const attempts = Math.max(12, ring.conduitCells.length);
      for (let n = 0; n < attempts; n++) {
        const h = Math.floor(
          hash01plan(this.seed + 31337, r * 103 + n + this.buildsPlaced, 4242) *
            Math.max(1, ring.conduitCells.length),
        );
        const anchor = ring.conduitCells[h];
        if (!anchor) continue;
        const cell = this.findBestBuildingCell(state, anchor.cx, anchor.cy, def, ring);
        if (!cell) continue;
        const k = `${forcedKey}:${cellKey(cell.cx, cell.cy)}`;
        if (this.backfillKeys.has(k)) continue;
        this.backfillKeys.add(k);
        this.claimedBuildingKeys.add(cellKey(cell.cx, cell.cy));
        this.reserveBuildingFootprint(def, cell.cx, cell.cy);
        // Inject near the front of the queue (after any active conduit orders).
        const insertAt = Math.min(2, this.queue.length);
        this.queue.splice(insertAt, 0, { kind: 'building', cx: cell.cx, cy: cell.cy, def, layConduitFirst: false });
        return;
      }
    }
  }

  private forcedShipyardBuildKey(state: GameState): string {
    const idx = difficultyIndex(this.config.difficulty);
    if (idx >= 3 && this.canAIUseAdvancedYard('swarmyard')) {
      const target = this.targetSwarmYardCount(state);
      const current = this.countEnemyBuildingsByKey(state, 'swarmyard') + this.queuedBuildingCount('swarmyard');
      if (current < target) return 'swarmyard';
    }
    if (this.canAIUseAdvancedYard('bomberyard')) {
      const target = [0, 0, 5, 5, 5, 5][idx];
      const current = this.countEnemyBuildingsByKey(state, 'bomberyard') + this.queuedBuildingCount('bomberyard');
      if (current < target) return 'bomberyard';
    }
    return 'fighteryard';
  }

  // ---------------------------------------------------------------------------
  // Reactive turret selection
  // ---------------------------------------------------------------------------

  /**
   * Choose the best turret type for a given ring slot based on the player's
   * observed strategy.  Called from `replacementForRedundantGenerator` and
   * can also be used by ring-slot placement logic.
   */
  private chooseTurretForSlot(ring: RingPlan): string {
    const idx = difficultyIndex(this.config.difficulty);
    const { strategy, shipyardCount, researchCount } = this.playerThreat;
    if (strategy === 'swarming' || shipyardCount >= 4) {
      return this.mixedTurretChoice(ring, ['massdriverturret', 'gatlingturret', 'missileturret']);
    }
    if (strategy === 'teching' || researchCount >= 3) {
      return this.mixedTurretChoice(ring, ['exciterturret', 'gatlingturret', 'missileturret']);
    }
    if (strategy === 'rushing') {
      return this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret', 'gatlingturret']);
    }
    if (strategy === 'turtling') {
      return this.mixedTurretChoice(ring, ['missileturret', 'exciterturret', 'gatlingturret']);
    }
    if (ring.role === 'innerDefense') {
      return idx >= 3
        ? this.mixedTurretChoice(ring, ['missileturret', 'gatlingturret', 'massdriverturret'])
        : this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret']);
    }
    if (ring.role === 'picket' || ring.role === 'forward') {
      return this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret', 'exciterturret']);
    }
    return this.mixedTurretChoice(ring, ['gatlingturret', 'missileturret']);
  }

  private mixedTurretChoice(ring: RingPlan, pool: string[]): string {
    if (pool.length === 0) return 'missileturret';
    const salt = ring.ringIndex * 31 + this.buildsPlaced * 7 + this.queue.length + this.activeAutoBuilds.length;
    const pick = Math.floor(hash01plan(this.seed + 9091, salt, difficultyIndex(this.config.difficulty) + 17) * pool.length);
    return pool[Math.max(0, Math.min(pool.length - 1, pick))];
  }

  private chooseLegacyTurretForSlot(ring: RingPlan): string {
    const idx = difficultyIndex(this.config.difficulty);
    // Lower difficulties use the doctrine default (missile turrets).
    if (idx < 2) return ring.role === 'innerDefense' ? 'missileturret' : 'exciterturret';

    const { strategy, shipyardCount, researchCount } = this.playerThreat;

    // Player is swarming (many shipyards, few upgrades) → mass drivers are best.
    if (strategy === 'swarming' || shipyardCount >= 4) return 'massdriverturret';
    // Player is teching (few yards, many upgrades) → exciter turrets shut down the player ship.
    if (strategy === 'teching' || researchCount >= 3) return 'exciterturret';
    // Player is turtling → stay offensive; minimal extra turrets.
    if (strategy === 'turtling') return 'missileturret';
    // Default mixed defence.
    return ring.role === 'innerDefense' ? 'massdriverturret' : 'exciterturret';
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  private snapshotPlacedBuildingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const ring of this.rings) {
      for (const slot of ring.buildingSlots) {
        if (!slot.placed) continue;
        counts[slot.buildingKey] = (counts[slot.buildingKey] ?? 0) + 1;
      }
    }
    return counts;
  }

  private snapshotQueuedBuildingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const order of this.queue) {
      if (order.kind !== 'building') continue;
      counts[order.def.key] = (counts[order.def.key] ?? 0) + 1;
    }
    for (const active of this.activeAutoBuilds) {
      const order = active.order;
      if (order.kind !== 'building') continue;
      counts[order.def.key] = (counts[order.def.key] ?? 0) + 1;
    }
    return counts;
  }

  snapshot(): PlannerSnapshot {
    const totalCells  = this.rings.reduce((s, r) => s + r.conduitCells.length, 0);
    const queuedCells = this.rings.reduce((s, r) => s + r.conduitQueuePtr, 0);
    return {
      currentRing:          this.currentRing,
      buildsPlaced:         this.buildsPlaced,
      builderCount:         this.livingBuilders(),
      queueSize:            this.queue.length + this.activeAutoBuilds.length,
      doctrine:             this.doctrineType,
      ringCount:            this.rings.length,
      conduitProgress:      totalCells > 0 ? queuedCells / totalCells : 0,
      urgencyLevel:         this.urgencyLevel,
      targetShipyardCount:  0, // filled in by PracticeMode using getTargetShipyardCount()
      currentShipyardCount: 0, // filled in by PracticeMode using getShipyardCount()
      playerStrategy:       this.playerThreat.strategy,
      secsSinceLastAttack:  this.secsSinceLastAttack,
      buildingCounts:       this.snapshotPlacedBuildingCounts(),
      queuedBuildingCounts: this.snapshotQueuedBuildingCounts(),
    };
  }
}
