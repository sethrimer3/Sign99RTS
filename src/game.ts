/** Main game coordinator for Sign99 */

import { Vec2 } from './math.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Camera } from './camera.js';
import { GameState } from './gamestate.js';
import { Starfield } from './starfield.js';
import { Nebula } from './nebula.js';
import { drawEdgeIndicators, drawRadarOverlay } from './radar.js';
import { ActionMenu, MenuResult, researchDisplayName } from './actionmenu.js';
import { HUD } from './hud.js';
import { MainMenu, MenuAction } from './menu.js';
import { Colors, colorToCSS } from './colors.js';
import { Team, EntityType, ShipGroup, Entity } from './entities.js';
import { DT, WORLD_WIDTH, WORLD_HEIGHT, RESEARCH_COST, RESEARCH_TIME, RESEARCH_MODE, TICK_RATE, WEAPON_STATS, ACTIVE_RESEARCH_ITEMS, SHIP_STATS, BASELINE_RESOURCE_GAIN, RESOURCE_GAIN_RATE } from './constants.js';
import { BuildingBase, CommandPost, Factory, ResearchLab, ShieldGenerator } from './building.js';
import { Shipyard } from './building.js';
import { EnemyBasePlanner } from './enemybaseplanner.js';
import { TurretBase } from './turret.js';
import { FighterShip, BomberShip, SynonymousFighterShip, SynonymousNovaBomberShip, SwarmShip, FIGHTER_UPGRADE_RESEARCH_KEYS, applyFighterResearchUpgrade } from './fighter.js';
import { Bullet } from './projectile.js';
import { GuidedMissile } from './projectile.js';
import { PracticeMode } from './practicemode.js';
import { cloneDefaultPracticeConfig, difficultyIndex, type DifficultyName } from './practiceconfig.js';
import { TutorialMode } from './tutorial.js';
import { AIShip, VsAIDirector } from './vsaibot.js';
import { PlayerShip } from './ship.js';
import { teamForSlot } from './teamutils.js';
import { createMultiplayerSpawns } from './multiplayerSpawns.js';
import { worldToCell, footprintCenter, GRID_CELL_SIZE } from './grid.js';
import { footprintForBuildingType } from './buildingfootprint.js';
import { gameFont } from './fonts.js';
import { createSpaceFluid, SpaceFluid } from './spacefluid.js';
import type { LanClient } from './lan/lanClient.js';
import type { MsgMatchStart, MsgRelayedInput, SerializedShip, SerializedBuilding, SerializedFighter, SerializedProjectile, SerializedTerritoryCircle } from './lan/protocol.js';
import { createBuildingFromDef, getBuildDef, buildDefForEntityType } from './builddefs.js';
import { isConfluenceFaction, isSynonymousFaction, resolveRaceSelection, type FactionType, CONFLUENCE_PLACEMENT_DISTANCE, CONFLUENCE_PLACEMENT_TOLERANCE, CONFLUENCE_BASE_RADIUS } from './confluence.js';
import { SYNONYMOUS_BUILD_COST, SYNONYMOUS_CURRENCY_SYMBOL } from './synonymous.js';
import {
  cloneDefaultVsAIConfig,
  rankedCheaterModifierCount,
  rankedDifficultyName,
  rankedScore,
  rankedScoreMultiplier,
  SURVIVAL_RANKED_SCORE_KEY,
  VSAI_RANKED_SCORE_KEY,
} from './vsaiconfig.js';
import { GlowLayer } from './glowlayer.js';
import { DEFAULT_VISUAL_QUALITY, VISUAL_QUALITY_PRESETS, type VisualQuality, type VisualQualityPreset, loadVisualQuality, saveVisualQuality } from './visualquality.js';
import { loadCinematicLevel, saveCinematicLevel, setCinematicLevel, type CinematicLevel } from './cinematic.js';
import { loadLegacyGraphics, saveLegacyGraphics, setLegacyGraphics } from './graphicsmode.js';
import { setProjectileTrailLayers } from './projectileTrail.js';
import {
  drawCombatTargetingDebug, drawConfluenceTerritory, drawDebugOverlay, drawWaypointMarkers, drawBaseTerritoryGlow, drawBaseLockwardEffect, type ShipCommandGroup, type WaypointMarker,
} from './gameRender.js';
import { renderBudget } from './renderBudget.js';
import type { NetInputSnapshot, NetGameSnapshot } from './net/protocol.js';
import type { MultiplayerTransport } from './net/transport.js';
import { findClosestEnemy } from './combatUtils.js';
import { injectFluidForces } from './fluidForces.js';
import { injectCrystalDisturbances } from './fluidForces.js';
import { CrystalNebula } from './crystalnebula.js';
import { DistantSuns } from './suns.js';
import { AsteroidField } from './asteroidField.js';
import { StarNestBackground } from './starNestBackground.js';
import { activeSpaceColor } from './spaceTheme.js';
import { fireTurretShots } from './turretCombat.js';
import { updateFighterWeaponFire } from './fighterCombat.js';
import { updatePlayerFiring, updateGuidedMissileControl } from './weaponFiring.js';
import {
  type OverlayCache,
  createOverlayCache,
  buildingEffectRange,
  drawGhostSpectator,
  drawLossOverlay,
  drawCommandModeOverlay,
  drawBuildingHoverHitpoints,
  drawGlowLayer,
  drawScreenOverlays,
} from './gameOverlays.js';
import {
  type CommandModeCtx,
  type CommandModeState,
  createCommandModeState,
  issueShipOrder,
  updateCommandMode,
  updateNumberGroupHotkeys,
  updatePlayerFighterOrderTargets,
} from './commandMode.js';
import {
  type PlayerRespawnRuntime,
  type AIRespawnRuntime,
  createPlayerRespawnRuntime,
  createAIRespawnRuntime,
  resetRespawnRuntime,
  updatePlayerRespawn,
  updateAIShipRespawn,
  updateGhostSpectator,
} from './respawnRuntime.js';
import { FighterGroupStatusUI } from './fighterGroupStatus.js';

type GamePhase = 'menu' | 'playing' | 'paused';
type PersistentGroupOrder = 'waypoint' | 'follow' | 'protect';

/** Per-slot base-growth state for a LAN AI, mirroring PracticeMode's single-base runtime. */
interface LanAiBase {
  team: Team;
  cp: CommandPost;
  planner: EnemyBasePlanner;
  difficulty: DifficultyName;
  resources: number;
  tickTimer: number;
}
const LAN_AI_BASE_TICK_INTERVAL = 0.5;
/** Income multiplier per difficulty index, matching PracticeMode's curve. */
const LAN_AI_INCOME_MUL_BY_DIFFICULTY = [0.55, 0.8, 1.0, 1.2, 1.45, 1.85];

const PLAYER_FIRE_COOLDOWN = WEAPON_STATS.fire.fireRate * DT;
const MAX_FIXED_UPDATES_PER_FRAME = 5;
const GAME_ZOOM_KEY = 'sign99.gameZoom';
const UI_ZOOM_KEY = 'sign99.uiZoom';
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 1.75;

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private camera: Camera;
  private state: GameState;
  private starfield: Starfield;
  private nebula: Nebula;
  private actionMenu: ActionMenu;
  private hud: HUD;
  private mainMenu: MainMenu;

  private practiceMode: PracticeMode;
  private tutorialMode: TutorialMode;
  /** Director for the Vs. AI mode — null in any other mode. */
  private vsAIDirector: VsAIDirector | null = null;
  private rankedVsAIResultRecorded = false;

  private phase: GamePhase = 'menu';
  private lastTimestamp: number = 0;
  private accumulator: number = 0;
  private running: boolean = false;
  private debugOverlay = false;
  private lastFrameMs = 0;
  private lastFixedUpdateMs = 0;
  private lastRenderMs = 0;
  private waypointMarkers = new Map<ShipCommandGroup, WaypointMarker>();
  private lastGroupOrders = new Map<ShipCommandGroup, PersistentGroupOrder>();
  private commandModeState: CommandModeState = createCommandModeState();
  private readonly boundIssueShipOrder = (
    group: ShipCommandGroup,
    order: string,
    targetOverride?: Vec2,
  ): void => this.issuePersistentShipOrder(group, order, targetOverride);
  /**
   * Accumulates total dt between fighter exhaust emissions.
   * Fighter exhaust is rate-limited (not every tick) to reduce particle count at scale.
   */
  private fighterExhaustAccum: number = 0;
  private activeGuidedMissile: GuidedMissile | null = null;
  private spaceFluid: SpaceFluid;
  private glowLayer: GlowLayer;
  private crystalNebula: CrystalNebula;
  private distantSuns: DistantSuns;
  private asteroidField: AsteroidField;
  private starNest: StarNestBackground;
  private visualQuality: VisualQuality = DEFAULT_VISUAL_QUALITY;
  private cinematicLevel: CinematicLevel = 1;
  private legacyGraphics: boolean = false;
  private visualPreset: VisualQualityPreset = VISUAL_QUALITY_PRESETS[DEFAULT_VISUAL_QUALITY];
  private gameZoom: number = 1.0;
  private uiZoom: number = 1.0;
  private overlayCache: OverlayCache = createOverlayCache();
  /** Counts down after the player takes damage; drives the red-edge damage flash. */
  private damageFlashTimer: number = 0;
  /** Player health at the end of the last fixed tick (used to detect damage events). */
  private playerPrevHealth: number = -1;
  /** Accumulated game time used for territory pulse animations. */
  private territoryPulseTime: number = 0;
  /** Cached deep-space background gradient (rebuilt on resize). */
  private bgGradient: CanvasGradient | null = null;
  private bgGradientW = 0;
  private bgGradientH = 0;
  private bgGradientKey = '';

  private playerRespawn: PlayerRespawnRuntime = createPlayerRespawnRuntime();
  /** Delay (seconds) before the player ship respawns. */
  private static readonly RESPAWN_DELAY = 3;
  private aiRespawn: AIRespawnRuntime = createAIRespawnRuntime();
  private static readonly AI_RESPAWN_DELAY = 8;
  /** Interval (seconds) between fighter exhaust particle emissions (~30 Hz). */
  private static readonly FIGHTER_EXHAUST_EMIT_INTERVAL = 1 / 30;
  private fighterGroupStatus: FighterGroupStatusUI = new FighterGroupStatusUI();

  // LAN multiplayer
  private lanClient: LanClient | null = null;
  /** Active online (WebRTC) transport, set when an online match is running. */
  private onlineTransport: MultiplayerTransport | null = null;
  /** Slot assigned to this client (0 = host). */
  private lanMySlot: number = 0;
  /** Snapshot sequence counter for outgoing snapshots. */
  private lanSnapshotSeq: number = 0;
  /** Countdown until next snapshot broadcast (host only). */
  private lanSnapshotTimer: number = 0;
  /** Interval (seconds) between host snapshots. */
  private static readonly SNAPSHOT_INTERVAL = 1 / 20; // 20 Hz
  /** Per-slot remote input buffer (filled by relayed_input from server). */
  private lanRemoteInputs: Map<number, { dx: number; dy: number; aimX: number; aimY: number; firePrimary: boolean; fireSpecial: boolean; boost: boolean }> = new Map();
  /** Input sequence counter for outgoing input snapshots. */
  private lanInputSeq: number = 0;
  /**
   * AI directors for LAN AI slots (host-only).
   * Each entry drives one AIShip for a configured AI lobby slot.
   */
  private lanAiDirectors: VsAIDirector[] = [];
  /**
   * Base planners for LAN AI slots (host-only), one per AI slot's own
   * command post. Each grows/defends that slot's base independently and
   * feeds coordination data (defense points, harass targets, construction
   * sites) back to the matching VsAIDirector via `director.planner`.
   */
  private lanAiBases: LanAiBase[] = [];
  /** Last received snapshot seq (client-only, for debug). */
  private lanLastSnapshotSeq: number = -1;
  /**
   * Client-side prediction correction vector.
   * When the host authoritative position for our ship differs from our local
   * prediction, this offset is added to the ship position and decayed to zero
   * over LAN_PREDICTION_BLEND_SECS seconds for smooth visual correction.
   */
  private lanPredictionOffset: { x: number; y: number } = { x: 0, y: 0 };
  /** Remaining fraction of prediction correction offset still to be blended out. */
  private lanPredictionOffsetAlpha: number = 0;
  /**
   * Distance threshold (world units) above which the local ship position is
   * snapped immediately to host state rather than being blended smoothly.
   */
  private static readonly LAN_PREDICTION_SNAP_THRESHOLD = 300;
  /** Duration (seconds) over which prediction corrections are blended out. */
  private static readonly LAN_PREDICTION_BLEND_SECS = 0.25;
  /**
   * Minimum error magnitude (world units) required to start accumulating a
   * prediction correction offset.  Errors smaller than this are ignored to
   * avoid micro-corrections from floating-point drift.
   */
  private static readonly LAN_PREDICTION_MIN_BLEND_THRESHOLD = 4;
  /**
   * How much of the new prediction error is added to the running blend offset
   * each time a snapshot arrives.  Higher = converges faster but may look
   * less smooth.
   */
  private static readonly LAN_PREDICTION_ALPHA_INCREMENT = 0.4;
  /**
   * Fraction of velocity difference applied per snapshot to nudge the local
   * ship's velocity toward the host-authoritative value.
   */
  private static readonly LAN_PREDICTION_VELOCITY_BLEND = 0.15;
  /**
   * Fraction of projectile position error blended per snapshot update.
   * 0.5 = half the error corrected each update (50 ms at 20 Hz).
   */
  private static readonly LAN_PROJECTILE_POSITION_BLEND = 0.5;
  /**
   * Maximum number of unacknowledged input frames kept for prediction replay.
   * At 60 Hz, 120 frames = 2 seconds of history (generous for any realistic ping).
   */
  private static readonly LAN_INPUT_RING_MAX = 120;

  /**
   * Ring buffer of local inputs not yet acknowledged by the host (client-only).
   * Each entry mirrors the fields sent in MsgInputSnapshot plus seq.
   * On snapshot arrival the host's lastProcessedInputSeqBySlot is used to
   * prune acknowledged entries, then remaining inputs are replayed on top of
   * the corrected authoritative ship state.
   */
  private lanUnacknowledgedInputs: Array<{
    seq: number; dx: number; dy: number;
    aimX: number; aimY: number; boost: boolean;
  }> = [];

  /**
   * Host-side: tracks the latest input seq acknowledged per slot.
   * Used to populate lastProcessedInputSeqBySlot in the outgoing snapshot.
   */
  private lanLastProcessedSeqPerSlot: Map<number, number> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    this.camera = new Camera();
    this.state = new GameState();
    this.starfield = new Starfield();
    this.nebula = new Nebula();
    this.actionMenu = new ActionMenu();
    this.hud = new HUD();
    this.mainMenu = new MainMenu();
    this.practiceMode = new PracticeMode();
    this.tutorialMode = new TutorialMode();

    this.spaceFluid = createSpaceFluid();
    this.glowLayer = new GlowLayer();
    this.crystalNebula = new CrystalNebula();
    this.distantSuns = new DistantSuns();
    // Asteroid sprites are generated here (once). Placement is seeded and deterministic.
    this.asteroidField = new AsteroidField();
    this.starNest = new StarNestBackground();
    this.spaceFluid.resize(window.innerWidth, window.innerHeight);
    this.applyVisualQuality(loadVisualQuality());
    this.applyCinematicLevel(loadCinematicLevel());
    this.applyLegacyGraphics(loadLegacyGraphics());
    this.applyZoomSettings(loadZoomSetting(GAME_ZOOM_KEY), loadZoomSetting(UI_ZOOM_KEY));

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.setScreenSize(window.innerWidth, window.innerHeight);
    this.camera.zoom = this.gameZoom;
    this.spaceFluid.resize(window.innerWidth, window.innerHeight);
    this.glowLayer.resize(window.innerWidth, window.innerHeight);
    this.crystalNebula.resize(window.innerWidth, window.innerHeight);
    this.starNest.resize(window.innerWidth, window.innerHeight);
    // Invalidate overlay gradient cache so drawScreenOverlays rebuilds it at the new size.
    this.overlayCache = createOverlayCache();
  }

  private applyVisualQuality(quality: VisualQuality): void {
    this.visualQuality = quality;
    this.visualPreset = VISUAL_QUALITY_PRESETS[quality];
    this.spaceFluid.setLowGraphicsMode(this.visualPreset.fluidLowGraphics);
    this.glowLayer.configure(this.visualPreset.glowEnabled, this.visualPreset.glowScale);
    this.crystalNebula.configure(this.visualPreset);
    this.distantSuns.configure(this.visualPreset);
    this.asteroidField.configure(this.visualPreset);
    this.starNest.configure(this.visualPreset);
    this.state?.ringEffects.setMaxLive(
      quality === 'ultraLow' ? 16 : quality === 'low' ? 32 : quality === 'medium' ? 64 : 96,
    );
    this.state?.particles.setParticleScale(this.visualPreset.particleScale);
    this.starfield.setShootingStarsEnabled(this.visualPreset.shootingStarsEnabled);
    setProjectileTrailLayers(quality === 'high' ? 3 : quality === 'medium' ? 2 : 1);
    this.mainMenu.visualQuality = quality;
    saveVisualQuality(quality);
  }

  private applyLegacyGraphics(legacy: boolean): void {
    this.legacyGraphics = setLegacyGraphics(legacy);
    this.mainMenu.legacyGraphics = this.legacyGraphics;
    saveLegacyGraphics(this.legacyGraphics);
  }

  private applyCinematicLevel(level: CinematicLevel): void {
    this.cinematicLevel = setCinematicLevel(level);
    this.mainMenu.cinematicLevel = this.cinematicLevel;
    saveCinematicLevel(this.cinematicLevel);
  }

  private applyZoomSettings(gameZoom: number, uiZoom: number): void {
    this.gameZoom = clampZoom(gameZoom);
    this.uiZoom = clampZoom(uiZoom);
    this.camera.zoom = this.gameZoom;
    this.mainMenu.gameZoom = this.gameZoom;
    this.mainMenu.uiZoom = this.uiZoom;
    saveZoomSetting(GAME_ZOOM_KEY, this.gameZoom);
    saveZoomSetting(UI_ZOOM_KEY, this.uiZoom);
  }

  private get screenW(): number {
    return window.innerWidth;
  }

  private get screenH(): number {
    return window.innerHeight;
  }

  /** Start the game loop. */
  start(): void {
    this.running = true;
    this.lastTimestamp = performance.now();
    this.mainMenu.openTitle();
    Audio.playMenuMusic();
    Audio.loadSounds();
    requestAnimationFrame((t) => this.loop(t));
  }

  private loop(timestamp: number): void {
    if (!this.running) return;

    const rawDt = (timestamp - this.lastTimestamp) / 1000;
    // Clamp to avoid spiral of death on tab-away
    const frameDt = Math.min(rawDt, 0.25);
    this.lastFrameMs = frameDt * 1000;
    this.lastTimestamp = timestamp;

    this.accumulator += frameDt;

    // Fixed-timestep update at 60 Hz.
    // Input.update() is called after each fixed tick so that per-frame events
    // (wasPressed, doubleTapped, etc.) are never dropped at high frame rates
    // and are never processed more than once.
    let fixedUpdates = 0;
    const fixedStart = performance.now();
    while (this.accumulator >= DT && fixedUpdates < MAX_FIXED_UPDATES_PER_FRAME) {
      this.fixedUpdate();
      Input.update();
      this.accumulator -= DT;
      fixedUpdates++;
    }
    this.lastFixedUpdateMs = performance.now() - fixedStart;
    if (fixedUpdates === MAX_FIXED_UPDATES_PER_FRAME && this.accumulator >= DT) {
      this.accumulator = 0;
    }

    const renderStart = performance.now();
    this.render();
    this.lastRenderMs = performance.now() - renderStart;

    // Update adaptive performance budget with raw frame timings
    renderBudget.update(this.lastFrameMs, this.lastFixedUpdateMs, this.lastRenderMs);
    // Wire adaptive scale into particle system
    this.state.particles.setAdaptiveScale(renderBudget.renderLoadScale);

    requestAnimationFrame((t) => this.loop(t));
  }

  // -----------------------------------------------------------------------
  // Fixed-timestep update (60 Hz)
  // -----------------------------------------------------------------------

  private fixedUpdate(): void {
    switch (this.phase) {
      case 'menu':
        this.updateMenu();
        break;
      case 'playing':
        this.updatePlaying();
        break;
      case 'paused':
        this.updatePaused();
        break;
    }
  }

  private updateMenu(): void {
    // Forward typed characters to the join screen text fields.
    if (Input.typedChars) {
      for (const ch of Input.typedChars) {
        this.mainMenu.appendJoinChar(ch);
      }
    }
    const action = this.mainMenu.update(DT, this.screenW, this.screenH);
    if (this.mainMenu.visualQuality !== this.visualQuality) {
      this.applyVisualQuality(this.mainMenu.visualQuality);
    }
    this.syncCinematicLevelFromMenu();
    this.syncLegacyGraphicsFromMenu();
    this.syncZoomSettingsFromMenu();
    this.handleMenuAction(action);
  }

  private updatePaused(): void {
    const action = this.mainMenu.update(DT, this.screenW, this.screenH);
    if (this.mainMenu.visualQuality !== this.visualQuality) {
      this.applyVisualQuality(this.mainMenu.visualQuality);
    }
    this.syncCinematicLevelFromMenu();
    this.syncLegacyGraphicsFromMenu();
    this.syncZoomSettingsFromMenu();
    this.handleMenuAction(action);
  }

  private syncZoomSettingsFromMenu(): void {
    if (this.mainMenu.gameZoom !== this.gameZoom || this.mainMenu.uiZoom !== this.uiZoom) {
      this.applyZoomSettings(this.mainMenu.gameZoom, this.mainMenu.uiZoom);
    }
  }

  private syncLegacyGraphicsFromMenu(): void {
    if (this.mainMenu.legacyGraphics !== this.legacyGraphics) {
      this.applyLegacyGraphics(this.mainMenu.legacyGraphics);
      this.hud.showMessage(
        this.legacyGraphics ? 'Legacy Graphics: ON' : 'Legacy Graphics: OFF',
        Colors.general_building,
        2,
      );
    }
  }

  private syncCinematicLevelFromMenu(): void {
    if (this.mainMenu.cinematicLevel !== this.cinematicLevel) {
      this.applyCinematicLevel(this.mainMenu.cinematicLevel);
      this.hud.showMessage(
        `Cinematic effects: ${this.cinematicLevel}`,
        Colors.general_building,
        2,
      );
    }
  }

  private handleMenuAction(action: MenuAction): void {
    switch (action) {
      case 'tutorial':
        this.startGame('tutorial');
        break;
      case 'start_practice':
        this.startGame('practice');
        break;
      case 'start_vs_ai':
        this.startGame('vs_ai');
        break;
      case 'start_lan_host':
      case 'start_lan_client': {
        const matchStart = this.mainMenu.takePendingLanMatchStart();
        if (matchStart) {
          this.startLanGame(matchStart, action === 'start_lan_host');
        }
        break;
      }
      case 'start_online_host':
      case 'start_online_client': {
        const pending = this.mainMenu.takePendingOnlineMatchStart();
        if (pending) {
          this.startOnlineGame(pending.transport, pending.matchStart, action === 'start_online_host');
        }
        break;
      }
      case 'resume':
        this.phase = 'playing';
        this.mainMenu.close();
        break;
      case 'quit_to_menu':
        this.phase = 'menu';
        this.mainMenu.openTitle();
        Audio.stopDriveLoop();
        Audio.stopMusic();
        Audio.playMenuMusic();
        if (this.lanClient) {
          this.lanClient.disconnect();
          this.lanClient = null;
        }
        // Quitting a LAN match we were hosting must stop the local relay
        // too — otherwise it keeps listening/advertising in the
        // background even though nothing is using it anymore.
        if (this.state.gameMode === 'lan_host') {
          this.mainMenu.stopLanHostIfHosting();
        }
        this.lanAiDirectors = [];
        break;
      default:
        break;
    }
  }

  private updatePlaying(): void {
    // ESC -> pause
    if (Input.wasPressed('F6')) {
      const next: Record<VisualQuality, VisualQuality> = {
        ultraLow: 'low',
        low: 'medium',
        medium: 'high',
        high: 'ultraLow',
      };
      this.applyVisualQuality(next[this.visualQuality]);
      this.hud.showMessage(`Visual quality: ${this.visualQuality.toUpperCase()}`, Colors.general_building, 2);
    }
    if (Input.wasPressed('Escape') && !this.actionMenu.open && !this.actionMenu.placementMode) {
      this.phase = 'paused';
      this.mainMenu.openPause();
      return;
    }

    if (Input.wasPressed('F3')) {
      this.debugOverlay = !this.debugOverlay;
    }

    const commandMode = Input.isDown('c');
    if (commandMode) {
      updateCommandMode(this.commandModeCtx(), this.commandModeState);
    } else {
      this.commandModeState.dragStart = null;
      this.commandModeState.dragCurrent = null;
      // Action menu is processed FIRST so it can consume arrow keys before the
      // player ship's handleInput sees them.
      const menuResult = this.actionMenu.update(this.state, this.camera);
      this.handleActionResult(menuResult);
    }

    // Update aim point from current mouse position so the ship's mouse-aim
    // logic in handleInput sees a fresh target this tick.
    if (this.state.player.alive) {
      const aimWorld = this.camera.screenToWorld(Input.mousePos);
      this.state.player.setAimPoint(aimWorld);
    }

    if (!commandMode) {
      updateNumberGroupHotkeys(
        this.commandModeCtx(),
        this.commandModeState,
        this.boundIssueShipOrder,
      );
    }
    updatePlayerFighterOrderTargets(this.state);

    // LAN host OR online host: apply buffered remote inputs BEFORE the simulation tick so
    // remote players' inputs are always included in the current frame.
    if (this.state.gameMode === 'lan_host' || this.state.gameMode === 'online_host') {
      this.applyRemoteLanInputs();
      // Tick all LAN AI directors (they steer their ships before state.update).
      for (const dir of this.lanAiDirectors) {
        dir.update(this.state, DT);
        for (const msg of dir.drainChats()) {
          this.hud.showAIChat('RIVAL', msg, Colors.alert1);
        }
      }
      // Tick each LAN AI slot's base planner (economy + build queue growth).
      this.updateLanAiBases(DT);
    }

    // Update core game state (entities, collision, power, resources, research, particles)
    const stateUpdateStart = performance.now();
    this.state.update(DT);
    this.state.recordGameStateUpdateMs(performance.now() - stateUpdateStart);
    while (this.state.completedResearchNotifications.length > 0) {
      const item = this.state.completedResearchNotifications.shift()!;
      this.hud.showMessage(`Research complete: ${researchDisplayName(item)}`, Colors.researchlab_detail, 4);
    }

    // Emit build-completion particle effect for any building that just finished
    // constructing this tick.  The flag is set by Building.update() and cleared
    // here so the burst fires exactly once.
    for (const b of this.state.buildings) {
      if (b.completionEffectPending) {
        b.completionEffectPending = false;
        this.state.particles.emitBuildEffect(b.position);
      }
    }

    // Detect player damage events to trigger the screen damage flash.
    if (this.state.player.alive) {
      const curHealth = this.state.player.health;
      if (this.playerPrevHealth >= 0 && curHealth < this.playerPrevHealth) {
        this.damageFlashTimer = 0.35;
      }
      this.playerPrevHealth = curHealth;
    } else {
      this.playerPrevHealth = -1;
    }
    if (this.damageFlashTimer > 0) this.damageFlashTimer -= DT;

    // Advance territory pulse time for animated territory circle effects.
    this.territoryPulseTime += DT;

    // Player respawn logic — trigger on death and revive after a short delay.
    this.updatePlayerRespawn();
    this.updateGhostSpectator(DT);

    // Advance starfield animations (twinkling, shooting stars)
    this.starfield.update(DT);
    // Advance distant-suns glint timers.
    this.distantSuns.update(DT);

    // Camera follows the living ship, or the ghost spectator while dead.
    const listenPos = this.playerRespawn.ghostPos ?? this.state.player.position;
    this.camera.update(listenPos, DT);
    // Sound effects are panned/dampened relative to where the player hears from.
    Audio.setListener(listenPos.x, listenPos.y);

    // Drain accumulated shake requests from the game state and apply to camera
    // if the current quality preset has camera shake enabled.
    if (this.state.pendingShakeMagnitude > 0) {
      if (this.visualPreset.cameraShakeEnabled) {
        this.camera.addShake(this.state.pendingShakeMagnitude);
      }
      this.state.pendingShakeMagnitude = 0;
    }

    // Drain explosion events into the crystal nebula (quality-gated).
    if (this.state.pendingCrystalExplosions.length > 0) {
      for (const exp of this.state.pendingCrystalExplosions) {
        this.crystalNebula.addExplosion(exp.x, exp.y, 1.0, exp.radius);
      }
      this.state.pendingCrystalExplosions.length = 0;
    }

    // Emit exhaust particles when the player is thrusting (any WASD key).
    // Most particles stay tied to the physical rear engine, while a smaller
    // plume preserves feedback for the active WASD thrust direction.
    if (this.state.player.alive && this.state.player.isThrusting && !this.actionMenu.open) {
      const td = this.state.player.thrustDir;
      const thrustAngle = Math.atan2(td.y, td.x);
      const isBoosting = this.state.player.isBoosting;
      // emitExhaust already emits 3 particles when isBoosting — no extra loop needed.
      const speed = Math.hypot(this.state.player.velocity.x, this.state.player.velocity.y);
      const maxSpeed = this.state.player.maxSpeed * (isBoosting ? 1.8 : 1);
      const speedFraction = maxSpeed > 0 ? Math.min(1, speed / maxSpeed) : 0;
      this.state.particles.emitExhaust(
        this.state.player.position,
        thrustAngle,
        Team.Player,
        { speedFraction, varyLightness: true, isBoosting, facingAngle: this.state.player.angle },
      );
    }

    // Emit side exhaust particles when strafing (thrust direction is roughly
    // perpendicular to the ship's facing — happens naturally with WASD + aim).
    if (this.state.player.alive) {
      if (this.state.player.isStrafingLeft) {
        this.state.particles.emitSideExhaust(
          this.state.player.position,
          this.state.player.angle,
          -1,
          Team.Player,
          {
            speedFraction: this.playerSpeedFraction(),
            varyLightness: true,
          },
        );
      }
      if (this.state.player.isStrafingRight) {
        this.state.particles.emitSideExhaust(
          this.state.player.position,
          this.state.player.angle,
          1,
          Team.Player,
          {
            speedFraction: this.playerSpeedFraction(),
            varyLightness: true,
          },
        );
      }
    }

    // Rate-limited fighter exhaust — emit for on-screen fighters only, at ~30 Hz
    // instead of 60 Hz to halve particle emission when many fighters are active.
    // Off-screen fighters skip emission entirely.
    this.fighterExhaustAccum += DT;
    const exhaustInterval = Game.FIGHTER_EXHAUST_EMIT_INTERVAL;
    if (this.fighterExhaustAccum >= exhaustInterval) {
      this.fighterExhaustAccum -= exhaustInterval;
      for (const f of this.state.fighters) {
        if (!f.alive || f.docked) continue;
        // Skip off-screen fighters entirely
        if (!this.camera.isOnScreen(f.position, 120)) continue;
        const speed = Math.hypot(f.velocity.x, f.velocity.y);
        const maxSpeed = this.fighterMaxSpeed(f);
        const speedFraction = maxSpeed > 0 ? Math.min(1, speed / maxSpeed) : 0;
        if (speedFraction <= 0.05) continue;
        if (f instanceof SwarmShip && f.id % 3 !== Math.floor(this.state.gameTime * 30) % 3) continue;
        this.state.particles.emitExhaust(
          f.position,
          f.angle,
          f.team,
          { speedFraction, scaleSizeWithSpeed: true },
        );
      }
    }

    // Skip song with N key
    if (Input.wasPressed('n')) {
      Audio.skipSong();
    }

    // Open radar sound when Tab is first pressed (full-screen radar hold key)
    if (Input.wasPressed('Tab')) {
      Audio.playSound('openradar');
    }

    // Player drive loop — run while any WASD movement key is held
    if (this.state.player.alive && this.state.player.isThrusting && !this.actionMenu.open) {
      Audio.startDriveLoop();
    } else {
      Audio.stopDriveLoop();
    }

    // Player firing
    const weaponCtx = { state: this.state, camera: this.camera, hud: this.hud, spaceFluid: this.spaceFluid, actionMenu: this.actionMenu };
    this.activeGuidedMissile = updateGuidedMissileControl(weaponCtx, this.activeGuidedMissile);
    this.activeGuidedMissile = updatePlayerFiring(weaponCtx, this.activeGuidedMissile);

    // Player ship fighter spawning from shipyards
    this.updatePlayerShipyards();
    const fighterCombatStart = performance.now();
    updateFighterWeaponFire(this.state, this.spaceFluid);
    this.state.addFighterCombatTime(performance.now() - fighterCombatStart);
    if (this.state.gameMode !== 'practice' && this.state.gameMode !== 'vs_ai') {
      fireTurretShots(this.state, this.localPlayerTeam());
    }

    // Inject fluid forces from all active entities.
    this.spaceFluid.setView(this.camera.position.x, this.camera.position.y, this.camera.zoom);
    injectFluidForces(this.state, this.spaceFluid);
    // Inject crystal-nebula disturbances and advance physics.
    injectCrystalDisturbances(this.state, this.crystalNebula);
    this.crystalNebula.update(DT);

    // HUD
    this.hud.update(DT);
    this.fighterGroupStatus.update(this.state, DT);

    // Mode-specific logic
    if (this.state.gameMode === 'practice' || this.state.gameMode === 'vs_ai') {
      const practiceStart = performance.now();
      this.practiceMode.update(this.state, this.hud, DT);
      this.state.recordPracticePerf(
        performance.now() - practiceStart,
        this.practiceMode.lastPlannerUpdateMs,
        this.practiceMode.lastPlannerMaxMs,
        this.practiceMode.activeEnemyBaseCount,
      );
      this.recordRankedVsAIResultIfNeeded();
    } else if (this.state.gameMode === 'tutorial') {
      this.tutorialMode.update(this.state, this.hud, DT);
    } else if (this.state.gameMode === 'lan_host' || this.state.gameMode === 'online_host') {
      // Broadcast snapshot on interval (remote inputs were applied above).
      this.lanSnapshotTimer -= DT;
      if (this.lanSnapshotTimer <= 0) {
        this.lanSnapshotTimer = Game.SNAPSHOT_INTERVAL;
        if (this.state.gameMode === 'online_host' && this.onlineTransport) {
          this.broadcastOnlineSnapshot();
        } else {
          this.broadcastLanSnapshot();
        }
      }
    } else if (this.state.gameMode === 'lan_client' || this.state.gameMode === 'online_client') {
      // Send local input to the server every tick.
      if (this.state.gameMode === 'online_client' && this.onlineTransport) {
        this.sendOnlineInput();
      } else {
        this.sendLanInput();
      }
      // Decay the prediction correction offset toward zero.
      if (this.lanPredictionOffsetAlpha > 0) {
        const decay = DT / Game.LAN_PREDICTION_BLEND_SECS;
        this.lanPredictionOffsetAlpha = Math.max(0, this.lanPredictionOffsetAlpha - decay);
        if (this.lanPredictionOffsetAlpha > 0 && this.state.player.alive) {
          // Apply the remaining fraction of the correction offset each tick.
          this.state.player.position.x += this.lanPredictionOffset.x * decay;
          this.state.player.position.y += this.lanPredictionOffset.y * decay;
        } else {
          this.lanPredictionOffset = { x: 0, y: 0 };
        }
      }
    }

    // Vs. AI bot-player: tick the strategic director every frame. The
    // director itself runs cheap decisions on a difficulty-scaled
    // interval; the per-tick driveShip just steers / fires.
    this.updateAIShipRespawn(DT);
    if (this.vsAIDirector) {
      this.vsAIDirector.update(this.state, DT);
      // Drain rival AI chat and forward to HUD.
      for (const msg of this.vsAIDirector.drainChats()) {
        this.hud.showAIChat('RIVAL', msg, Colors.alert1);
      }
    }
  }

  private recordRankedVsAIResultIfNeeded(): void {
    if (this.state.gameMode !== 'vs_ai' || this.rankedVsAIResultRecorded) return;
    const cfg = this.mainMenu.vsAIConfig;
    if (!cfg.ranked || !this.practiceMode.gameOver) return;
    this.rankedVsAIResultRecorded = true;
    if (cfg.mode === 'survival') {
      const survivalScore = this.currentRankedSurvivalScoreBreakdown();
      const score = survivalScore.score;
      let previous = 0;
      try {
        previous = Number.parseInt(window.localStorage?.getItem(SURVIVAL_RANKED_SCORE_KEY) ?? '0', 10) || 0;
        if (score > previous) window.localStorage?.setItem(SURVIVAL_RANKED_SCORE_KEY, `${score}`);
      } catch {
        previous = 0;
      }
      this.hud.showMessage(
        `Ranked Survival score: ${survivalScore.timeSeconds}s x${survivalScore.difficultyMultiplier.toFixed(2)} = ${score}`,
        Colors.alert2,
        8,
      );
      if (score > previous) {
        this.hud.showMessage(`New ranked Survival high score: ${score}`, Colors.alert2, 8);
      }
      return;
    }
    if (!this.practiceMode.victory) return;

    const score = rankedScore(cfg);
    let previous = 0;
    try {
      previous = Number.parseInt(window.localStorage?.getItem(VSAI_RANKED_SCORE_KEY) ?? '0', 10) || 0;
      if (score > previous) window.localStorage?.setItem(VSAI_RANKED_SCORE_KEY, `${score}`);
    } catch {
      previous = 0;
    }
    const modifierSummary = rankedCheaterModifierCount(cfg) > 0
      ? `${cfg.cheatFullMapKnowledge ? 'Full Map ' : ''}${cfg.cheat125xResources ? '1.25x Res ' : ''}`.trim()
      : 'no modifiers';
    this.hud.showMessage(
      `Ranked score: ${score} (${cfg.difficulty} ${cfg.aiRank}, ${modifierSummary}, x${rankedScoreMultiplier(cfg).toFixed(2)})`,
      Colors.alert2,
      8,
    );
    if (score > previous) {
      this.hud.showMessage(`New ranked high score: ${score}`, Colors.alert2, 8);
    }
  }

  private currentRankedSurvivalScore(): number {
    return this.currentRankedSurvivalScoreBreakdown().score;
  }

  private currentRankedSurvivalScoreBreakdown(): { timeSeconds: number; difficultyMultiplier: number; score: number } {
    const cfg = this.mainMenu.vsAIConfig;
    const timeSeconds = Math.max(0, Math.floor(this.practiceMode.score.timeSurvived));
    const difficultyMultiplier = Math.max(0, cfg.aiRank / 100);
    const rawScore = timeSeconds * difficultyMultiplier;
    const score = Math.floor(rawScore);
    return { timeSeconds, difficultyMultiplier, score };
  }

  /**
   * Detect player death, show a respawn countdown, then revive the ship near
   * the command post. Deducts resources proportional to how many buildings
   * and research items the player has (the more powerful your base, the more
   * it costs to die) — clamped to zero so you can never go negative.
   */
  private updatePlayerRespawn(): void {
    updatePlayerRespawn(
      this.state,
      this.hud,
      this.localPlayerTeam(),
      this.playerRespawn,
      DT,
      Game.RESPAWN_DELAY,
    );
  }

  private updateAIShipRespawn(dt: number): void {
    updateAIShipRespawn(this.state, this.hud, this.aiRespawn, dt, Game.AI_RESPAWN_DELAY);
  }

  /**
   * Drives every LAN AI slot's EnemyBasePlanner: accrues that team's
   * resource pool and lets the planner spend it on its build queue.
   * Mirrors PracticeMode's single-base income/update loop, just repeated
   * per AI slot instead of assuming one enemy team.
   */
  private updateLanAiBases(dt: number): void {
    for (const base of this.lanAiBases) {
      if (!base.cp.alive) continue;
      let poweredFactories = 0;
      for (const b of this.state.buildings) {
        if (b.alive && b.team === base.team && b instanceof Factory && b.powered) poweredFactories++;
      }
      const incomeMul = LAN_AI_INCOME_MUL_BY_DIFFICULTY[difficultyIndex(base.difficulty)];
      base.resources += (BASELINE_RESOURCE_GAIN * incomeMul + poweredFactories * RESOURCE_GAIN_RATE) * dt;

      base.tickTimer -= dt;
      if (base.tickTimer > 0) continue;
      base.tickTimer = LAN_AI_BASE_TICK_INTERVAL;
      const spent = base.planner.update(this.state, base.cp, LAN_AI_BASE_TICK_INTERVAL, base.resources);
      base.resources = Math.max(0, base.resources - spent);
      for (const msg of base.planner.drainChats()) {
        this.hud.showAIChat('BASE', msg, Colors.alert1);
      }
    }
  }

  private localPlayerTeam(): Team {
    if (this.state.gameMode === 'lan_host' ||
        this.state.gameMode === 'lan_client' ||
        this.state.gameMode === 'online_host' ||
        this.state.gameMode === 'online_client') {
      return teamForSlot(this.lanMySlot);
    }
    return Team.Player;
  }

  private commandModeCtx(): CommandModeCtx {
    return {
      camera: this.camera,
      state: this.state,
      hud: this.hud,
      waypointMarkers: this.waypointMarkers,
      localTeam: this.localPlayerTeam(),
    };
  }

  private updateGhostSpectator(dt: number): void {
    updateGhostSpectator(
      this.state,
      this.playerRespawn,
      dt,
      this.camera.screenToWorld(Input.mousePos),
    );
  }

  private updatePlayerShipyards(): void {
    const dockedByYard = new Map<Shipyard, number>();
    for (const f of this.state.fighters) {
      if (!f.alive || !f.docked || !f.homeYard || f.team !== Team.Player) continue;
      dockedByYard.set(f.homeYard, (dockedByYard.get(f.homeYard) ?? 0) + 1);
    }
    for (const b of this.state.buildings) {
      if (!b.alive || b.team !== Team.Player) continue;
      if (!(b instanceof Shipyard)) continue;
      if (b.type === EntityType.SwarmYard) {
        b.shipCapacity = 20;
        b.buildInterval = 0.65;
      } else {
        if (this.state.researchedItems.has('fighterYard1')) b.buildInterval = 4;
        if (this.state.researchedItems.has('fighterYard2')) b.shipCapacity = 7;
      }
      b.dockedShips = dockedByYard.get(b) ?? 0;

      if (b.shouldSpawnShip()) {
        const isBomber = b.type === EntityType.BomberYard;
        const isSwarm = b.type === EntityType.SwarmYard;
        const group = b.assignedGroup;
        const synonymous = isSynonymousFaction(this.state.factionByTeam, Team.Player);
        const spawnPos = synonymous ? b.bayPosition() : b.position.clone();
        const fighter = isSwarm
          ? new SwarmShip(spawnPos.clone(), Team.Player, group, b)
          : isBomber
          ? synonymous
            ? new SynonymousNovaBomberShip(spawnPos.clone(), Team.Player, group, b)
            : new BomberShip(spawnPos.clone(), Team.Player, group, b)
          : synonymous
            ? new SynonymousFighterShip(spawnPos.clone(), Team.Player, group, b, this.state.researchedItems.has('fighterHp1'))
            : new FighterShip(spawnPos.clone(), Team.Player, group, b);
        for (const key of FIGHTER_UPGRADE_RESEARCH_KEYS) {
          if (this.state.researchedItems.has(key)) applyFighterResearchUpgrade(fighter, key);
        }
        b.activeShips++;
        this.state.addEntity(fighter);
        b.dockedShips++;
        if (!b.holdDocked && this.applySpawnOrderToFighter(fighter, b)) {
          b.dockedShips = Math.max(0, b.dockedShips - 1);
        }
      }
    }
  }

  private issuePersistentShipOrder(group: ShipCommandGroup, order: string, targetOverride?: Vec2): void {
    issueShipOrder(this.commandModeCtx(), group, order, targetOverride);
    if (order === 'waypoint' || order === 'follow' || order === 'protect') {
      if (group === 'all') {
        this.lastGroupOrders.clear();
      } else {
        this.lastGroupOrders.delete('all');
      }
      this.lastGroupOrders.set(group, order);
    } else if (order === 'dock') {
      this.lastGroupOrders.delete(group);
      if (group === 'all') this.lastGroupOrders.clear();
    }
  }

  private applySpawnOrderToFighter(fighter: FighterShip, yard: Shipyard): boolean {
    const order = this.lastGroupOrders.get(yard.assignedGroup) ?? this.lastGroupOrders.get('all') ?? null;
    if (order === 'waypoint') {
      const waypoint = this.getWaypointForGroup(yard.assignedGroup);
      if (!waypoint) return this.launchFighterAroundYard(fighter, yard);
      fighter.order = 'waypoint';
      fighter.targetPos = waypoint;
      fighter.launch();
      return true;
    }
    if (order === 'follow') {
      fighter.order = 'follow';
      fighter.targetPos = this.state.player.position.clone();
      fighter.launch();
      return true;
    }
    if (order === 'protect') {
      const cp = this.state.getPlayerCommandPost();
      fighter.order = 'protect';
      fighter.targetPos = (cp?.position ?? this.state.player.position).clone();
      fighter.launch();
      return true;
    }
    return this.launchFighterAroundYard(fighter, yard);
  }

  private launchFighterAroundYard(fighter: FighterShip, yard: Shipyard): boolean {
    fighter.order = 'waypoint';
    fighter.targetPos = yard.position.clone();
    fighter.launch();
    return true;
  }

  private handleActionResult(result: MenuResult): void {
    switch (result.action) {
      case 'build':
        this.placeBuilding(result.buildingType, result.cell);
        break;
      case 'order':
        this.issuePersistentShipOrder(result.group, result.order);
        break;
      case 'research':
        this.startResearch(result.item);
        break;
      case 'placeResearchNode':
        this.placeResearchNode(result.item, result.cell);
        break;
      case 'cancelResearch':
        this.cancelQueuedResearch(result.queueIndex);
        break;
      default:
        break;
    }
  }

  private placeBuilding(type: string, cellOverride?: { cx: number; cy: number }): void {
    if (!this.state.player.alive) return;
    const def = getBuildDef(type);
    if (!def) return;

    // Snap placement to the grid cell nearest the cursor.
    const aimWorld = this.camera.screenToWorld(Input.mousePos);
    const cell = cellOverride ?? worldToCell(aimWorld);
    const worldPos = footprintCenter(cell.cx, cell.cy, def.footprintCells);

    const status = this.state.getPlacementStatus(def, cell.cx, cell.cy, Team.Player);
    if (!status.valid) {
      this.hud.showMessage(status.reason, Colors.alert1, 3);
      return;
    }

    const building = createBuildingFromDef(def, worldPos, Team.Player);
    if (isSynonymousFaction(this.state.factionByTeam, Team.Player)) {
      const cost = SYNONYMOUS_BUILD_COST[type] ?? 0;
      const kind = type === 'missileturret' ? 'laserturret' : type === 'synonymousminelayer' ? 'minelayer' : type === 'factory' ? 'factory' : type === 'researchlab' ? 'researchlab' : 'swarm';
      building.synonymousVisualKind = kind === 'swarm' ? null : kind;
      if (kind === 'laserturret' && building instanceof TurretBase) {
        building.fireRate = 6;
        building.range = 240;
      }
      if (cost > 0 && !this.state.synonymous.allocateToBuilding(Team.Player, building.id, kind, worldPos, cost, this.state.gameTime)) {
        this.hud.showMessage(`Need ${cost} ${SYNONYMOUS_CURRENCY_SYMBOL}`, Colors.alert1, 3);
        return;
      }
    } else {
      const placementCost = this.state.getBuildCost(def, Team.Player);
      const conduitRefund = this.state.sellReplaceableConduitsUnderFootprint(def, cell.cx, cell.cy, Team.Player);
      this.state.resources += conduitRefund - placementCost;
      building.placementCost = placementCost;
    }
    this.state.addEntity(building);
    this.state.applyConfluencePlacement(Team.Player, worldPos, String(building.id));
    this.state.selectedBuildType = type;
    Audio.playSound('build');
    this.hud.showMessage(`Building ${def.label}…`, Colors.general_building, 2);
  }

  private startResearch(item: string): void {
    if (!this.state.hasResearchLab()) {
      this.hud.showMessage('Build a finished, powered 9x9 Research Lab first!', Colors.alert1, 3);
      return;
    }
    const costKey = item as keyof typeof RESEARCH_COST;
    const timeKey = item as keyof typeof RESEARCH_TIME;
    const cost = RESEARCH_COST[costKey];
    const time = RESEARCH_TIME[timeKey];

    if (cost === undefined || time === undefined) return;
    if (!(ACTIVE_RESEARCH_ITEMS as readonly string[]).includes(item)) return;
    if (item === 'advancedRegenTurrets' && !this.state.researchedItems.has('regenturret')) {
      this.hud.showMessage('Research Regen Turrets first!', Colors.alert1, 3);
      return;
    }
    if (this.state.researchedItems.has(item) || this.state.hasResearchBuilding(item)) {
      this.hud.showMessage(
        RESEARCH_MODE === 'classic'
          ? `${researchDisplayName(item)} is already queued`
          : `${researchDisplayName(item)} already has a Research Node`,
        Colors.alert2, 3,
      );
      return;
    }
    if (RESEARCH_MODE === 'classic') {
      const synonymous = isSynonymousFaction(this.state.factionByTeam, Team.Player);
      const canAfford = synonymous ? this.state.synonymous.canSpend(Team.Player, cost) : this.state.resources >= cost;
      if (!canAfford) {
        this.hud.showMessage(`Need ${cost}${synonymous ? ' ' + SYNONYMOUS_CURRENCY_SYMBOL : ''}`, Colors.alert1, 3);
        return;
      }
      if (synonymous) {
        this.state.synonymous.spendFreeDrones(Team.Player, cost);
      } else {
        this.state.resources -= cost;
      }
      this.state.queueResearch(item);
      this.hud.showMessage(`Researching ${researchDisplayName(item)}…`, Colors.researchlab_detail, 3);
      return;
    }
    this.actionMenu.beginResearchNodePlacement(item);
    this.hud.showMessage(`Place the ${researchDisplayName(item)} Research Node`, Colors.researchlab_detail, 3);
  }

  private placeResearchNode(item: string, cell: { cx: number; cy: number }): void {
    if (!this.state.hasResearchLab()) {
      this.hud.showMessage('Research Lab lost — build another before placing Research Nodes.', Colors.alert1, 3);
      return;
    }
    const cost = RESEARCH_COST[item as keyof typeof RESEARCH_COST];
    const time = RESEARCH_TIME[item as keyof typeof RESEARCH_TIME];
    if (cost === undefined || time === undefined || this.state.researchedItems.has(item) || this.state.hasResearchBuilding(item)) return;
    const def = {
      key: `researchnode:${item}`,
      label: 'Research Node',
      description: `Houses the ${researchDisplayName(item)} upgrade.`,
      cost,
      footprintCells: 3,
      buildTime: time,
      tier: 'structure' as const,
      factory: (pos: Vec2, team: Team) => new ResearchLab(pos, team, item),
    };
    const worldPos = footprintCenter(cell.cx, cell.cy, 3);
    const status = this.state.getPlacementStatus(def, cell.cx, cell.cy, Team.Player);
    if (!status.valid) {
      this.hud.showMessage(status.reason, Colors.alert1, 3);
      return;
    }
    const building = new ResearchLab(worldPos, Team.Player, item);
    building.buildDurationSeconds = time / TICK_RATE;
    building.buildProgress = 0;
    building.placementCost = cost;
    if (isSynonymousFaction(this.state.factionByTeam, Team.Player)) {
      building.synonymousVisualKind = 'researchlab';
      if (!this.state.synonymous.allocateToBuilding(Team.Player, building.id, 'researchlab', worldPos, cost, this.state.gameTime)) {
        this.hud.showMessage(`Need ${cost} ${SYNONYMOUS_CURRENCY_SYMBOL}`, Colors.alert1, 3);
        return;
      }
    } else {
      const refund = this.state.sellReplaceableConduitsUnderFootprint(def, cell.cx, cell.cy, Team.Player);
      this.state.resources += refund - cost;
    }
    this.state.addEntity(building);
    this.state.applyConfluencePlacement(Team.Player, worldPos, String(building.id));
    Audio.playSound('build');
    this.hud.showMessage(`Building ${researchDisplayName(item)} Research Node…`, Colors.researchlab_detail, 3);
  }

  private cancelQueuedResearch(queueIndex: number): void {
    let item: string | undefined;
    if (queueIndex === -1) {
      item = this.state.researchProgress.item ?? undefined;
      if (!item) return;
      this.state.cancelActiveResearch();
    } else {
      [item] = this.state.researchQueue.splice(queueIndex, 1);
      if (!item) return;
    }
    const cost = RESEARCH_COST[item as keyof typeof RESEARCH_COST];
    if (cost !== undefined) {
      if (isSynonymousFaction(this.state.factionByTeam, Team.Player)) {
        this.state.synonymous.spawnAtBase(Team.Player, cost, this.state.gameTime);
      } else {
        this.state.resources += cost;
      }
    }
    this.hud.showMessage(`Canceled research: ${researchDisplayName(item)}`, Colors.alert2, 3);
  }

  private getWaypointForGroup(group: ShipGroup): Vec2 | null {
    return this.waypointMarkers.get(group)?.pos.clone()
      ?? this.waypointMarkers.get('all')?.pos.clone()
      ?? null;
  }

  private findNearestEnemyBuildingOfType(type: EntityType): BuildingBase | null {
    let best: BuildingBase | null = null;
    let bestDist = Infinity;
    for (const b of this.state.buildings) {
      if (!b.alive || b.team !== Team.Enemy || b.type !== type) continue;
      const d = b.position.distanceTo(this.state.player.position);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  }

  private startGame(mode: 'tutorial' | 'practice' | 'vs_ai'): void {
    // Create fresh state
    const playerStart = new Vec2(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.5);
    this.state = new GameState(playerStart);
    this.state.gameMode = mode;
    this.applyVisualQuality(this.visualQuality);
    // Reset any director from a previous match.
    this.vsAIDirector = null;
    this.rankedVsAIResultRecorded = false;

    // Reset respawn tracking.
    resetRespawnRuntime(this.playerRespawn, this.aiRespawn);
    this.activeGuidedMissile = null;
    this.damageFlashTimer = 0;
    this.playerPrevHealth = -1;
    this.territoryPulseTime = 0;

    // Reset subsystems
    this.camera = new Camera();
    this.camera.setScreenSize(this.screenW, this.screenH);
    this.camera.zoom = this.gameZoom;
    this.camera.position = playerStart.clone();
    this.actionMenu = new ActionMenu();
    this.hud = new HUD();
    this.waypointMarkers.clear();
    this.lastGroupOrders.clear();
    this.commandModeState.selectedFighters.clear();
    this.commandModeState.selectedTurrets.clear();
    this.commandModeState.dragStart = null;
    this.commandModeState.dragCurrent = null;
    this.commandModeState.lastGroupTap = null;

    this.spaceFluid.reset();
    this.spaceFluid.resize(this.screenW, this.screenH);

    const practiceCfg = mode === 'practice' ? this.mainMenu.practiceConfig : null;
    const vsCfg = mode === 'vs_ai' ? this.mainMenu.vsAIConfig : null;
    const playerFaction = mode === 'tutorial'
      ? 'terran'
      : resolveRaceSelection(practiceCfg?.playerRace ?? vsCfg?.playerRace ?? 'terran', this.state.gameTime + 0.13);
    const enemyFaction = mode === 'practice'
      ? resolveRaceSelection(practiceCfg?.enemyRace ?? 'terran', this.state.gameTime + 0.71)
      : mode === 'vs_ai'
        ? resolveRaceSelection(vsCfg?.aiRace ?? 'terran', this.state.gameTime + 0.71)
        : 'terran';
    this.state.setFaction(Team.Player, playerFaction);
    this.state.setFaction(Team.Enemy, enemyFaction);

    // Create player command post near player
    const rawCpPos = new Vec2(playerStart.x, playerStart.y + 80);
    const cpCell = worldToCell(rawCpPos);
    const cpPos = footprintCenter(cpCell.cx, cpCell.cy, 6);
    const cp = new CommandPost(cpPos, Team.Player);
    if (playerFaction === 'synonymous') cp.synonymousVisualKind = 'base';
    this.state.addEntity(cp);
    this.state.ensureConfluenceSeedCircle(Team.Player, cpPos);
    this.state.ensureSynonymousSeedSwarm(Team.Player, cpPos);

    // Seed a small starter conduit network around the player CP so that
    // shipyards / labs / factories placed near the CP can be powered
    // immediately. Without this, post-PR8 power rules (shipyards no
    // longer self-power) would force the player to paint conduits
    // before their first shipyard could function.
    if (!isConfluenceFaction(this.state.factionByTeam, Team.Player) && !isSynonymousFaction(this.state.factionByTeam, Team.Player)) {
      const startCx = Math.floor(cpPos.x / GRID_CELL_SIZE);
      const startCy = Math.floor(cpPos.y / GRID_CELL_SIZE);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= 2) {
            this.state.grid.addConduit(startCx + dx, startCy + dy, Team.Player);
          }
        }
      }
    }
    this.state.power.markDirty();

    // Set initial resources & spin up the appropriate mode driver.
    if (mode === 'tutorial') {
      this.state.resources = 50000;
      this.tutorialMode = new TutorialMode();
      this.tutorialMode.init(this.state, this.hud);
    } else if (mode === 'practice') {
      const cfg = this.mainMenu.practiceConfig;
      this.practiceMode = new PracticeMode();
      this.practiceMode.configure(cfg);
      // Apply unlocked research from setup.
      this.applyResearchUnlock(cfg.researchUnlocked);
      this.practiceMode.init(this.state, this.hud);
    } else {
      // Vs. AI: PracticeMode's growing-base opponent provides the
      // economy / construction / production framework; on top we
      // spawn an opposing AIShip + VsAIDirector that acts as a true
      // bot player (independent ship, harassment, retreat, APM).
      const vcfg = this.mainMenu.vsAIConfig;
      if (vcfg.ranked) {
        vcfg.difficulty = rankedDifficultyName(vcfg.aiRank);
        vcfg.aiApm = -1;
        vcfg.startingResources = 300;
        vcfg.mapSize = 'medium';
        vcfg.startingDistance = 3000;
        vcfg.fogOfWar = true;
      }
      const pcfg = cloneDefaultPracticeConfig();
      pcfg.difficulty = vcfg.difficulty;
      pcfg.enemyIncomeMul = vcfg.cheat125xResources ? 1.25 : 1.0;
      pcfg.fogOfWar = vcfg.fogOfWar;
      pcfg.mapSize = vcfg.mapSize;
      pcfg.startingDistance = vcfg.startingDistance;
      pcfg.playerStartingResources = vcfg.startingResources;
      pcfg.enemyStartingResources = vcfg.startingResources;
      pcfg.survivalAiRank = vcfg.aiRank;
      this.practiceMode = new PracticeMode();
      this.practiceMode.configure(pcfg);
      this.practiceMode.vsAIMode = true;
      this.practiceMode.survivalMode = vcfg.mode === 'survival';
      this.practiceMode.init(this.state, this.hud);

      // Spawn the bot-player ship near the enemy CP.
      const enemyCP = this.state.getEnemyCommandPost();
      const aiShipPos = enemyCP
        ? new Vec2(enemyCP.position.x, enemyCP.position.y - 80)
        : playerStart.clone();
      const aiShip = new AIShip(aiShipPos);
      this.state.aiPlayerShip = aiShip;
      this.vsAIDirector = new VsAIDirector(aiShip, vcfg);
      // Wire up the planner so the director can coordinate defense/escort/harass.
      this.vsAIDirector.planner = this.practiceMode.getPlanner();

      this.hud.showMessage(
        (vcfg.ranked
          ? `${vcfg.mode === 'survival' ? 'Ranked Survival' : 'Ranked Vs. AI'} started - ${vcfg.difficulty} rank ${vcfg.aiRank} x${rankedScoreMultiplier(vcfg).toFixed(2)}`
          : `${vcfg.mode === 'survival' ? 'Survival' : 'Vs. AI'} started - ${vcfg.difficulty}`) +
          (vcfg.cheatFullMapKnowledge ? ' [+full map]' : '') +
          (vcfg.cheat125xResources ? ' [+1.25x res]' : ''),
        Colors.alert2, 4,
      );
    }

    // Start game
    this.phase = 'playing';
    this.mainMenu.close();
    Audio.stopDriveLoop();
    Audio.stopMusic();
    Audio.startPlaylist();
  }

  /**
   * Apply Practice setup's `researchUnlocked` setting by pre-populating
   * `state.researchedItems`. Cheap and additive.
   */
  private applyResearchUnlock(level: 'none' | 'basic_turrets' | 'all_turrets' | 'full_tech'): void {
    if (level === 'none') return;
    const basicTurrets = ['missileturret', 'exciterturret'];
    const allTurrets = ['missileturret', 'exciterturret', 'massdriverturret', 'regenturret'];
    const fullTech = [
      ...allTurrets,
      'bomberyard',
      'fighterYard1',
      'fighterYard2',
      'fighterTargeting',
      'fighterWeapon1',
      'fighterWeapon2',
      'fighterSpeed1',
      'fighterSpeed2',
      'fighterHp1',
      'fighterHp2',
      'shipHp1',
      'shipHp2',
      'shipHp3',
      'shipHp4',
      'shipSpeedEnergy1',
      'shipSpeedEnergy2',
      'shipSpeedEnergy3',
      'shipSpeedEnergy4',
      'shipShield1',
      'shipShield2',
      'weaponGatling',
      'weaponLaser',
    ];
    const list = level === 'basic_turrets' ? basicTurrets
      : level === 'all_turrets' ? allTurrets
      : fullTech;
    for (const item of list) {
      this.state.researchedItems.add(item);
      this.state.player.applyResearchUpgrade(item);
    }
  }

  // -----------------------------------------------------------------------
  // LAN match startup & networking
  // -----------------------------------------------------------------------

  /**
   * Begin a LAN match. The host runs the authoritative simulation; remote
   * clients receive periodic snapshots and send their input each tick.
   */
  private startLanGame(matchStart: MsgMatchStart, isHost: boolean): void {
    this.lanMySlot = matchStart.mySlot;
    this.lanClient = this.mainMenu.getLanClient();
    this.lanRemoteInputs.clear();
    this.lanAiDirectors = [];
    this.lanAiBases = [];
    this.lanSnapshotSeq = 0;
    this.lanInputSeq = 0;
    this.lanLastSnapshotSeq = -1;
    this.lanPredictionOffset = { x: 0, y: 0 };
    this.lanPredictionOffsetAlpha = 0;
    this.lanUnacknowledgedInputs = [];
    this.lanLastProcessedSeqPerSlot.clear();

    const myLobbySlot = matchStart.lobby.slots.find((s) => s.slotIndex === this.lanMySlot);
    const teamForLobbySlot = (slotIndex: number): Team => {
      const slot = matchStart.lobby.slots.find((s) => s.slotIndex === slotIndex);
      const teamId = Math.max(0, Math.min(7, slot?.teamId ?? slotIndex));
      return teamForSlot(teamId);
    };
    const myTeam = teamForLobbySlot(this.lanMySlot);
    const spawns = createMultiplayerSpawns(matchStart.lobby.slots);
    const startForSlot = (slotIndex: number): Vec2 =>
      spawns.find((spawn) => spawn.slotIndex === slotIndex)?.position.clone()
        ?? new Vec2(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.5);
    const localStart = startForSlot(this.lanMySlot);

    // Build fresh game state for host slot 0.
    this.state = new GameState(localStart);
    this.state.gameMode = isHost ? 'lan_host' : 'lan_client';
    for (const slot of matchStart.lobby.slots) {
      if (slot.type === 'open' || slot.type === 'closed') continue;
      this.state.setFaction(teamForLobbySlot(slot.slotIndex), resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + slot.slotIndex * 0.37));
    }
    this.applyVisualQuality(this.visualQuality);
    this.vsAIDirector = null;
    resetRespawnRuntime(this.playerRespawn, this.aiRespawn);
    this.activeGuidedMissile = null;
    this.damageFlashTimer = 0;
    this.playerPrevHealth = -1;
    this.territoryPulseTime = 0;
    this.camera = new Camera();
    this.camera.setScreenSize(this.screenW, this.screenH);
    this.camera.zoom = this.gameZoom;
    this.camera.position = localStart.clone();
    this.actionMenu = new ActionMenu();
    this.hud = new HUD();
    this.waypointMarkers.clear();
    this.lastGroupOrders.clear();
    this.spaceFluid.reset();
    this.spaceFluid.resize(this.screenW, this.screenH);

    // Set the local player ship's team from the assigned slot.
    this.state.playerShips.set(this.lanMySlot, new PlayerShip(localStart, myTeam));
    // Also keep slot 0 accessible for backwards-compat single-player code.
    if (this.lanMySlot !== 0) {
      this.state.playerShips.set(0, this.state.playerShips.get(this.lanMySlot)!);
    }

    // For every non-local human slot, create a remote PlayerShip placeholder.
    for (const slot of matchStart.lobby.slots) {
      if (slot.type === 'human' && slot.slotIndex !== this.lanMySlot) {
        const remoteShip = new PlayerShip(startForSlot(slot.slotIndex), teamForLobbySlot(slot.slotIndex));
        this.state.playerShips.set(slot.slotIndex, remoteShip);
      }
    }

    // Host: spawn AIShip + VsAIDirector for each AI slot.
    // Remote clients will receive AI ships via snapshots and don't run local AI.
    if (isHost) {
      for (const slot of matchStart.lobby.slots) {
        if (slot.type !== 'ai') continue;
        const aiTeam = teamForLobbySlot(slot.slotIndex);
        const aiStart = startForSlot(slot.slotIndex);
        const aiShip = new AIShip(aiStart, aiTeam);
        this.state.playerShips.set(slot.slotIndex, aiShip);

        const aiCfg = cloneDefaultVsAIConfig();
        aiCfg.aiRace = resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + slot.slotIndex * 0.37);
        // Map AIDifficulty → VsAIConfig difficulty.
        switch (slot.aiDifficulty) {
          case 'easy':      aiCfg.difficulty = 'Easy';      break;
          case 'hard':      aiCfg.difficulty = 'Hard';      break;
          case 'nightmare': aiCfg.difficulty = 'Nightmare'; break;
          default:          aiCfg.difficulty = 'Normal';    break;
        }
        const director = new VsAIDirector(aiShip, aiCfg);
        this.lanAiDirectors.push(director);
      }
    }

    // Every occupied player/AI slot owns a separate starting base. Only the
    // authoritative host needs to simulate all bases; clients create their
    // local one immediately while waiting for the first snapshot.
    const baseSpawns = isHost ? spawns : spawns.filter((spawn) => spawn.slotIndex === this.lanMySlot);
    const cpBySlot = new Map<number, CommandPost>();
    for (const spawn of baseSpawns) {
      const slot = matchStart.lobby.slots.find((candidate) => candidate.slotIndex === spawn.slotIndex);
      if (!slot) continue;
      const team = teamForLobbySlot(spawn.slotIndex);
      const faction = resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + spawn.slotIndex * 0.37);
      const cpCell = worldToCell(new Vec2(spawn.position.x, spawn.position.y + 80));
      const cpPos = footprintCenter(cpCell.cx, cpCell.cy, 6);
      const cp = new CommandPost(cpPos, team);
      if (faction === 'synonymous') cp.synonymousVisualKind = 'base';
      this.state.addEntity(cp);
      this.state.ensureConfluenceSeedCircle(team, cpPos);
      this.state.ensureSynonymousSeedSwarm(team, cpPos);
      cpBySlot.set(spawn.slotIndex, cp);

      if (isConfluenceFaction(this.state.factionByTeam, team) || isSynonymousFaction(this.state.factionByTeam, team)) continue;
      const startCx = Math.floor(cpPos.x / GRID_CELL_SIZE);
      const startCy = Math.floor(cpPos.y / GRID_CELL_SIZE);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= 2) {
            this.state.grid.addConduit(startCx + dx, startCy + dy, team);
          }
        }
      }
    }
    this.state.power.markDirty();
    this.state.resources = 500;

    // Host: give each AI slot's own command post a growing base, driven by
    // an EnemyBasePlanner. This is what lets VsAIDirector coordinate
    // (defense points, harass targets, construction escorts) in LAN games —
    // previously LAN AI slots had no planner at all and never expanded
    // past their starting Command Post.
    if (isHost) {
      let aiSlotOrdinal = 0;
      for (const slot of matchStart.lobby.slots) {
        if (slot.type !== 'ai') continue;
        const director = this.lanAiDirectors[aiSlotOrdinal];
        aiSlotOrdinal++;
        const cp = cpBySlot.get(slot.slotIndex);
        if (!director || !cp) continue;
        const team = teamForLobbySlot(slot.slotIndex);
        const difficulty: DifficultyName =
          slot.aiDifficulty === 'easy' ? 'Easy'
          : slot.aiDifficulty === 'hard' ? 'Hard'
          : slot.aiDifficulty === 'nightmare' ? 'Nightmare'
          : 'Normal';
        const plannerConfig = cloneDefaultPracticeConfig();
        plannerConfig.difficulty = difficulty;
        plannerConfig.enemyRace = resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + slot.slotIndex * 0.37);
        const planner = new EnemyBasePlanner(team, plannerConfig, Math.floor(matchStart.seed * 7919 + slot.slotIndex * 104729) >>> 0);
        planner.init(this.state, cp);
        director.planner = planner;
        this.lanAiBases.push({
          team,
          cp,
          planner,
          difficulty,
          resources: 500,
          tickTimer: 0,
        });
      }
    }

    // Wire up LAN callbacks.
    if (this.lanClient) {
      if (isHost) {
        // Host receives remote player inputs and applies them to remote ships.
        this.lanClient.onRelayedInput = (msg: MsgRelayedInput) => {
          this.lanRemoteInputs.set(msg.fromSlot, {
            dx: msg.input.dx,
            dy: msg.input.dy,
            aimX: msg.input.aimX,
            aimY: msg.input.aimY,
            firePrimary: msg.input.firePrimary,
            fireSpecial: msg.input.fireSpecial,
            boost: msg.input.boost,
          });
          // Track the latest seq seen from this slot for prediction replay.
          const prevSeq = this.lanLastProcessedSeqPerSlot.get(msg.fromSlot) ?? -1;
          if (msg.input.seq > prevSeq) {
            this.lanLastProcessedSeqPerSlot.set(msg.fromSlot, msg.input.seq);
          }
        };
      } else {
        // Remote client receives authoritative snapshots from the host.
        this.lanClient.onGameSnapshot = (snapshot) => {
          this.lanLastSnapshotSeq = snapshot.seq;
          this.applyLanSnapshot(snapshot);
        };
      }

      this.lanClient.onMatchEnd = (reason) => {
        this.hud.showMessage(`Match ended: ${reason}`, Colors.alert1, 5);
        this.phase = 'menu';
        this.mainMenu.openTitle();
        Audio.stopDriveLoop();
        Audio.stopMusic();
        Audio.playMenuMusic();
        this.lanClient = null;
        this.lanAiDirectors = [];
        this.lanAiBases = [];
      };
    }

    this.phase = 'playing';
    this.mainMenu.close();
    Audio.stopDriveLoop();
    Audio.stopMusic();
    Audio.startPlaylist();

    const aiCount = matchStart.lobby.slots.filter(s => s.type === 'ai').length;
    this.hud.showMessage(
      `LAN ${isHost ? 'Host' : 'Client'} — slot ${this.lanMySlot + 1}` +
        (isHost && aiCount > 0 ? ` | ${aiCount} AI slot${aiCount > 1 ? 's' : ''}` : ''),
      Colors.radar_friendly_status, 4,
    );
  }

  // -----------------------------------------------------------------------
  // Online (WebRTC) match startup & networking
  // -----------------------------------------------------------------------

  /**
   * Begin an online match using a WebRTC transport.
   * Reuses the same game state setup as startLanGame but wires the
   * transport callbacks instead of LAN client callbacks.
   */
  private startOnlineGame(
    transport: MultiplayerTransport,
    matchStart: MsgMatchStart,
    isHost: boolean,
  ): void {
    this.onlineTransport = transport;
    this.lanClient = null;
    this.lanMySlot = matchStart.mySlot;
    this.lanRemoteInputs.clear();
    this.lanAiDirectors = [];
    this.lanAiBases = [];
    this.lanSnapshotSeq = 0;
    this.lanInputSeq = 0;
    this.lanLastSnapshotSeq = -1;
    this.lanPredictionOffset = { x: 0, y: 0 };
    this.lanPredictionOffsetAlpha = 0;
    this.lanUnacknowledgedInputs = [];
    this.lanLastProcessedSeqPerSlot.clear();

    const teamForLobbySlot = (slotIndex: number): Team => {
      const slot = matchStart.lobby.slots.find((candidate) => candidate.slotIndex === slotIndex);
      return teamForSlot(Math.max(0, Math.min(7, slot?.teamId ?? slotIndex)));
    };
    const spawns = createMultiplayerSpawns(matchStart.lobby.slots);
    const startForSlot = (slotIndex: number): Vec2 =>
      spawns.find((spawn) => spawn.slotIndex === slotIndex)?.position.clone()
        ?? new Vec2(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.5);
    const myTeam = teamForLobbySlot(this.lanMySlot);
    const playerStart = startForSlot(this.lanMySlot);

    this.state = new GameState(playerStart);
    this.state.gameMode = isHost ? 'online_host' : 'online_client';

    for (const slot of matchStart.lobby.slots) {
      if (slot.type === 'open' || slot.type === 'closed') continue;
      this.state.setFaction(
        teamForLobbySlot(slot.slotIndex),
        resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + slot.slotIndex * 0.37),
      );
    }

    this.applyVisualQuality(this.visualQuality);
    this.vsAIDirector = null;
    resetRespawnRuntime(this.playerRespawn, this.aiRespawn);
    this.activeGuidedMissile = null;
    this.damageFlashTimer = 0;
    this.playerPrevHealth = -1;
    this.territoryPulseTime = 0;
    this.camera = new Camera();
    this.camera.setScreenSize(this.screenW, this.screenH);
    this.camera.zoom = this.gameZoom;
    this.camera.position = playerStart.clone();
    this.actionMenu = new ActionMenu();
    this.hud = new HUD();
    this.waypointMarkers.clear();
    this.lastGroupOrders.clear();
    this.spaceFluid.reset();
    this.spaceFluid.resize(this.screenW, this.screenH);

    // Local player ship.
    this.state.playerShips.set(this.lanMySlot, new PlayerShip(playerStart, myTeam));
    if (this.lanMySlot !== 0) {
      this.state.playerShips.set(0, this.state.playerShips.get(this.lanMySlot)!);
    }

    // Placeholder ships for other human slots.
    for (const slot of matchStart.lobby.slots) {
      if (slot.type === 'human' && slot.slotIndex !== this.lanMySlot) {
        this.state.playerShips.set(
          slot.slotIndex,
          new PlayerShip(startForSlot(slot.slotIndex), teamForLobbySlot(slot.slotIndex)),
        );
      }
    }

    // As with LAN, the host owns every starting base while a client creates
    // its own immediately so the opening view is correct before sync arrives.
    const baseSpawns = isHost ? spawns : spawns.filter((spawn) => spawn.slotIndex === this.lanMySlot);
    for (const spawn of baseSpawns) {
      const slot = matchStart.lobby.slots.find((candidate) => candidate.slotIndex === spawn.slotIndex);
      if (!slot) continue;
      const team = teamForLobbySlot(spawn.slotIndex);
      const faction = resolveRaceSelection(slot.race ?? 'terran', matchStart.seed + spawn.slotIndex * 0.37);
      const cpCell = worldToCell(new Vec2(spawn.position.x, spawn.position.y + 80));
      const cpPos = footprintCenter(cpCell.cx, cpCell.cy, 6);
      const cp = new CommandPost(cpPos, team);
      if (faction === 'synonymous') cp.synonymousVisualKind = 'base';
      this.state.addEntity(cp);
      this.state.ensureConfluenceSeedCircle(team, cpPos);
      this.state.ensureSynonymousSeedSwarm(team, cpPos);

      if (isConfluenceFaction(this.state.factionByTeam, team) || isSynonymousFaction(this.state.factionByTeam, team)) continue;
      const startCx = Math.floor(cpPos.x / GRID_CELL_SIZE);
      const startCy = Math.floor(cpPos.y / GRID_CELL_SIZE);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= 2) {
            this.state.grid.addConduit(startCx + dx, startCy + dy, team);
          }
        }
      }
    }
    this.state.power.markDirty();
    this.state.resources = 500;

    // Wire transport callbacks.
    if (isHost) {
      transport.onInputSnapshot = (fromSlot: number, input: NetInputSnapshot) => {
        this.lanRemoteInputs.set(fromSlot, {
          dx: input.dx,
          dy: input.dy,
          aimX: input.aimX,
          aimY: input.aimY,
          firePrimary: input.firePrimary,
          fireSpecial: input.fireSpecial ?? false,
          boost: input.boost,
        });
        const prevSeq = this.lanLastProcessedSeqPerSlot.get(fromSlot) ?? -1;
        if (input.seq > prevSeq) {
          this.lanLastProcessedSeqPerSlot.set(fromSlot, input.seq);
        }
      };
    } else {
      transport.onAuthoritativeSnapshot = (snapshot: NetGameSnapshot) => {
        this.lanLastSnapshotSeq = snapshot.seq;
        // NetGameSnapshot is structurally compatible with applyLanSnapshot's
        // parameter (same field names and shapes for all used fields).
        this.applyLanSnapshot(snapshot as unknown as Parameters<typeof this.applyLanSnapshot>[0]);
      };
    }

    transport.onDisconnect = (reason: string) => {
      this.hud.showMessage(`Disconnected: ${reason}`, Colors.alert1, 5);
      this.phase = 'menu';
      this.mainMenu.openTitle();
      Audio.stopDriveLoop();
      Audio.stopMusic();
      Audio.playMenuMusic();
      this.onlineTransport = null;
    };

    this.phase = 'playing';
    this.mainMenu.close();
    Audio.stopDriveLoop();
    Audio.stopMusic();
    Audio.startPlaylist();

    this.hud.showMessage(
      `Online ${isHost ? 'Host' : 'Client'} — slot ${this.lanMySlot + 1}`,
      Colors.radar_friendly_status, 4,
    );
  }

  /**
   * Online host: broadcast authoritative snapshot to all connected clients via WebRTC.
   * Reuses broadcastLanSnapshot's serialisation logic but sends through the transport.
   */
  private broadcastOnlineSnapshot(): void {
    if (!this.onlineTransport) return;
    const data = this.buildGameSnapshotData();
    this.onlineTransport.sendAuthoritativeSnapshot({
      seq: data.seq,
      serverTimeMs: Date.now(),
      gameTime: data.gameTime,
      ships: data.ships,
      buildings: data.buildings,
      fighters: data.fighters,
      projectiles: data.projectiles,
      resourcesPerSlot: data.resourcesPerSlot,
      hostSlot: data.hostSlot,
      factionsByTeam: data.factionsByTeam,
      territoryCircles: data.territoryCircles,
      lastProcessedInputSeqBySlot: data.lastProcessedInputSeqBySlot,
    });
  }

  /**
   * Online client: send local input to the host via WebRTC.
   */
  private sendOnlineInput(): void {
    if (!this.onlineTransport?.connected) return;
    const aimWorld = this.camera.screenToWorld(Input.mousePos);
    const seq = this.lanInputSeq++;
    const dx = ((Input.isDown('d') ? 1 : 0) - (Input.isDown('a') ? 1 : 0)) as -1 | 0 | 1;
    const dy = ((Input.isDown('s') ? 1 : 0) - (Input.isDown('w') ? 1 : 0)) as -1 | 0 | 1;
    const boost = Input.isDown('Shift');

    const input: NetInputSnapshot = {
      protocolVersion: 1,
      seq,
      clientTimeMs: Date.now(),
      dx,
      dy,
      aimX: aimWorld.x,
      aimY: aimWorld.y,
      firePrimary: Input.mouseDown,
      fireSpecial: Input.mouse2Down,
      boost,
    };

    this.onlineTransport.sendInputSnapshot(input);

    // Buffer for prediction replay.
    this.lanUnacknowledgedInputs.push({ seq, dx, dy, aimX: aimWorld.x, aimY: aimWorld.y, boost });
    if (this.lanUnacknowledgedInputs.length > Game.LAN_INPUT_RING_MAX) {
      this.lanUnacknowledgedInputs.shift();
    }
  }

  /**
   * Apply a relayed game snapshot to non-authoritative client state.
   *
   * Ships:
   *   - Remote ships: directly write position/velocity.
   *   - Local ship (our slot): apply soft prediction correction — blend toward
   *     host authoritative position rather than snapping, unless the error is
   *     large enough that smoothing would look wrong.
   *
   * Fighters:
   *   - Update position/velocity for existing fighters matched by id.
   *   - Create lightweight placeholder FighterShip/BomberShip for new ones.
   *   - Destroy fighters whose ids are absent from the snapshot.
   *
   * Projectiles:
   *   - Update position/velocity for existing projectiles matched by id.
   *   - Projectiles absent from the snapshot are allowed to expire naturally
   *     (they have short lifetimes; removing them immediately could cause
   *     visual pops). New projectiles are not created from snapshots on the
   *     client to avoid duplicating damage effects.
   *
   * Buildings: sync health/buildProgress for known buildings; create new ones if absent.
   * Factions, territory circles, resources: applied directly.
   */
  private applyLanSnapshot(snapshot: {
    seq: number;
    ships: SerializedShip[];
    buildings: SerializedBuilding[];
    fighters: SerializedFighter[];
    projectiles: SerializedProjectile[];
    factionsByTeam?: Array<{ team: number; faction: FactionType }>;
    territoryCircles?: SerializedTerritoryCircle[];
    resourcesPerSlot: number[];
    lastProcessedInputSeqBySlot?: number[];
  }): void {
    // --- Ships ---
    for (const sd of snapshot.ships) {
      if (sd.slotIndex === this.lanMySlot) {
        // Local ship prediction correction + replay:
        // The host has simulated our ship (with our delayed inputs) and is
        // telling us where it thinks we are. Apply a correction toward the host's
        // authoritative position, then replay any inputs not yet acknowledged.
        const localShip = this.state.playerShips.get(sd.slotIndex);
        if (localShip && localShip.alive && sd.alive) {
          const lastAck = snapshot.lastProcessedInputSeqBySlot?.[this.lanMySlot] ?? -1;

          // Prune acknowledged inputs from the ring buffer.
          this.lanUnacknowledgedInputs = this.lanUnacknowledgedInputs.filter(
            (i) => i.seq > lastAck,
          );

          const errX = sd.x - localShip.position.x;
          const errY = sd.y - localShip.position.y;
          const errDist = Math.hypot(errX, errY);
          if (errDist > Game.LAN_PREDICTION_SNAP_THRESHOLD) {
            // Large error — snap immediately to host position and velocity.
            localShip.position.x = sd.x;
            localShip.position.y = sd.y;
            localShip.velocity.x = sd.vx;
            localShip.velocity.y = sd.vy;
            this.lanPredictionOffset = { x: 0, y: 0 };
            this.lanPredictionOffsetAlpha = 0;
          } else {
            // Set authoritative base state, then replay unacknowledged inputs
            // so the local position reflects inputs the host has not yet seen.
            localShip.position.x = sd.x;
            localShip.position.y = sd.y;
            localShip.velocity.x = sd.vx;
            localShip.velocity.y = sd.vy;
            for (const inp of this.lanUnacknowledgedInputs) {
              const len = Math.hypot(inp.dx, inp.dy);
              if (len > 0.01) {
                const ux = inp.dx / len;
                const uy = inp.dy / len;
                localShip.velocity.x += ux * localShip.thrustPower * DT;
                localShip.velocity.y += uy * localShip.thrustPower * DT;
                localShip.position.x += localShip.velocity.x * DT;
                localShip.position.y += localShip.velocity.y * DT;
              }
            }
            if (errDist > Game.LAN_PREDICTION_MIN_BLEND_THRESHOLD) {
              // Residual visual offset: blend remaining error out smoothly.
              this.lanPredictionOffset.x += errX;
              this.lanPredictionOffset.y += errY;
              this.lanPredictionOffsetAlpha = Math.min(
                1,
                this.lanPredictionOffsetAlpha + Game.LAN_PREDICTION_ALPHA_INCREMENT,
              );
            }
          }
          // Sync health/battery regardless of position correction.
          localShip.health = sd.health;
          localShip.battery = sd.battery;
          if (!sd.alive) localShip.destroy();
        }
        continue;
      }

      let ship = this.state.playerShips.get(sd.slotIndex);
      if (!ship) {
        // Lazily create remote ship on first snapshot.
        ship = new PlayerShip(new Vec2(sd.x, sd.y), sd.team as Team);
        this.state.playerShips.set(sd.slotIndex, ship);
      }
      ship.position.x = sd.x;
      ship.position.y = sd.y;
      ship.velocity.x = sd.vx;
      ship.velocity.y = sd.vy;
      ship.angle = sd.angle;
      ship.health = sd.health;
      ship.battery = sd.battery;
      if (!sd.alive && ship.alive) ship.destroy();
    }

    // --- Buildings ---
    // Build a lookup map for fast id-based matching.
    const buildingById = new Map<number, BuildingBase>();
    for (const b of this.state.buildings) buildingById.set(b.id, b);

    for (const sb of snapshot.buildings) {
      const b = buildingById.get(sb.id);
      if (b) {
        // Update existing building.
        b.health = sb.health;
        b.buildProgress = sb.buildProgress;
        b.powered = sb.powered;
        if (b instanceof ResearchLab) {
          b.researchItem = sb.researchItem ?? null;
          b.footprintCells = b.researchItem ? 3 : null;
          b.showExactUpgrade = b.team === this.localPlayerTeam();
          if (sb.isResearching !== undefined) b.isResearching = sb.isResearching;
        }
        if (b instanceof ShieldGenerator) {
          b.shield = sb.shield ?? b.shield;
          b.restartDelay = sb.shieldRestartDelay ?? b.restartDelay;
        }
        if (!sb.alive && b.alive) b.destroy();
      } else if (sb.alive) {
        // Building not known locally — create it from snapshot so remote clients
        // can see buildings placed after match start.
        const def = buildDefForEntityType(sb.entityType as EntityType);
        if (def) {
          const newBuilding = createBuildingFromDef(def, new Vec2(sb.x, sb.y), sb.team as Team);
          // Force id to match host's authoritative id so future snapshots find it.
          (newBuilding as unknown as { id: number }).id = sb.id;
          newBuilding.health = sb.health;
          newBuilding.buildProgress = sb.buildProgress;
          newBuilding.powered = sb.powered;
          if (newBuilding instanceof ResearchLab) {
            newBuilding.researchItem = sb.researchItem ?? null;
            newBuilding.footprintCells = newBuilding.researchItem ? 3 : null;
            newBuilding.showExactUpgrade = newBuilding.team === this.localPlayerTeam();
            if (sb.isResearching !== undefined) newBuilding.isResearching = sb.isResearching;
          }
          if (newBuilding instanceof ShieldGenerator) {
            newBuilding.shield = sb.shield ?? newBuilding.shield;
            newBuilding.restartDelay = sb.shieldRestartDelay ?? newBuilding.restartDelay;
          }
          this.state.addEntity(newBuilding);
          this.state.power.markDirty();
        }
      }
    }
    // Remove buildings on this client that the host no longer reports.
    // (Destroyed by host — not included in snapshot at all.)
    const snapshotBuildingIds = new Set(snapshot.buildings.map((sb) => sb.id));
    for (const b of this.state.buildings) {
      if (b.alive && !snapshotBuildingIds.has(b.id)) {
        b.destroy();
      }
    }

    // --- Fighters ---
    // Build a set of ids present in the snapshot for quick membership tests.
    const snapshotFighterIds = new Set<number>();
    const snapshotFighterById = new Map<number, SerializedFighter>();
    for (const sf of snapshot.fighters) {
      snapshotFighterIds.add(sf.id);
      snapshotFighterById.set(sf.id, sf);
    }

    // Update or remove existing client-side fighters.
    for (const f of this.state.fighters) {
      if (!f.alive) continue;
      const sf = snapshotFighterById.get(f.id);
      if (sf) {
        // Update position/velocity from snapshot.
        f.position.x = sf.x;
        f.position.y = sf.y;
        f.velocity.x = sf.vx;
        f.velocity.y = sf.vy;
        f.angle = sf.angle;
        if (sf.advancedTier) f.upgradeToAdvanced();
        if (!sf.alive && f.alive) f.destroy();
      } else {
        // Fighter has been removed from host state (dead/docked) — destroy locally.
        if (f.alive) f.destroy();
      }
    }

    // Create placeholder fighters for ids that don't exist locally.
    const existingFighterIds = new Set(this.state.fighters.map((f) => f.id));
    for (const sf of snapshot.fighters) {
      if (existingFighterIds.has(sf.id) || !sf.alive) continue;
      const isBomber = sf.entityType === EntityType.Bomber;
      const newFighter = isBomber
        ? new BomberShip(new Vec2(sf.x, sf.y), sf.team as Team, ShipGroup.Red, null)
        : new FighterShip(new Vec2(sf.x, sf.y), sf.team as Team, ShipGroup.Red, null);
      if (sf.advancedTier) newFighter.upgradeToAdvanced();
      // Force the id to match the host's id so future snapshots can find it.
      (newFighter as unknown as { id: number }).id = sf.id;
      newFighter.velocity.x = sf.vx;
      newFighter.velocity.y = sf.vy;
      newFighter.angle = sf.angle;
      newFighter.docked = false;
      this.state.addEntity(newFighter);
    }

    // --- Projectiles ---
    // Only update position/velocity of existing projectiles.
    // New projectiles are NOT created from snapshots to avoid duplicating
    // collision/damage effects that the host simulation already owns.
    // Projectiles that vanish from snapshots are left to expire naturally.
    const snapshotProjectileById = new Map<number, SerializedProjectile>();
    for (const sp of snapshot.projectiles) snapshotProjectileById.set(sp.id, sp);

    for (const p of this.state.projectiles) {
      if (!p.alive) continue;
      const sp = snapshotProjectileById.get(p.id);
      if (sp) {
        // Nudge position toward host state (interpolation rather than snap).
        p.position.x += (sp.x - p.position.x) * Game.LAN_PROJECTILE_POSITION_BLEND;
        p.position.y += (sp.y - p.position.y) * Game.LAN_PROJECTILE_POSITION_BLEND;
        p.velocity.x = sp.vx;
        p.velocity.y = sp.vy;
      }
    }

    if (Array.isArray(snapshot.factionsByTeam)) {
      this.state.factionByTeam.clear();
      for (const f of snapshot.factionsByTeam) this.state.factionByTeam.set(f.team as Team, f.faction);
    }
    if (Array.isArray(snapshot.territoryCircles)) {
      this.state.territoryCirclesByTeam.clear();
      for (const c of snapshot.territoryCircles) {
        const arr = this.state.territoryCirclesByTeam.get(c.team as Team) ?? [];
        arr.push({ ...c });
        this.state.territoryCirclesByTeam.set(c.team as Team, arr);
      }
    }
    // --- Resources per slot ---
    if (Array.isArray(snapshot.resourcesPerSlot)) {
      const myRes = snapshot.resourcesPerSlot[this.lanMySlot];
      if (typeof myRes === 'number') this.state.resources = myRes;
    }
  }

  /**
   * Broadcast the authoritative game state snapshot to the server for
   * relay to all remote clients. Called by the host at SNAPSHOT_INTERVAL.
   * Includes ships, buildings, fighters, projectiles, and resources per slot.
   */
  /**
   * Build the game snapshot data object. Used by both LAN and online transports.
   * Returns an object with the serialized game state for broadcasting to clients.
   */
  private buildGameSnapshotData(): {
    seq: number;
    gameTime: number;
    ships: SerializedShip[];
    buildings: SerializedBuilding[];
    fighters: SerializedFighter[];
    projectiles: SerializedProjectile[];
    resourcesPerSlot: number[];
    hostSlot: number;
    factionsByTeam: Array<{ team: number; faction: string }>;
    territoryCircles: SerializedTerritoryCircle[];
    lastProcessedInputSeqBySlot: number[] | undefined;
  } {
    // --- Ships ---
    const ships: SerializedShip[] = [];
    for (const [slot, ship] of this.state.playerShips) {
      ships.push({
        slotIndex: slot,
        team: ship.team,
        x: ship.position.x,
        y: ship.position.y,
        vx: ship.velocity.x,
        vy: ship.velocity.y,
        angle: ship.angle,
        health: ship.health,
        maxHealth: ship.maxHealth,
        battery: ship.battery,
        shield: ship.shield,
        alive: ship.alive,
      });
    }

    // --- Buildings ---
    const buildings: SerializedBuilding[] = [];
    const factionsByTeam = Array.from(this.state.factionByTeam.entries()).map(([team, faction]) => ({ team, faction }));
    const territoryCircles: SerializedTerritoryCircle[] = [];
    for (const [team, circles] of this.state.territoryCirclesByTeam.entries()) {
      for (const c of circles) territoryCircles.push({ ...c, team });
    }
    for (const b of this.state.buildings) {
      if (!b.alive) continue;
      buildings.push({
        id: b.id,
        entityType: b.type,
        team: b.team,
        x: b.position.x,
        y: b.position.y,
        health: b.health,
        maxHealth: b.maxHealth,
        buildProgress: b.buildProgress,
        powered: b.powered,
        alive: b.alive,
        researchItem: b instanceof ResearchLab ? b.researchItem ?? undefined : undefined,
        isResearching: b instanceof ResearchLab ? b.isResearching : undefined,
        shield: b instanceof ShieldGenerator ? b.shield : undefined,
        shieldRestartDelay: b instanceof ShieldGenerator ? b.restartDelay : undefined,
      });
    }

    // --- Fighters (only alive, undocked fighters to keep snapshot small) ---
    const fighters: SerializedFighter[] = [];
    for (const f of this.state.fighters) {
      if (!f.alive || f.docked) continue;
      fighters.push({
        id: f.id,
        entityType: f.type,
        team: f.team,
        x: f.position.x,
        y: f.position.y,
        vx: f.velocity.x,
        vy: f.velocity.y,
        angle: f.angle,
        alive: f.alive,
        advancedTier: f.advancedTier,
      });
    }

    // --- Projectiles ---
    const projectiles: SerializedProjectile[] = [];
    for (const p of this.state.projectiles) {
      if (!p.alive) continue;
      projectiles.push({
        id: p.id,
        entityType: p.type,
        team: p.team,
        x: p.position.x,
        y: p.position.y,
        vx: p.velocity.x,
        vy: p.velocity.y,
        angle: p.angle,
      });
    }

    // Resources indexed by slot (sparse, sized to MAX_SLOTS from protocol).
    const MAX_LAN_SLOTS = 8;
    const resourcesPerSlot: number[] = new Array(MAX_LAN_SLOTS).fill(0);
    resourcesPerSlot[this.lanMySlot] = this.state.resources;

    // Per-slot last processed input seq array for prediction replay.
    let lastProcessedInputSeqBySlot: number[] | undefined;
    if (this.lanLastProcessedSeqPerSlot.size > 0) {
      lastProcessedInputSeqBySlot = [];
      for (const [slot, seq] of this.lanLastProcessedSeqPerSlot) {
        lastProcessedInputSeqBySlot[slot] = seq;
      }
    }

    return {
      seq: this.lanSnapshotSeq++,
      gameTime: this.state.gameTime,
      ships,
      buildings,
      fighters,
      projectiles,
      resourcesPerSlot,
      hostSlot: 0,
      factionsByTeam,
      territoryCircles,
      lastProcessedInputSeqBySlot,
    };
  }

  private broadcastLanSnapshot(): void {
    if (!this.lanClient?.connected) return;
    const data = this.buildGameSnapshotData();
    this.lanClient.sendGameSnapshot({
      ...data,
      factionsByTeam: data.factionsByTeam as Array<{ team: number; faction: import('./lan/protocol.js').FactionType }>,
    });
  }

  /**
   * Send this client's local input to the server (for the host to apply).
   * Called every tick for non-host LAN clients.
   */
  private sendLanInput(): void {
    if (!this.lanClient?.connected) return;
    const aimWorld = this.camera.screenToWorld(Input.mousePos);
    const seq = this.lanInputSeq++;
    const dx = (Input.isDown('d') ? 1 : 0) - (Input.isDown('a') ? 1 : 0);
    const dy = (Input.isDown('s') ? 1 : 0) - (Input.isDown('w') ? 1 : 0);
    const boost = Input.isDown('Shift');

    this.lanClient.sendInputSnapshot({
      seq,
      dx,
      dy,
      aimX: aimWorld.x,
      aimY: aimWorld.y,
      firePrimary: Input.mouseDown,
      fireSpecial: Input.mouse2Down,
      boost,
    });

    // Buffer this input for prediction replay (trimmed to ring size).
    this.lanUnacknowledgedInputs.push({ seq, dx, dy, aimX: aimWorld.x, aimY: aimWorld.y, boost });
    if (this.lanUnacknowledgedInputs.length > Game.LAN_INPUT_RING_MAX) {
      this.lanUnacknowledgedInputs.shift();
    }
  }

  /**
   * Apply buffered remote-player inputs to their corresponding ships.
   * Host-only: called once per tick before GameState.update().
   */
  private applyRemoteLanInputs(): void {
    for (const [slot, inp] of this.lanRemoteInputs) {
      const ship = this.state.playerShips.get(slot);
      if (!ship || !ship.alive) continue;
      // Aim
      ship.setAimPoint(new Vec2(inp.aimX, inp.aimY));
      // Inject virtual thrust as velocity impulse (mirrors PlayerShip.handleInput)
      const len = Math.hypot(inp.dx, inp.dy);
      if (len > 0.01) {
        const ux = inp.dx / len;
        const uy = inp.dy / len;
        ship.velocity = ship.velocity.add(new Vec2(ux * ship.thrustPower * DT, uy * ship.thrustPower * DT));
        ship.thrustDir = new Vec2(ux, uy);
        ship.isThrusting = true;
      } else {
        ship.isThrusting = false;
      }
      // Fire a basic bullet on behalf of the remote player when they press LMB.
      // This keeps firing host-authoritative while giving remote players a weapon.
      if (inp.firePrimary) {
        this.fireRemotePlayerWeapon(ship);
      }
    }
  }

  /**
   * Host fires a basic bullet on behalf of a remote player ship.
   * This is intentionally simple (always fires the base Bullet) to avoid
   * duplicating weapon logic; per-weapon remote firing can be added later.
   */
  private fireRemotePlayerWeapon(ship: PlayerShip): void {
    if (!ship.canFirePrimary()) return;
    const aim = ship.aimWorld;
    const angle = Math.atan2(aim.y - ship.position.y, aim.x - ship.position.x);
    ship.consumePrimaryFire(PLAYER_FIRE_COOLDOWN * ship.fireCooldownMultiplier);
    this.state.addEntity(new Bullet(
      ship.team,
      ship.position.clone(),
      angle,
      ship,
      findClosestEnemy(this.state, ship.position, ship.team, 520),
    ));
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private render(): void {
    const ctx = this.ctx;
    const w = this.screenW;
    const h = this.screenH;
    const dpr = w > 0 ? this.canvas.width / w : (window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = gameFont(12);

    // Clear with the selected space colour's solid fill, then overlay its
    // radial depth gradient so the background has subtle depth without washing
    // out gameplay objects.
    const space = activeSpaceColor();
    ctx.fillStyle = this.cinematicLevel <= -2 ? '#000000' : space.gameFill;
    ctx.fillRect(0, 0, w, h);

    // Rebuild the background gradient when the canvas size or space colour changes.
    if (
      space.gameGradient !== null &&
      (this.bgGradient === null || this.bgGradientW !== w || this.bgGradientH !== h || this.bgGradientKey !== space.id)
    ) {
      this.bgGradientW = w;
      this.bgGradientH = h;
      this.bgGradientKey = space.id;
      const grad = ctx.createRadialGradient(w * 0.35, h * 0.25, 0, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.72);
      for (const [offset, colour] of space.gameGradient) grad.addColorStop(offset, colour);
      this.bgGradient = grad;
    }
    if (this.cinematicLevel > -2 && space.gameGradient !== null && this.bgGradient !== null) {
      ctx.fillStyle = this.bgGradient;
      ctx.fillRect(0, 0, w, h);
    }

    // Star Nest volumetric background — rendered to an offscreen WebGL canvas
    // and composited here, before all other scene layers.
    if (this.cinematicLevel > -2) {
      this.starNest.update(this.lastFrameMs / 1000, this.camera);
      this.starNest.drawTo(ctx, w, h);
    }

    if (this.phase === 'menu') {
      this.drawScaledUi(() => this.mainMenu.draw(ctx, w / this.uiZoom, h / this.uiZoom));
      return;
    }

    this.glowLayer.begin();

    // Draw game world
    // Layer 1: distant suns / solar glow (deepest parallax background)
    this.distantSuns.draw(ctx, this.camera, w, h);
    if (this.cinematicLevel > -2 && space.nebula) this.nebula.draw(ctx, this.camera, w, h);
    // Base territory glow — faint team-coloured halos that grow with the base.
    // Drawn before the starfield so the stars appear on top of the tinted space.
    drawBaseTerritoryGlow(ctx, this.camera, this.state, w, h);
    this.starfield.draw(ctx, this.camera, w, h);
    // Layer 2: asteroid field (disabled via asteroidFieldLayers:0; kept for code stability)
    if (this.cinematicLevel > -2) this.asteroidField.draw(ctx, this.camera, w, h);
    // Crystal nebula clouds — behind gameplay entities, in front of starfield.
    if (this.cinematicLevel >= -2) this.crystalNebula.draw(ctx, this.camera, this.glowLayer, this.visualPreset);
    // Advance the fluid simulation by the frame delta and draw it under the game world.
    this.spaceFluid.step(this.lastFrameMs);
    this.spaceFluid.render(ctx);
    drawConfluenceTerritory(ctx, this.camera, this.state, this.territoryPulseTime);
    this.state.grid.draw(
      ctx,
      this.camera,
      w,
      h,
      this.state.gameTime,
      (cx, cy, team) => this.state.power.isCellEnergized(team, cx, cy),
      this.visualPreset.conduitShimmer,
    );
    if (this.visualPreset.conduitPulseEnabled) {
      this.state.grid.drawConduitPulses(
        ctx,
        this.camera,
        w,
        h,
        this.state.gameTime,
        (cx, cy, team) => this.state.power.isCellEnergized(team, cx, cy),
        (cx, cy, team) => this.state.power.getFlowDir(team, cx, cy),
      );
    }
    this.state.drawEntities(ctx, this.camera);
    drawBaseLockwardEffect(ctx, this.camera, this.state);
    drawGhostSpectator(ctx, this.camera, this.state, this.playerRespawn);
    drawWaypointMarkers(ctx, this.camera, this.state, this.waypointMarkers);
    drawGlowLayer(this.glowLayer, this.camera, this.state, this.visualPreset, renderBudget.renderLoadScale);
    this.glowLayer.compositeTo(ctx);
    // Keep command selections and the live drag box crisp above world glows.
    drawCommandModeOverlay(
      ctx,
      w,
      this.camera,
      this.state,
      this.commandModeState.selectedFighters,
      this.commandModeState.selectedTurrets,
      this.commandModeState.dragStart,
      this.commandModeState.dragCurrent,
    );

    // Edge indicators (always)
    drawEdgeIndicators(ctx, this.camera, this.state, w, h);

    // Full radar overlay (hold Tab)
    if (Input.isDown('Tab')) {
      drawRadarOverlay(ctx, this.state, w, h, this.waypointMarkers);
    }

    drawScreenOverlays(ctx, w, h, this.camera, this.visualPreset, this.damageFlashTimer, this.overlayCache);
    drawLossOverlay(ctx, w, this.playerRespawn.loss);

    const uiW = w / this.uiZoom;
    const uiH = h / this.uiZoom;
    this.actionMenu.draw(ctx, this.state, this.camera, w, h);
    this.drawScaledUi(() => {
      this.hud.draw(ctx, uiW, uiH);
      Input.drawTouchJoysticks(ctx);
      this.hud.drawAIChat(ctx, uiW, uiH);
      this.fighterGroupStatus.draw(ctx, this.state, uiW, uiH, this.state.gameTime);
    });
    drawBuildingHoverHitpoints(ctx, this.camera, this.state, this.lastFrameMs / 1000);
    ctx.save();
    ctx.scale(this.uiZoom, this.uiZoom);
    const synonymousPlayer = isSynonymousFaction(this.state.factionByTeam, Team.Player);
    this.hud.drawResources(
      ctx,
      synonymousPlayer ? this.state.synonymous.getUnallocatedCount(Team.Player) : this.state.resources,
      this.state.getPlayerIncomePerSecond(),
      uiW,
      uiH,
      synonymousPlayer
        ? { currencySymbol: SYNONYMOUS_CURRENCY_SYMBOL, symbolOnRight: true, symbolFont: 'menu' }
        : undefined,
    );
    if (this.state.player.alive) {
      this.hud.drawPlayerEnergy(
        ctx,
        this.state.player.battery,
        this.state.player.maxBattery,
        this.state.player.health,
        this.state.player.maxHealth,
        this.state.player.shield,
        this.state.player.maxShield,
        this.state.player.passiveHealthRegenActive,
        uiW,
        uiH,
        this.actionMenu.open,
      );
      this.hud.drawResearchStatus(ctx, this.state.researchProgress, this.state.researchedItems.size, uiH);
      if (!synonymousPlayer) {
        // Count unpowered player buildings, excluding only power sources.
        let unpowered = 0;
        for (const b of this.state.buildings) {
          if (!b.alive || b.team !== Team.Player) continue;
          if (b.buildProgress < 1) continue;
          if (
            b.type === EntityType.CommandPost ||
            b.type === EntityType.PowerGenerator ||
            b.type === EntityType.Wall
          ) continue;
          if (!b.powered) unpowered++;
        }
        this.hud.drawPowerStatus(ctx, unpowered, uiH);
      }
    }

    // Practice / Vs. AI mode HUD
    if ((this.state.gameMode === 'practice' || this.state.gameMode === 'vs_ai')
        && !this.practiceMode.gameOver) {
      this.drawPracticeHUD(ctx, uiW, uiH);
    }
    ctx.restore();

    if (this.debugOverlay) {
      drawCombatTargetingDebug(ctx, this.camera, this.state);
      drawDebugOverlay(ctx, {
        screenW: w,
        state: this.state,
        lastFrameMs: this.lastFrameMs,
        fixedUpdateMs: this.lastFixedUpdateMs,
        renderMs: this.lastRenderMs,
        lanClient: this.lanClient,
        lanMySlot: this.lanMySlot,
        lanLastSnapshotSeq: this.lanLastSnapshotSeq,
        lanSnapshotSeq: this.lanSnapshotSeq,
        lanAiDirectorCount: this.lanAiDirectors.length,
        lanPredictionError: this.lanPredictionOffsetAlpha > 0
          ? Math.hypot(this.lanPredictionOffset.x, this.lanPredictionOffset.y)
          : 0,
        crystalMoteCount: this.crystalNebula.visibleMoteCount,
        visualQuality: this.visualQuality,
      });
    }

    // Pause overlay
    if (this.phase === 'paused') {
      this.drawScaledUi(() => this.mainMenu.draw(ctx, w / this.uiZoom, h / this.uiZoom));
    }
  }

  private drawScaledUi(draw: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.uiZoom, this.uiZoom);
    draw();
    ctx.restore();
  }

  private drawPracticeHUD(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.font = '12px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colorToCSS(Colors.general_building, 0.7);
    const right = w - 12;
    const lines: string[] = [];
    const cfg = this.mainMenu.vsAIConfig;
    if (this.state.gameMode === 'practice') {
      lines.push('Game mode: Practice');
      lines.push('Modifiers: none');
    } else {
      const modeName = cfg.mode === 'survival' ? 'Survival' : 'Vs. AI';
      lines.push(`Game mode: ${cfg.ranked ? `Ranked ${modeName}` : modeName}`);

      const modifiers: string[] = [];
      if (cfg.cheatFullMapKnowledge) modifiers.push('Full Map');
      if (cfg.cheat125xResources) modifiers.push('1.25x Res');
      const multiplier = cfg.ranked ? ` x${rankedScoreMultiplier(cfg).toFixed(2)}` : '';
      lines.push(`Modifiers: ${modifiers.length > 0 ? modifiers.join(', ') : 'none'}${multiplier}`);

      if (cfg.ranked && cfg.mode === 'survival') {
        const survivalScore = this.currentRankedSurvivalScoreBreakdown();
        lines.push(
          `Time survived ${survivalScore.timeSeconds}s x${survivalScore.difficultyMultiplier.toFixed(2)} = ${survivalScore.score}`,
        );
      } else if (cfg.ranked) {
        lines.push(`Rank: ${cfg.difficulty} ${cfg.aiRank} | Score: ${rankedScore(cfg)}`);
      }
    }

    let y = 10;
    for (const line of lines) {
      ctx.fillText(line, right, y);
      y += 16;
    }

    // Keep both changing values in at least three-digit slots so their labels
    // stay fixed when a counter crosses from tens into hundreds.
    const bases = String(this.practiceMode.score.basesDestroyed);
    const elapsed = String(Math.floor(this.practiceMode.score.timeSurvived));
    const basesSlotWidth = Math.max(ctx.measureText('000').width, ctx.measureText(bases).width);
    const elapsedSlotWidth = Math.max(ctx.measureText('000').width, ctx.measureText(elapsed).width);
    let cursor = right;
    ctx.fillText('s', cursor, y);
    cursor -= ctx.measureText('s').width;
    ctx.fillText(elapsed, cursor, y);
    cursor -= elapsedSlotWidth;
    ctx.fillText(' | Time: ', cursor, y);
    cursor -= ctx.measureText(' | Time: ').width;
    ctx.fillText(bases, cursor, y);
    cursor -= basesSlotWidth;
    ctx.fillText('Bases destroyed: ', cursor, y);

    // AI strategy debug info — shown when debug overlay is active.
    if (this.debugOverlay) {
      const info = this.practiceMode.getStrategyDebugInfo(this.state);
      if (info) {
        const lines = [
          `AI Strategy Debug:`,
          `  Urgency: ${info.urgency}  Player: ${info.playerStrategy}`,
          `  Shipyards: ${info.currentShipyards} / ${info.targetShipyards} (target)`,
          `  Turrets placed/queued: G ${info.aiBuildingCounts.gatlingturret ?? 0}/${info.aiQueuedBuildingCounts.gatlingturret ?? 0}  M ${info.aiBuildingCounts.missileturret ?? 0}/${info.aiQueuedBuildingCounts.missileturret ?? 0}  E ${info.aiBuildingCounts.exciterturret ?? 0}/${info.aiQueuedBuildingCounts.exciterturret ?? 0}  D ${info.aiBuildingCounts.massdriverturret ?? 0}/${info.aiQueuedBuildingCounts.massdriverturret ?? 0}`,
          `  Staged: ${info.stagedCount} / ${info.waveLaunchThreshold} (wave threshold)`,
          `  Last wave: ${Math.floor(info.secsSinceLastWave)}s ago`,
          `  Failed waves: ${info.consecutiveFailedWaves}`,
        ];
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
        let y = h - 10;
        for (let i = lines.length - 1; i >= 0; i--) {
          ctx.fillText(lines[i], 10, y);
          y -= 15;
        }
      }
    }
  }

  private playerSpeedFraction(): number {
    const speed = Math.hypot(this.state.player.velocity.x, this.state.player.velocity.y);
    const maxSpeed = this.state.player.maxSpeed * (this.state.player.isBoosting ? 1.8 : 1);
    return maxSpeed > 0 ? Math.min(1, Math.max(0, speed / maxSpeed)) : 0;
  }

  private fighterMaxSpeed(fighter: FighterShip): number {
    return fighter instanceof BomberShip || fighter instanceof SynonymousNovaBomberShip
      ? SHIP_STATS.bomber.speed
      : SHIP_STATS.fighter.speed;
  }

}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(value) ? value : 1));
}

function loadZoomSetting(key: string): number {
  try {
    const raw = window.localStorage?.getItem(key);
    return clampZoom(raw ? Number.parseFloat(raw) : 1);
  } catch {
    return 1;
  }
}

function saveZoomSetting(key: string, value: number): void {
  try {
    window.localStorage?.setItem(key, clampZoom(value).toFixed(2));
  } catch {
    // Ignore storage failures; the current session still uses the setting.
  }
}
