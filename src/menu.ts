/**
 * Main menu, pause menu, and pre-match setup screens for Sign99.
 *
 * All menus are fully clickable: every visible menu element exposes a
 * hit rectangle, hovered items glow, clicked items pulse and play a
 * selection sound. Existing keyboard shortcuts (Up/Down/Enter/Esc) are
 * preserved so the change is purely additive.
 *
 * Menu states:
 *   title          – top-level
 *   play           - Play submenu (Vs. AI only until multiplayer is implemented)
 *   vs_ai_setup    – Vs. AI setup screen
 *   practice_setup – Practice setup screen
 *   pause          – in-game pause overlay
 *   none           – menu hidden
 *
 * The screen ↔ MenuAction mapping is the public contract with game.ts.
 */

import { Colors, TextColors, colorToCSS } from './colors.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { buildLabel } from './version.js';
import { gameFont } from './fonts.js';
import { drawDecodedText } from './decodeText.js';
import { t as tr, LOCALES, LOCALE_NAMES, getLocale, setLocale, type Locale } from './i18n.js';
import { applyThemeColors, cycleThemeColor, themeColorLabel, themeSettings, type ThemeColorId } from './theme.js';
import {
  PracticeConfig,
  cloneDefaultPracticeConfig,
  DIFFICULTY_NAMES,
  DifficultyName,
  ResearchUnlock,
  VictoryCondition,
  DefeatCondition,
  MapSize,
} from './practiceconfig.js';
import {
  VsAIConfig,
  cloneDefaultVsAIConfig,
  cloneRankedVsAIConfig,
  clampRank,
  rankedApm,
  rankedDifficultyName,
  rankedMaxScore,
  rankedScoreMultiplier,
  SURVIVAL_RANKED_SCORE_KEY,
  VSAI_RANKED_SCORE_KEY,
} from './vsaiconfig.js';
import { LanClient } from './lan/lanClient.js';
import type { LobbyState, LobbySlot, AIDifficulty, MsgMatchStart, LanDiscoveredLobby } from './lan/protocol.js';
import { LAN_PROTOCOL_VERSION } from './lan/protocol.js';
import { normalizeLanTarget } from './lan/lanAddress.js';

/** Narrow LAN networking API exposed by electron/preload.cjs. Undefined in a plain browser. */
interface Sign99LanBridge {
  startHost(opts: { hostName?: string; port?: number }): Promise<{ ok: boolean; port?: number; lobbyId?: string; wsUrl?: string; error?: string }>;
  stopHost(): Promise<{ ok: boolean }>;
  startDiscovery(): Promise<{ ok: boolean; error?: string }>;
  stopDiscovery(): Promise<{ ok: boolean }>;
  getDiscoveredGames(): Promise<{ lobbies: LanDiscoveredLobby[] }>;
  onDiscoveredGamesChanged(handler: (lobbies: LanDiscoveredLobby[]) => void): () => void;
}
import { factionLabel, RACE_SELECTIONS, type RaceSelection } from './confluence.js';
import { WebRtcTransport, type WebRtcPeerConnectionState } from './online/webrtcTransport.js';
import type { MultiplayerTransport } from './net/transport.js';
import { SteamMultiplayerController } from './steam/SteamMultiplayerController.js';
import type { OnlineLobbyRow } from './online/onlineLobby.js';
import {
  createSupabaseClient,
  describeSupabaseError,
  ensureAnonymousSession,
  isSupabaseConfigured,
} from './online/supabaseClient.js';
import { OnlineLobbyManager } from './online/onlineLobby.js';
import { SignalingClient } from './online/signalingClient.js';
import { DEFAULT_VISUAL_QUALITY, type VisualQuality } from './visualquality.js';
import { clampCinematicLevel, type CinematicLevel } from './cinematic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MenuState =
  | 'title'
  | 'play'
  | 'vs_ai_setup'
  | 'practice_setup'
  | 'settings'
  | 'pause'
  | 'lan_type'
  | 'lan_host_lobby'
  | 'lan_browser'
  | 'lan_join'
  | 'lan_client_lobby'
  | 'online_multiplayer'
  | 'online_host_lobby'
  | 'online_join'
  | 'steam_lobby'
  | 'none';

export type MenuAction =
  | 'none'
  | 'tutorial'
  | 'start_practice'
  | 'start_vs_ai'
  | 'start_lan_host'
  | 'start_lan_client'
  | 'start_online_host'
  | 'start_online_client'
  | 'resume'
  | 'quit_to_menu';

interface SimpleOption {
  label: string;
  action: () => void;
  description?: string;
}

interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Background animation
// ---------------------------------------------------------------------------

interface BackgroundStar {
  x: number;
  y: number;
  speed: number;
  size: number;
  brightness: number;
  hue: number;
}

const BG_STAR_COUNT = 160;
const MENU_ACCENT_CYAN = 'rgba(112,244,255,';
const MENU_ACCENT_GOLD = 'rgba(255,218,116,';
const MENU_ACCENT_PINK = 'rgba(255,112,198,';

function createBackgroundStars(screenW: number, screenH: number): BackgroundStar[] {
  const stars: BackgroundStar[] = [];
  for (let i = 0; i < BG_STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * screenW,
      y: Math.random() * screenH,
      speed: 8 + Math.random() * 35,
      size: 0.5 + Math.random() * 1.5,
      brightness: 0.15 + Math.random() * 0.85,
      hue: Math.random(),
    });
  }
  return stars;
}

// ---------------------------------------------------------------------------
// Hit-test helpers
// ---------------------------------------------------------------------------

function pointInRect(px: number, py: number, r: HitRect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// ---------------------------------------------------------------------------
// MainMenu class
// ---------------------------------------------------------------------------

export class MainMenu {
  state: MenuState = 'title';
  /** Keyboard cursor index for Up/Down on simple list menus. */
  private selectedIndex: number = 0;
  /** Latched click pulse for visual feedback. */
  private clickPulse: { rect: HitRect; t: number } | null = null;

  private bgStars: BackgroundStar[] = [];
  private animTime: number = 0;
  private openedAt: number = performance.now() * 0.001;
  private lastScreenW: number = 0;
  private lastScreenH: number = 0;

  /** Persisted practice config; the setup screen mutates this in place. */
  practiceConfig: PracticeConfig = cloneDefaultPracticeConfig();
  /** Persisted Vs. AI config. */
  vsAIConfig: VsAIConfig = cloneDefaultVsAIConfig();

  /**
   * Current graphics quality level.  Set externally by game.ts via
   * applyVisualQuality() and read back from the settings / pause screens.
   * Defaults to medium until game.ts overrides it from localStorage.
   */
  visualQuality: VisualQuality = DEFAULT_VISUAL_QUALITY;
  cinematicLevel: CinematicLevel = 1;
  gameZoom: number = 1.0;
  uiZoom: number = 1.0;

  // -------------------------------------------------------------------------
  // LAN multiplayer state
  // -------------------------------------------------------------------------

  /** Shared LAN client used by both Host and Join screens. */
  lanClient: LanClient = new LanClient('ws://localhost:8787');

  /** Current lobby state received from the server. */
  private _lanLobby: LobbyState | null = null;

  /** Pending match-start info passed to game.ts via MenuAction. */
  private _lanMatchStart: MsgMatchStart | null = null;

  /** LAN browser discovered lobbies. */
  private _discoveredLobbies: LanDiscoveredLobby[] = [];
  private _lanDiscoveryError: string = '';

  /** Join screen: text being typed in the URL input field. */
  private _joinUrl: string = 'ws://192.168.1.';
  /** Join screen: whether the input field is focused (for typing). */
  private _joinInputActive: boolean = false;
  /** Join screen: player name to send. */
  private _joinName: string = 'Player';
  /** Join screen: which field is active: 'url' | 'name' */
  private _joinActiveField: 'url' | 'name' = 'url';
  private _joinUrlCursor: number = this._joinUrl.length;
  private _joinNameCursor: number = this._joinName.length;

  /** Returned to game.ts alongside start_lan_host / start_lan_client. */
  pendingLanMatchStart: MsgMatchStart | null = null;

  // -------------------------------------------------------------------------
  // Online (WebRTC) multiplayer state
  // -------------------------------------------------------------------------

  /** Pending online match start data — consumed by game.ts via takePendingOnlineMatchStart(). */
  private _pendingOnlineMatchStart: {
    transport: MultiplayerTransport;
    matchStart: MsgMatchStart;
  } | null = null;

  /** Active lobby row while hosting an online game (null when not hosting). */
  private _onlineLobbyRow: OnlineLobbyRow | null = null;

  /** Active online transport (set during host lobby or join flow). */
  private _onlineTransport: WebRtcTransport | null = null;

  /** Signaling client for the current online session. */
  private _onlineSignaling: SignalingClient | null = null;

  /** Heartbeat timer (ms) for the hosted online lobby. */
  private _onlineLobbyHeartbeatTimer: number = 0;
  private static readonly ONLINE_HEARTBEAT_INTERVAL = 30_000;

  /** Online host lobby: remote slots that have asked for WebRTC signaling. */
  private _onlineRequestedSlots: number[] = [];

  /** Online host lobby: remote slots whose WebRTC DataChannels are open. */
  private _onlineReadySlots: number[] = [];

  /** Concise online debug timeline shown in lobby screens. */
  private _onlineDebugLines: string[] = [];

  /** Online host: seed for the match (set when starting). */
  private _onlineSeed: number = 0;

  /** Join screen: room code being typed. */
  private _onlineRoomCode: string = '';
  /** Join screen: player name for online. */
  private _onlinePlayerName: string = 'Player';
  /** Join screen: which field active: 'code' | 'name' */
  private _onlineJoinActiveField: 'code' | 'name' = 'code';
  /** Join screen: status message. */
  private _onlineJoinStatus: string = '';
  /** Online root/host status message for Supabase setup and lobby errors. */
  private _onlineStatus: string = '';

  // -------------------------------------------------------------------------
  // Steam multiplayer (desktop build only)
  // -------------------------------------------------------------------------

  /** Lazily created — only when the Steam bridge is present. */
  private _steam: SteamMultiplayerController | null = null;
  /** Seed for the Steam match, chosen when the host clicks Start. */
  private _steamSeed = 0;

  /** Get (creating on first use) the Steam controller, or null on non-Steam builds. */
  private steam(): SteamMultiplayerController | null {
    if (!SteamMultiplayerController.isAvailable()) return null;
    if (!this._steam) {
      this._steam = new SteamMultiplayerController();
      this._steam.onChange = () => { /* redrawn every frame anyway */ };
    }
    return this._steam;
  }

  private leaveSteam(): void {
    void this._steam?.leave();
  }

  /** Hit rectangles registered during draw, consumed during update. */
  private hits: Array<{ rect: HitRect; key: string }> = [];

  /** Mouse state captured at the start of update(), used by draw()
   *  because Input.mousePressed is cleared by Input.update() before
   *  the per-frame render() call sees it. */
  private mousePressedLatched: boolean = false;
  private mouseXLatched: number = 0;
  private mouseYLatched: number = 0;
  private rankedSliderDragging: boolean = false;

  // Output set by setup screens after the user clicks their start button.
  private pendingAction: MenuAction = 'none';

  // -------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------

  openTitle(): void {
    this.state = 'title';
    this.selectedIndex = 0;
  }

  openPause(): void {
    this.state = 'pause';
    this.selectedIndex = 0;
  }

  close(): void {
    this.state = 'none';
  }

  private setState(s: MenuState): void {
    if (s !== 'lan_browser') this.stopLanDiscoveryListening();
    this.state = s;
    this.selectedIndex = 0;
    this.rankedSliderDragging = false;
    this.hits = [];
    this.openedAt = performance.now() * 0.001;
    Audio.playSound('menucursor');
  }

  // -------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------

  update(dt: number, screenW: number, screenH: number): MenuAction {
    this.animTime += dt;

    // Latch the mouse state *before* Input.update() resets `mousePressed`
    // later this tick. draw() consumes this latched state.
    // Sticky-OR semantics: only set true; the latch is cleared at the
    // end of draw(). This is needed because fixedUpdate() may run more
    // than once per rendered frame.
    if (Input.mousePressed) {
      this.mousePressedLatched = true;
      this.mouseXLatched = this.mouseX();
      this.mouseYLatched = this.mouseY();
    } else if (!this.mousePressedLatched) {
      // Keep the latched position fresh for hover tests when no click is queued.
      this.mouseXLatched = this.mouseX();
      this.mouseYLatched = this.mouseY();
    }

    if (screenW !== this.lastScreenW || screenH !== this.lastScreenH) {
      this.bgStars = createBackgroundStars(screenW, screenH);
      this.lastScreenW = screenW;
      this.lastScreenH = screenH;
    }

    for (const star of this.bgStars) {
      star.x -= star.speed * dt;
      if (star.x < 0) {
        star.x = screenW;
        star.y = Math.random() * screenH;
      }
    }

    if (this.clickPulse) {
      this.clickPulse.t -= dt;
      if (this.clickPulse.t <= 0) this.clickPulse = null;
    }

    // Steam: pull a ready match-start bundle (host or client) into the shared
    // online pending slot so game.ts consumes it exactly like the WebRTC path.
    if (this._steam) {
      const pending = this._steam.takePendingMatchStart();
      if (pending) {
        this._pendingOnlineMatchStart = pending;
        this.pendingAction = pending.matchStart.mySlot === 0 ? 'start_online_host' : 'start_online_client';
      }
    }

    // Resolve any pendingAction triggered last frame by setup-screen buttons.
    // Async LAN/online callbacks can set this while the menu is hidden.
    if (this.pendingAction !== 'none') {
      const out = this.pendingAction;
      this.pendingAction = 'none';
      return out;
    }

    if (this.state === 'none') return 'none';
    if (Input.mouseReleased || !Input.mouseDown) {
      this.rankedSliderDragging = false;
    }

    return this.handleSimpleListInput();
  }

  /**
   * For simple list-style menus (title / play / pause) we
   * support Up/Down/Enter from the keyboard. Setup menus handle all
   * input internally during draw.
   */
  private handleSimpleListInput(): MenuAction {
    const opts = this.currentSimpleOptions();
    if (!opts) return 'none';

    if (Input.wasPressed('ArrowUp')) {
      this.selectedIndex = (this.selectedIndex - 1 + opts.length) % opts.length;
      Audio.playSound('menucursor');
    }
    if (Input.wasPressed('ArrowDown')) {
      this.selectedIndex = (this.selectedIndex + 1) % opts.length;
      Audio.playSound('menucursor');
    }
    if (Input.wasPressed('Enter') || Input.wasPressed(' ')) {
      Audio.playSound('menuselection');
      opts[this.selectedIndex].action();
      return this.takePending();
    }
    if (this.state === 'pause' && Input.wasPressed('Escape')) {
      Audio.playSound('menuselection');
      this.pendingAction = 'resume';
      return this.takePending();
    }
    if (
      Input.wasPressed('Escape') &&
      (this.state === 'play' ||
        this.state === 'vs_ai_setup' ||
        this.state === 'practice_setup' ||
        this.state === 'settings' ||
        this.state === 'lan_type' ||
        this.state === 'online_multiplayer' ||
        this.state === 'online_join')
    ) {
      Audio.playSound('menucursor');
      this.setState('title');
    }

    return 'none';
  }

  private takePending(): MenuAction {
    const out = this.pendingAction;
    this.pendingAction = 'none';
    return out;
  }

  /**
   * Returns the simple-list options for the current state, or null if
   * the current state is a richer setup screen handled in draw().
   */
  private currentSimpleOptions(): SimpleOption[] | null {
    switch (this.state) {
      case 'title':
        return [
          { label: tr('menu.title.play'),     action: () => this.setState('play'),
            description: tr('menu.title.play.desc') },
          { label: tr('menu.title.practice'), action: () => this.setState('practice_setup'),
            description: tr('menu.title.practice.desc') },
          { label: tr('menu.title.tutorial'), action: () => { this.pendingAction = 'tutorial'; },
            description: tr('menu.title.tutorial.desc') },
          { label: tr('menu.title.settings'), action: () => this.setState('settings'),
            description: tr('menu.title.settings.desc') },
        ];
      case 'play':
        return [
          { label: tr('menu.play.vsAiUnranked'), action: () => {
            this.vsAIConfig = { ...this.vsAIConfig, mode: 'duel', ranked: false };
            this.setState('vs_ai_setup');
          }, description: tr('menu.play.vsAiUnranked.desc') },
          { label: tr('menu.play.vsAiRanked'), action: () => {
            this.vsAIConfig = { ...cloneRankedVsAIConfig(this.vsAIConfig), mode: 'duel' };
            this.setState('vs_ai_setup');
          }, description: tr('menu.play.vsAiRanked.desc') },
          { label: tr('menu.play.survivalUnranked'), action: () => {
            this.vsAIConfig = { ...this.vsAIConfig, mode: 'survival', ranked: false };
            this.setState('vs_ai_setup');
          }, description: tr('menu.play.survivalUnranked.desc') },
          { label: tr('menu.play.survivalRanked'), action: () => {
            this.vsAIConfig = { ...cloneRankedVsAIConfig(this.vsAIConfig), mode: 'survival' };
            this.setState('vs_ai_setup');
          }, description: tr('menu.play.survivalRanked.desc') },
          { label: tr('menu.play.lan'), action: () => this.setState('lan_type'),
            description: tr('menu.play.lan.desc') },
          { label: tr('menu.play.online'), action: () => this.setState('online_multiplayer'),
            description: tr('menu.play.online.desc') },
          { label: tr('common.back'), action: () => this.setState('title') },
        ];
      case 'lan_type':
        return [
          { label: tr('menu.lanType.host'), action: () => this.openHostLobby(),
            description: tr('menu.lanType.host.desc') },
          { label: tr('menu.lanType.find'), action: () => this.openLanBrowser(),
            description: tr('menu.lanType.find.desc') },
          { label: tr('menu.lanType.joinManual'), action: () => this.setState('lan_join'),
            description: tr('menu.lanType.joinManual.desc') },
          { label: tr('common.back'), action: () => this.setState('play') },
        ];
      case 'pause':
        return [
          { label: tr('menu.pause.resume'), action: () => { this.pendingAction = 'resume'; } },
          {
            label: tr('menu.pause.graphics', { value: visualQualityLabel(this.visualQuality) }),
            action: () => {
              const next: Record<VisualQuality, VisualQuality> = {
                ultraLow: 'low',
                low: 'medium',
                medium: 'high',
                high: 'ultraLow',
              };
              this.visualQuality = next[this.visualQuality];
            },
            description: tr('menu.pause.graphics.desc'),
          },
          { label: tr('menu.pause.audio'), action: () => { /* sliders render below */ },
            description: tr('menu.pause.audio.desc') },
          { label: tr('menu.pause.quit'), action: () => { this.pendingAction = 'quit_to_menu'; } },
        ];
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------
  // Drawing dispatch
  // -------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
    if (this.state === 'none') {
      // Even when invisible, clear the latch so a stray click held
      // across a state change doesn't fire after the menu reappears.
      this.mousePressedLatched = false;
      return;
    }
    this.hits = [];

    switch (this.state) {
      case 'title':           this.drawTitleScreen(ctx, screenW, screenH); break;
      case 'play':            this.drawPlayMenu(ctx, screenW, screenH); break;
      case 'vs_ai_setup':     this.drawVsAISetup(ctx, screenW, screenH); break;
      case 'practice_setup':  this.drawPracticeSetup(ctx, screenW, screenH); break;
      case 'settings':        this.drawSettings(ctx, screenW, screenH); break;
      case 'pause':           this.drawPauseMenu(ctx, screenW, screenH); break;
      case 'lan_type':        this.drawPlayMenu(ctx, screenW, screenH); break; // re-use play menu draw (simple list)
      case 'lan_host_lobby':  this.drawLanHostLobby(ctx, screenW, screenH); break;
      case 'lan_browser':     this.drawLanBrowser(ctx, screenW, screenH); break;
      case 'lan_join':        this.drawLanJoin(ctx, screenW, screenH); break;
      case 'lan_client_lobby':this.drawLanClientLobby(ctx, screenW, screenH); break;
      case 'online_multiplayer':  this.drawOnlineMultiplayer(ctx, screenW, screenH); break;
      case 'online_host_lobby':   this.drawOnlineHostLobby(ctx, screenW, screenH); break;
      case 'online_join':         this.drawOnlineJoin(ctx, screenW, screenH); break;
      case 'steam_lobby':         this.drawSteamLobby(ctx, screenW, screenH); break;
    }

    // Click-pulse overlay
    if (this.clickPulse && this.clickPulse.t > 0) {
      const t = this.clickPulse.t / 0.18;
      const r = this.clickPulse.rect;
      ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, t);
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    }

    // Always clear the latch at the end of a draw so the same click
    // never fires twice across consecutive frames.
    this.mousePressedLatched = false;
  }

  // -------------------------------------------------------------------
  // Background
  // -------------------------------------------------------------------

  private drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const bg = ctx.createRadialGradient(w * 0.72, h * 0.18, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
    bg.addColorStop(0, '#082746');
    bg.addColorStop(0.42, '#06142d');
    bg.addColorStop(1, '#13051f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const drift = this.animTime * 18;
    const auroraA = ctx.createLinearGradient(w * 0.08, h * 0.2, w * 0.92, h * 0.82);
    auroraA.addColorStop(0, MENU_ACCENT_CYAN + '0)');
    auroraA.addColorStop(0.35, MENU_ACCENT_CYAN + '0.10)');
    auroraA.addColorStop(0.58, MENU_ACCENT_PINK + '0.08)');
    auroraA.addColorStop(1, MENU_ACCENT_CYAN + '0)');
    ctx.fillStyle = auroraA;
    ctx.beginPath();
    ctx.ellipse(w * 0.54 + Math.sin(this.animTime * 0.23) * 34, h * 0.56, w * 0.52, h * 0.20, -0.18, 0, Math.PI * 2);
    ctx.fill();

    const auroraB = ctx.createLinearGradient(w * 0.2, h * 0.84, w * 0.95, h * 0.2);
    auroraB.addColorStop(0, MENU_ACCENT_GOLD + '0)');
    auroraB.addColorStop(0.45, MENU_ACCENT_GOLD + '0.07)');
    auroraB.addColorStop(1, MENU_ACCENT_CYAN + '0)');
    ctx.fillStyle = auroraB;
    ctx.beginPath();
    ctx.ellipse(w * 0.72, h * 0.34 + Math.cos(this.animTime * 0.19) * 18, w * 0.44, h * 0.16, -0.42, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.055);
    ctx.lineWidth = 1;
    const grid = 48;
    const ox = -((drift * 0.22) % grid);
    const oy = -((drift * 0.08) % grid);
    for (let x = ox; x < w; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + w * 0.12, h);
      ctx.stroke();
    }
    for (let y = oy; y < h; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y - h * 0.08);
      ctx.stroke();
    }
    ctx.restore();

    for (const star of this.bgStars) {
      const twinkle = 0.55 + 0.45 * Math.sin(this.animTime * (1.6 + star.hue * 2.2) + star.x * 0.01);
      ctx.fillStyle = star.hue > 0.82
        ? MENU_ACCENT_GOLD + `${star.brightness * twinkle * 0.65})`
        : colorToCSS(Colors.friendly_starfield, star.brightness * twinkle * 0.85);
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }

    const vignette = ctx.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  /** Draw the build-number badge in the top-right corner. */
  private drawBuildBadge(ctx: CanvasRenderingContext2D, w: number): void {
    const label = buildLabel();
    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const padX = 14;
    const padY = 12;

    // Subtle bracket around the build number to look like a tech version label.
    const tw = ctx.measureText(label).width;
    const x = w - padX - tw;
    const y = padY;

    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.45);
    ctx.lineWidth = 1;
    const pad = 6;
    ctx.beginPath();
    ctx.moveTo(x - pad - 4, y - 3);
    ctx.lineTo(x - pad,     y - 3);
    ctx.lineTo(x - pad,     y + 14);
    ctx.lineTo(x - pad - 4, y + 14);
    ctx.moveTo(x + tw + pad + 4, y - 3);
    ctx.lineTo(x + tw + pad,     y - 3);
    ctx.lineTo(x + tw + pad,     y + 14);
    ctx.lineTo(x + tw + pad + 4, y + 14);
    ctx.stroke();

    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
    ctx.fillText(label, w - padX, padY);
  }

  // -------------------------------------------------------------------
  // Title screen
  // -------------------------------------------------------------------

  private drawTitleScreen(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    const titleY = h * 0.24;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const ruleW = 320;
    this.drawLuminousFrame(ctx, cx - 235, titleY - 68, 470, 136, 0.72);

    ctx.strokeStyle = MENU_ACCENT_CYAN + '0.58)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - ruleW * 0.5, titleY - 36);
    ctx.lineTo(cx + ruleW * 0.5, titleY - 36);
    ctx.stroke();

    ctx.font = 'bold 58px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.save();
    ctx.shadowColor = MENU_ACCENT_CYAN + '0.95)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = colorToCSS(TextColors.titledark);
    ctx.fillText('SIGN 99', cx + 2, titleY + 2);
    const titleGrad = ctx.createLinearGradient(cx - 150, titleY - 28, cx + 150, titleY + 28);
    titleGrad.addColorStop(0, colorToCSS(TextColors.title, 0.92));
    titleGrad.addColorStop(0.5, 'rgba(247,255,230,1)');
    titleGrad.addColorStop(1, MENU_ACCENT_CYAN + '0.95)');
    ctx.fillStyle = titleGrad;
    ctx.fillText('SIGN 99', cx, titleY);
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(cx - ruleW * 0.5, titleY + 36);
    ctx.lineTo(cx + ruleW * 0.5, titleY + 36);
    ctx.stroke();

    const subtitleAlpha = 0.35 + 0.25 * Math.sin(this.animTime * 1.8);
    ctx.font = '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.shadow, subtitleAlpha);
    ctx.fillText(tr('title.subtitle'), cx, titleY + 56);

    const opts = this.currentSimpleOptions()!;
    this.drawClickableOptions(ctx, cx, h * 0.50, opts);

    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.35);
    ctx.fillText(tr('hint.clickOrArrows'), cx, h - 18);
  }

  private drawLuminousFrame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    alpha: number,
  ): void {
    const pulse = 0.55 + 0.45 * Math.sin(this.animTime * 2.1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createLinearGradient(x, y, x + w, y + h);
    glow.addColorStop(0, MENU_ACCENT_CYAN + `${0.06 * alpha})`);
    glow.addColorStop(0.55, MENU_ACCENT_PINK + `${0.04 * alpha})`);
    glow.addColorStop(1, MENU_ACCENT_GOLD + `${0.05 * alpha})`);
    ctx.fillStyle = glow;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = MENU_ACCENT_CYAN + `${(0.28 + pulse * 0.18) * alpha})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = MENU_ACCENT_GOLD + `${0.32 * alpha})`;
    const c = 22;
    ctx.beginPath();
    ctx.moveTo(x, y + c);
    ctx.lineTo(x, y);
    ctx.lineTo(x + c, y);
    ctx.moveTo(x + w - c, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + c);
    ctx.moveTo(x + w, y + h - c);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - c, y + h);
    ctx.moveTo(x + c, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - c);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------
  // Play submenu
  // -------------------------------------------------------------------

  private drawPlayMenu(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 38px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.title);
    const title = this.state === 'lan_type' ? 'LAN MULTIPLAYER' : 'PLAY';
    ctx.fillText(title, cx, h * 0.22);

    const opts = this.currentSimpleOptions()!;
    this.drawClickableOptions(ctx, cx, h * 0.45, opts);
  }

  // -------------------------------------------------------------------
  // Pause menu
  // -------------------------------------------------------------------

  private drawPauseMenu(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5;
    const headerY = h * 0.35;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = 'bold 38px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.title);
    const pausedLabel = tr('pause.heading');
    drawDecodedText(ctx, pausedLabel, cx, headerY, 38, this.openedAt, 'center');
    const tw = ctx.measureText(pausedLabel).width;
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - tw * 0.5, headerY + 22);
    ctx.lineTo(cx + tw * 0.5, headerY + 22);
    ctx.stroke();

    const settingsX = cx - 220;
    let y = headerY + 74;
    const rowH = 34;
    y = this.drawVolumeSliderRow(ctx, settingsX, y, rowH, 'Music Volume', Audio.getMusicVolume(), (v) => {
      Audio.setMusicVolume(v);
    });
    this.drawVolumeSliderRow(ctx, settingsX, y, rowH, 'SFX Volume', Audio.getSfxVolume(), (v) => {
      Audio.setSfxVolume(v);
    });

    const opts = this.currentSimpleOptions()!;
    const menuStartY = h * 0.63;
    this.drawClickableOptions(ctx, cx, menuStartY, opts.slice(0, 2), 0);
    this.drawCinematicSliderRow(ctx, settingsX, menuStartY + 108, rowH, this.cinematicLevel, (v) => {
      this.cinematicLevel = v;
    });
    this.drawClickableOptions(ctx, cx, menuStartY + 184, opts.slice(2), 2);
  }

  // -------------------------------------------------------------------
  // Clickable simple list
  // -------------------------------------------------------------------

  private drawClickableOptions(
    ctx: CanvasRenderingContext2D,
    cx: number,
    startY: number,
    options: SimpleOption[],
    indexOffset: number = 0,
  ): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lineH = 62;
    const barW = 380;
    const mx = this.mouseXLatched;
    const my = this.mouseYLatched;

    for (let i = 0; i < options.length; i++) {
      const y = startY + i * lineH;
      const rect: HitRect = {
        x: cx - barW * 0.5,
        y: y - lineH * 0.42,
        w: barW,
        h: lineH * 0.84,
      };
      const hovered = pointInRect(mx, my, rect);
      const actualIndex = indexOffset + i;
      const selected = actualIndex === this.selectedIndex;
      const highlight = hovered || selected;

      // Sync keyboard cursor with hover so feedback is unified.
      if (hovered && this.selectedIndex !== actualIndex) {
        this.selectedIndex = actualIndex;
      }

      if (highlight) {
        const alpha = 0.20 + (hovered ? 0.08 : 0) + 0.05 * Math.sin(this.animTime * 4);
        const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y);
        fill.addColorStop(0, MENU_ACCENT_CYAN + '0.04)');
        fill.addColorStop(0.5, MENU_ACCENT_CYAN + `${alpha})`);
        fill.addColorStop(1, MENU_ACCENT_GOLD + '0.05)');
        ctx.fillStyle = fill;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        this.drawLuminousFrame(ctx, rect.x, rect.y, rect.w, rect.h, hovered ? 0.92 : 0.62);

        ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.9);
        ctx.font = '24px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('>', cx - barW * 0.5 + 12, y);
        ctx.textAlign = 'right';
        ctx.fillText('<', cx + barW * 0.5 - 12, y);

        ctx.textAlign = 'center';
        ctx.font = 'bold 24px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = colorToCSS(Colors.radar_friendly_status);
        drawDecodedText(ctx, options[i].label, cx, y - 6, 24, this.openedAt, 'center');

        if (options[i].description) {
          ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
          ctx.fillStyle = colorToCSS(TextColors.normal, 0.78);
          drawDecodedText(ctx, options[i].description ?? '', cx, y + 18, 15, this.openedAt, 'center');
        }
      } else {
        ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.20);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rect.x + 18, y + lineH * 0.34);
        ctx.lineTo(rect.x + rect.w - 18, y + lineH * 0.34);
        ctx.stroke();
        ctx.font = '24px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
        ctx.fillStyle = colorToCSS(TextColors.normal, 0.68);
        ctx.textAlign = 'center';
        drawDecodedText(ctx, options[i].label, cx, y, 24, this.openedAt, 'center');
      }

      if (hovered && this.mousePressedLatched) {
        Audio.playSound('menuselection');
        this.clickPulse = { rect, t: 0.18 };
        this.mousePressedLatched = false; // consume so only one button fires
        Input.consumeMouseButton(0);
        options[i].action();
        return;
      }
    }
  }

  // -------------------------------------------------------------------
  // Practice setup screen
  // -------------------------------------------------------------------

  private drawPracticeSetup(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText(tr('practice.heading'), cx, 70);

    const cfg = this.practiceConfig;
    const colW = 460;
    const left = cx - colW;
    const right = cx + 12;
    let y = 130;
    const rowH = 38;

    // Left column
    y = this.drawDifficultyRow(ctx, left, y, rowH, tr('practice.enemyDifficulty'),
      cfg.difficulty, (v) => cfg.difficulty = v);
    y = this.drawRaceRow(ctx, left, y, rowH, tr('practice.playerRace'),
      cfg.playerRace, (v) => cfg.playerRace = v);
    y = this.drawRaceRow(ctx, left, y, rowH, tr('practice.enemyRace'),
      cfg.enemyRace, (v) => cfg.enemyRace = v);
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.playerResources'),
      cfg.playerStartingResources, 0, 5000, 50,
      (v) => cfg.playerStartingResources = v, (v) => `${v}`);
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.enemyResources'),
      cfg.enemyStartingResources, 0, 5000, 50,
      (v) => cfg.enemyStartingResources = v, (v) => `${v}`);
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.playerIncome'),
      cfg.playerIncomeMul, 0.25, 4.0, 0.25,
      (v) => cfg.playerIncomeMul = v, (v) => v.toFixed(2));
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.enemyIncome'),
      cfg.enemyIncomeMul, 0.25, 4.0, 0.25,
      (v) => cfg.enemyIncomeMul = v, (v) => v.toFixed(2));
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.enemyBuildSpeed'),
      cfg.enemyBuildSpeedMul, 0.25, 4.0, 0.25,
      (v) => cfg.enemyBuildSpeedMul = v, (v) => v.toFixed(2));
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.enemyMaxBuilders'),
      cfg.enemyMaxBuilders, 1, 10, 1,
      (v) => cfg.enemyMaxBuilders = v, (v) => `${v}`);
    y = this.drawSliderRow(ctx, left, y, rowH, tr('practice.builderRebuild'),
      cfg.enemyBuilderRebuildSeconds, 5, 120, 5,
      (v) => cfg.enemyBuilderRebuildSeconds = v, (v) => `${v}s`);

    // Right column
    let yr = 130;
    yr = this.drawDifficultyRow(ctx, right, yr, rowH, tr('practice.enemyAggression'),
      cfg.enemyAggression, (v) => cfg.enemyAggression = v);
    yr = this.drawDifficultyRow(ctx, right, yr, rowH, tr('practice.expansionSpeed'),
      cfg.enemyExpansionSpeed, (v) => cfg.enemyExpansionSpeed = v);
    yr = this.drawCycleRow<'tiny'|'small'|'medium'>(ctx, right, yr, rowH, tr('practice.startingBaseSize'),
      cfg.enemyStartingBaseSize, ['tiny','small','medium'],
      (v) => cfg.enemyStartingBaseSize = v);
    yr = this.drawCheckboxRow(ctx, right, yr, rowH, tr('vsai.fogOfWar'),
      cfg.fogOfWar, (v) => cfg.fogOfWar = v);
    yr = this.drawCycleRow<MapSize>(ctx, right, yr, rowH, tr('vsai.mapSize'),
      cfg.mapSize, ['small','medium','large'], (v) => cfg.mapSize = v);
    yr = this.drawSliderRow(ctx, right, yr, rowH, tr('vsai.startingDistance'),
      cfg.startingDistance, 1000, 5000, 200,
      (v) => cfg.startingDistance = v, (v) => `${v}`);
    yr = this.drawCycleRow<ResearchUnlock>(ctx, right, yr, rowH, tr('practice.researchUnlocked'),
      cfg.researchUnlocked,
      ['none','basic_turrets','all_turrets','full_tech'],
      (v) => cfg.researchUnlocked = v,
      researchUnlockLabel);
    yr = this.drawCycleRow<VictoryCondition>(ctx, right, yr, rowH, tr('practice.victoryCondition'),
      cfg.victoryCondition, ['destroy_cp','survive_waves','sandbox'],
      (v) => cfg.victoryCondition = v, victoryLabel);
    yr = this.drawCycleRow<DefeatCondition>(ctx, right, yr, rowH, tr('practice.defeatCondition'),
      cfg.defeatCondition, ['cp_destroyed','ship_and_no_cp','disabled'],
      (v) => cfg.defeatCondition = v, defeatLabel);

    // Buttons
    const btnY = h - 60;
    this.drawButtonRow(ctx, [
      { label: tr('common.resetDefaults'), action: () => {
        this.practiceConfig = cloneDefaultPracticeConfig(); } },
      { label: tr('common.back'),           action: () => this.setState('title') },
      { label: tr('practice.start'), action: () => { this.pendingAction = 'start_practice'; },
        emphasis: true },
    ], cx, btnY);
  }

  // -------------------------------------------------------------------
  // Vs. AI setup screen
  // -------------------------------------------------------------------

  private drawVsAISetup(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    const cfg = this.vsAIConfig;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.title);
    const modeTitle = cfg.mode === 'survival' ? tr('vsai.survival') : tr('vsai.vsAi');
    ctx.fillText(tr('vsai.headerFmt', { mode: modeTitle, rank: cfg.ranked ? tr('vsai.ranked') : tr('vsai.unranked') }), cx, 70);

    const colW = 460;
    const left = cx - colW;
    const right = cx + 12;
    const rowH = 38;
    let y = 140;

    if (cfg.ranked) {
      this.enforceRankedVsAIConfig(cfg);
      this.drawRankedHighScore(ctx, cx, 112);
      y = 172;
      y = this.drawLargeRankSliderRow(ctx, cx - 310, y, 76, cfg);
      y += 10;
      y = this.drawRaceRow(ctx, cx - 210, y, rowH, tr('practice.playerRace'),
        cfg.playerRace, (v) => cfg.playerRace = v);
      y = this.drawRaceRow(ctx, cx - 210, y, rowH, tr('vsai.aiRace'),
        cfg.aiRace, (v) => cfg.aiRace = v);
      y = this.drawCheckboxRow(ctx, cx - 210, y, rowH, tr('vsai.aiFullMapKnowledgeBonus'),
        cfg.cheatFullMapKnowledge, (v) => cfg.cheatFullMapKnowledge = v);
      y = this.drawCheckboxRow(ctx, cx - 210, y, rowH, tr('vsai.aiResourcesBonus'),
        cfg.cheat125xResources, (v) => cfg.cheat125xResources = v);
      ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.78);
      ctx.fillText(`Ranked score multiplier: x${rankedScoreMultiplier(cfg).toFixed(2)}`, cx - 210, y + 10);
    } else {
      y = this.drawDifficultyRow(ctx, left, y, rowH, tr('vsai.aiDifficulty'),
        cfg.difficulty, (v) => cfg.difficulty = v);
      y = this.drawRaceRow(ctx, left, y, rowH, tr('practice.playerRace'),
        cfg.playerRace, (v) => cfg.playerRace = v);
      y = this.drawRaceRow(ctx, left, y, rowH, tr('vsai.aiRace'),
        cfg.aiRace, (v) => cfg.aiRace = v);
      y = this.drawSliderRow(ctx, left, y, rowH, 'AI APM (-1 = derived)',
        cfg.aiApm, -1, 400, 5,
        (v) => cfg.aiApm = v, (v) => v < 0 ? 'auto' : `${v}`);
      y = this.drawSliderRow(ctx, left, y, rowH, tr('vsai.startingResources'),
        cfg.startingResources, 0, 5000, 50,
        (v) => cfg.startingResources = v, (v) => `${v}`);
      y = this.drawCycleRow<MapSize>(ctx, left, y, rowH, tr('vsai.mapSize'),
        cfg.mapSize, ['small','medium','large'], (v) => cfg.mapSize = v);

      let yr = 140;
      yr = this.drawSliderRow(ctx, right, yr, rowH, tr('vsai.startingDistance'),
        cfg.startingDistance, 1000, 5000, 200,
        (v) => cfg.startingDistance = v, (v) => `${v}`);
      yr = this.drawCheckboxRow(ctx, right, yr, rowH, tr('vsai.fogOfWar'),
        cfg.fogOfWar, (v) => cfg.fogOfWar = v);

      ctx.font = 'bold 18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
      ctx.fillText(tr('vsai.cheaterOptions'), right, yr + 8);
      yr += 28;

      yr = this.drawCheckboxRow(ctx, right, yr, rowH, tr('vsai.aiFullMapKnowledge'),
        cfg.cheatFullMapKnowledge, (v) => cfg.cheatFullMapKnowledge = v);
      yr = this.drawCheckboxRow(ctx, right, yr, rowH, tr('vsai.aiResources'),
        cfg.cheat125xResources, (v) => cfg.cheat125xResources = v);
    }

    const btnY = h - 60;
    this.drawButtonRow(ctx, [
      { label: tr('common.resetDefaults'), action: () => {
        this.vsAIConfig = { ...(cfg.ranked ? cloneRankedVsAIConfig() : cloneDefaultVsAIConfig()), mode: cfg.mode }; } },
      { label: tr('common.back'),     action: () => this.setState('play') },
      { label: cfg.mode === 'survival' ? tr('vsai.startSurvival') : tr('vsai.startVsAi'), action: () => { this.pendingAction = 'start_vs_ai'; },
        emphasis: true },
    ], cx, btnY);
  }

  private drawSettings(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(34);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText(tr('settings.heading'), cx, 90);

    const x = cx - 230;
    let y = 160;
    const rowH = 44;

    const LOCALE_OPTIONS: Locale[] = [...LOCALES];
    y = this.drawCycleRow<Locale>(
      ctx, x, y, rowH, tr('settings.language'),
      getLocale(),
      LOCALE_OPTIONS,
      (v) => { setLocale(v); },
      (v) => LOCALE_NAMES[v],
    );

    const QUALITY_OPTIONS: VisualQuality[] = ['ultraLow', 'low', 'medium', 'high'];
    y = this.drawCycleRow<VisualQuality>(
      ctx, x, y, rowH, tr('settings.graphicsQuality'),
      this.visualQuality,
      QUALITY_OPTIONS,
      (v) => { this.visualQuality = v; },
      visualQualityLabel,
      QUALITY_OPTIONS.indexOf(this.visualQuality) / (QUALITY_OPTIONS.length - 1),
    );

    y = this.drawThemeColorRow(ctx, x, y, rowH, tr('settings.playerColor'), themeSettings.playerColor, (v) => {
      themeSettings.playerColor = v;
      applyThemeColors();
    });
    y = this.drawThemeColorRow(ctx, x, y, rowH, tr('settings.enemyColor'), themeSettings.enemyColor, (v) => {
      themeSettings.enemyColor = v;
      applyThemeColors();
    });
    y = this.drawVolumeSliderRow(ctx, x, y, rowH, tr('settings.musicVolume'), Audio.getMusicVolume(), (v) => {
      Audio.setMusicVolume(v);
    });
    y = this.drawVolumeSliderRow(ctx, x, y, rowH, tr('settings.sfxVolume'), Audio.getSfxVolume(), (v) => {
      Audio.setSfxVolume(v);
    });
    y = this.drawZoomSliderRow(ctx, x, y, rowH, tr('settings.gameZoom'), this.gameZoom, (v) => {
      this.gameZoom = v;
    });
    y = this.drawZoomSliderRow(ctx, x, y, rowH, tr('settings.uiZoom'), this.uiZoom, (v) => {
      this.uiZoom = v;
    });

    ctx.font = gameFont(16);
    ctx.textAlign = 'center';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.75);
    ctx.fillText(tr('settings.fontNote'), cx, y + 36);

    this.drawDiscordButton(ctx, cx, y + 86);

    this.drawButtonRow(ctx, [
      { label: tr('common.back'), action: () => this.setState('title'), emphasis: true },
    ], cx, h - 70);
  }

  private drawDiscordButton(ctx: CanvasRenderingContext2D, cx: number, y: number): void {
    const rect: HitRect = { x: cx - 250, y: y - 30, w: 500, h: 60 };
    const hovered = pointInRect(this.mouseX(), this.mouseY(), rect);
    const pulse = 0.5 + Math.sin(this.animTime * 3) * 0.5;

    ctx.save();
    ctx.shadowColor = 'rgba(88, 101, 242, 0.9)';
    ctx.shadowBlur = hovered ? 28 : 15 + pulse * 7;
    const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    fill.addColorStop(0, hovered ? '#7289ff' : '#5865f2');
    fill.addColorStop(1, hovered ? '#5865f2' : '#404eed');
    ctx.fillStyle = fill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = hovered ? 2 : 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tr('settings.discord.title'), cx, y - 7);
    ctx.font = '14px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.fillText(tr('settings.discord.subtitle'), cx, y + 17);
    ctx.restore();

    if (this.handleClick(rect)) {
      window.open('https://discord.gg/dSwR3Fj7du', '_blank', 'noopener,noreferrer');
    }
  }

  private enforceRankedVsAIConfig(cfg: VsAIConfig): void {
    cfg.ranked = true;
    cfg.difficulty = rankedDifficultyName(cfg.aiRank);
    cfg.aiApm = -1;
    cfg.startingResources = 300;
    cfg.mapSize = 'medium';
    cfg.startingDistance = 3000;
    cfg.fogOfWar = true;
  }

  private drawRankedHighScore(ctx: CanvasRenderingContext2D, cx: number, y: number): void {
    const best = this.readRankedHighScore();
    const pulse = 0.55 + 0.35 * Math.sin(this.animTime * 3.6);
    const label = tr('vsai.highestScore', { score: best });
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.shadowColor = colorToCSS(Colors.alert2, 0.85);
    ctx.shadowBlur = 16 + 10 * pulse;
    const grad = ctx.createLinearGradient(cx - 170, y, cx + 170, y);
    grad.addColorStop(0, colorToCSS(Colors.radar_friendly_status, 0.95));
    grad.addColorStop(0.5, colorToCSS(Colors.alert2, 1));
    grad.addColorStop(1, colorToCSS(TextColors.title, 0.95));
    ctx.fillStyle = grad;
    ctx.fillText(label, cx, y);
    ctx.restore();
  }

  private readRankedHighScore(): number {
    try {
      const raw = window.localStorage?.getItem(
        this.vsAIConfig.mode === 'survival' ? SURVIVAL_RANKED_SCORE_KEY : VSAI_RANKED_SCORE_KEY,
      );
      const parsed = raw ? Number.parseInt(raw, 10) : 0;
      if (!Number.isFinite(parsed)) return 0;
      return this.vsAIConfig.mode === 'survival'
        ? Math.max(0, parsed)
        : Math.max(0, Math.min(rankedMaxScore(), parsed));
    } catch {
      return 0;
    }
  }

  private drawLargeRankSliderRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    cfg: VsAIConfig,
  ): number {
    const sx = x + 180;
    const sw = 620;
    const trackY = y + 28;
    const rank = clampRank(cfg.aiRank);
    const t = rank / 3000;
    const knobX = sx + t * sw;

    ctx.font = 'bold 21px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
    ctx.fillText(tr('vsai.aiRankTrack'), x, trackY);

    const grad = ctx.createLinearGradient(sx, trackY, sx + sw, trackY);
    grad.addColorStop(0, colorToCSS(Colors.radar_friendly_status, 0.75));
    grad.addColorStop(0.55, colorToCSS(Colors.alert2, 0.9));
    grad.addColorStop(1, colorToCSS(Colors.alert1, 1));
    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.65);
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, trackY - 8, sw, 16);
    ctx.fillStyle = grad;
    ctx.fillRect(sx + 1, trackY - 7, Math.max(0, knobX - sx - 1), 14);
    ctx.fillStyle = colorToCSS(TextColors.title, 0.95);
    ctx.beginPath();
    ctx.arc(knobX, trackY, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = 'bold 24px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.95);
    ctx.fillText(`${rank}`, sx + sw + 18, trackY - 8);
    ctx.font = '15px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.78);
    ctx.fillText(`${rankedDifficultyName(rank)} / ${rankedApm(rank)} APM`, sx + sw + 18, trackY + 16);

    const track: HitRect = { x: sx, y: trackY - 18, w: sw, h: 36 };
    if (this.mousePressedLatched && pointInRect(this.mouseXLatched, this.mouseYLatched, track)) {
      this.rankedSliderDragging = true;
      this.clickPulse = { rect: track, t: 0.18 };
      this.mousePressedLatched = false;
    }
    if (this.rankedSliderDragging && Input.mouseDown) {
      const tt = Math.max(0, Math.min(1, (this.mouseX() - sx) / sw));
      const nextRank = Math.round((tt * 3000) / 100) * 100;
      if (nextRank !== cfg.aiRank) {
        cfg.aiRank = nextRank;
        cfg.difficulty = rankedDifficultyName(nextRank);
        Audio.playSound('menucursor');
      }
    }

    return y + h;
  }

  private drawThemeColorRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    label: string,
    value: ThemeColorId,
    onChange: (v: ThemeColorId) => void,
  ): number {
    this.drawRowLabel(ctx, x, y, label);
    const valX = x + 200;
    const arrowW = 24;
    const valW = 240;
    const leftRect: HitRect = { x: valX, y: y - 14, w: arrowW, h: 28 };
    const rightRect: HitRect = { x: valX + valW - arrowW, y: y - 14, w: arrowW, h: 28 };
    const bodyRect: HitRect = { x: valX + arrowW, y: y - 14, w: valW - arrowW * 2, h: 28 };
    this.drawArrow(ctx, leftRect, '<');
    this.drawArrow(ctx, rightRect, '>');
    ctx.font = gameFont(18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
    ctx.fillText(themeColorLabel(value), bodyRect.x + bodyRect.w / 2, y);
    if (this.handleClick(leftRect)) onChange(cycleThemeColor(value, -1));
    if (this.handleClick(rightRect) || this.handleClick(bodyRect)) onChange(cycleThemeColor(value, 1));
    return y + h;
  }

  // -------------------------------------------------------------------
  // Setup widget primitives
  // -------------------------------------------------------------------

  /** Returns y of next row. */
  private drawDifficultyRow(
    ctx: CanvasRenderingContext2D, x: number, y: number, h: number,
    label: string, value: DifficultyName,
    onChange: (v: DifficultyName) => void,
  ): number {
    const idx = DIFFICULTY_NAMES.indexOf(value);
    return this.drawCycleRow<DifficultyName>(
      ctx, x, y, h, label, value, DIFFICULTY_NAMES, onChange,
      (v) => v, // identity
      idx / Math.max(1, DIFFICULTY_NAMES.length - 1),
    );
  }

  private drawRaceRow(
    ctx: CanvasRenderingContext2D, x: number, y: number, h: number,
    label: string, value: RaceSelection,
    onChange: (v: RaceSelection) => void,
  ): number {
    return this.drawCycleRow<RaceSelection>(
      ctx, x, y, h, label, value, RACE_SELECTIONS, onChange, factionLabel,
    );
  }

  private drawCycleRow<T>(
    ctx: CanvasRenderingContext2D, x: number, y: number, h: number,
    label: string, value: T, values: T[],
    onChange: (v: T) => void,
    fmt?: (v: T) => string,
    intensity: number = 0,
  ): number {
    this.drawRowLabel(ctx, x, y, label);

    const valX = x + 200;
    const arrowW = 20;
    const valW = 220;

    const leftRect: HitRect = { x: valX, y: y - 12, w: arrowW, h: 24 };
    const rightRect: HitRect = { x: valX + valW - arrowW, y: y - 12, w: arrowW, h: 24 };
    const bodyRect: HitRect = { x: valX + arrowW, y: y - 12, w: valW - arrowW * 2, h: 24 };

    // Optional intensity tint (used for difficulty)
    if (intensity > 0) {
      const r = Math.floor(40 + 200 * intensity);
      const g = Math.floor(180 - 140 * intensity);
      ctx.fillStyle = `rgba(${r},${g},40,${0.10 + 0.10 * intensity})`;
      ctx.fillRect(bodyRect.x, bodyRect.y, bodyRect.w, bodyRect.h);
    }
    this.drawControlWell(ctx, bodyRect, pointInRect(this.mouseX(), this.mouseY(), bodyRect), intensity);

    this.drawArrow(ctx, leftRect, '<');
    this.drawArrow(ctx, rightRect, '>');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
      ctx.font = '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
    const text = fmt ? fmt(value) : String(value);
    ctx.fillText(text, bodyRect.x + bodyRect.w / 2, y);

    if (this.handleClick(leftRect)) {
      const i = values.indexOf(value);
      onChange(values[(i - 1 + values.length) % values.length]);
    }
    if (this.handleClick(rightRect)) {
      const i = values.indexOf(value);
      onChange(values[(i + 1) % values.length]);
    }
    if (this.handleClick(bodyRect)) {
      const i = values.indexOf(value);
      onChange(values[(i + 1) % values.length]);
    }
    return y + h;
  }

  private drawSliderRow(
    ctx: CanvasRenderingContext2D, x: number, y: number, h: number,
    label: string, value: number, min: number, max: number, step: number,
    onChange: (v: number) => void,
    fmt: (v: number) => string,
    showTicks: boolean = false,
  ): number {
    this.drawRowLabel(ctx, x, y, label);

    const sx = x + 200;
    const sw = 220;
    const trackY = y;
    const track: HitRect = { x: sx, y: trackY - 8, w: sw, h: 16 };

    const t = (value - min) / Math.max(1e-6, max - min);
    const knobX = sx + Math.max(0, Math.min(1, t)) * sw;

    const hovered = pointInRect(this.mouseX(), this.mouseY(), track);
    this.drawControlWell(ctx, { x: sx - 2, y: trackY - 8, w: sw + 4, h: 16 }, hovered, t);

    if (showTicks) {
      const tickCount = Math.max(1, Math.round((max - min) / step));
      ctx.save();
      ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.78);
      ctx.lineWidth = 1;
      for (let i = 0; i <= tickCount; i++) {
        const tx = sx + (i / tickCount) * sw;
        ctx.beginPath();
        ctx.moveTo(tx, trackY - 8);
        ctx.lineTo(tx, trackY + 8);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Filled portion
    const fill = ctx.createLinearGradient(sx, trackY, sx + sw, trackY);
    fill.addColorStop(0, MENU_ACCENT_CYAN + '0.86)');
    fill.addColorStop(1, MENU_ACCENT_GOLD + '0.76)');
    ctx.fillStyle = fill;
    ctx.fillRect(sx, trackY - 2, knobX - sx, 4);

    // Knob
    ctx.save();
    ctx.shadowColor = MENU_ACCENT_CYAN + '0.85)';
    ctx.shadowBlur = hovered ? 18 : 10;
    ctx.fillStyle = colorToCSS(Colors.radar_friendly_status);
    ctx.beginPath();
    ctx.arc(knobX, trackY, hovered ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Value
    ctx.font = '16px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.85);
    ctx.fillText(fmt(value), sx + sw + 12, y);

    if (this.handleClick(track) || (Input.mouseDown && pointInRect(this.mouseX(), this.mouseY(), track))) {
      const tt = Math.max(0, Math.min(1, (this.mouseX() - sx) / sw));
      let v = min + tt * (max - min);
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      if (v !== value) {
        onChange(v);
        Audio.playSound('menucursor');
      }
    }

    return y + h;
  }

  private drawVolumeSliderRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
  ): number {
    return this.drawSliderRow(
      ctx,
      x,
      y,
      h,
      label,
      Math.round(Math.max(0, Math.min(1, value)) * 100),
      0,
      100,
      5,
      (v) => onChange(v / 100),
      (v) => `${Math.round(v)}%`,
    );
  }

  private drawCinematicSliderRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    value: CinematicLevel,
    onChange: (v: CinematicLevel) => void,
  ): number {
    return this.drawSliderRow(
      ctx,
      x,
      y,
      h,
      'Cinematic Slider',
      value,
      -3,
      9,
      1,
      (v) => onChange(clampCinematicLevel(v)),
      (v) => String(Math.round(v)),
      true,
    );
  }

  private drawZoomSliderRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
  ): number {
    return this.drawSliderRow(
      ctx,
      x,
      y,
      h,
      label,
      Math.round(value * 100),
      75,
      175,
      5,
      (v) => onChange(v / 100),
      (v) => `${Math.round(v)}%`,
    );
  }

  private drawCheckboxRow(
    ctx: CanvasRenderingContext2D, x: number, y: number, h: number,
    label: string, value: boolean, onChange: (v: boolean) => void,
  ): number {
    this.drawRowLabel(ctx, x, y, label);

    const box: HitRect = { x: x + 200, y: y - 9, w: 18, h: 18 };
    this.drawControlWell(ctx, box, pointInRect(this.mouseX(), this.mouseY(), box), value ? 1 : 0);
    if (value) {
      ctx.fillStyle = MENU_ACCENT_CYAN + '0.90)';
      ctx.fillRect(box.x + 4, box.y + 4, box.w - 8, box.h - 8);
    }

    if (this.handleClick(box)) onChange(!value);
    return y + h;
  }

  private drawRowLabel(
    ctx: CanvasRenderingContext2D, x: number, y: number, label: string,
  ): void {
    ctx.font = '17px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.9);
    ctx.fillText(label, x, y);
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D, rect: HitRect, glyph: string,
  ): void {
    const hovered = pointInRect(this.mouseX(), this.mouseY(), rect);
    this.drawControlWell(ctx, rect, hovered, hovered ? 0.8 : 0);

    ctx.font = '18px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorToCSS(
      hovered ? Colors.radar_friendly_status : TextColors.normal,
      hovered ? 1.0 : 0.85,
    );
    ctx.fillText(glyph, rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  private drawControlWell(ctx: CanvasRenderingContext2D, rect: HitRect, hovered: boolean, intensity: number): void {
    const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    fill.addColorStop(0, `rgba(3,16,30,${hovered ? 0.72 : 0.52})`);
    fill.addColorStop(0.55, MENU_ACCENT_CYAN + `${0.035 + intensity * 0.055})`);
    fill.addColorStop(1, MENU_ACCENT_GOLD + `${hovered ? 0.065 : 0.025})`);
    ctx.fillStyle = fill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = hovered ? MENU_ACCENT_CYAN + '0.82)' : colorToCSS(Colors.radar_gridlines, 0.48);
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }

  private drawButtonRow(
    ctx: CanvasRenderingContext2D,
    buttons: Array<{ label: string; action: () => void; emphasis?: boolean }>,
    cx: number, y: number,
  ): void {
    const btnW = 180;
    const gap = 24;
    const totalW = buttons.length * btnW + (buttons.length - 1) * gap;
    let bx = cx - totalW / 2;

    for (const b of buttons) {
      const rect: HitRect = { x: bx, y: y - 18, w: btnW, h: 36 };
      const hovered = pointInRect(this.mouseX(), this.mouseY(), rect);

      const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y);
      fill.addColorStop(0, b.emphasis ? MENU_ACCENT_CYAN + `${hovered ? 0.22 : 0.13})` : 'rgba(8,24,36,0.46)');
      fill.addColorStop(0.65, b.emphasis ? MENU_ACCENT_GOLD + `${hovered ? 0.16 : 0.08})` : MENU_ACCENT_CYAN + `${hovered ? 0.08 : 0.035})`);
      fill.addColorStop(1, MENU_ACCENT_PINK + `${hovered ? 0.11 : 0.035})`);
      ctx.fillStyle = fill;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (b.emphasis || hovered) this.drawLuminousFrame(ctx, rect.x, rect.y, rect.w, rect.h, hovered ? 0.86 : 0.54);

      ctx.strokeStyle = colorToCSS(
        b.emphasis ? Colors.radar_friendly_status : Colors.radar_gridlines,
        hovered ? 0.95 : 0.6,
      );
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

      ctx.font = 'bold 14px "Poiret One", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colorToCSS(TextColors.normal, hovered ? 1.0 : 0.85);
      ctx.fillText(b.label, rect.x + rect.w / 2, rect.y + rect.h / 2);

      if (this.handleClick(rect)) b.action();

      bx += btnW + gap;
    }
  }

  // -------------------------------------------------------------------
  // LAN: private helpers
  // -------------------------------------------------------------------

  /** Narrow bridge exposed by electron/preload.cjs — undefined in a plain browser. */
  private get lanBridge(): Sign99LanBridge | undefined {
    return (window as Window & { sign99Lan?: Sign99LanBridge }).sign99Lan;
  }

  private async openHostLobby(): Promise<void> {
    this.setState('lan_host_lobby');
    this._lanLobby = null;

    const bridge = this.lanBridge;
    if (!bridge) {
      // Plain browser (no Electron): the LAN relay must already be running
      // externally via `npm run dev:lan`. Connect straight to it.
      this.beginLanConnection('ws://localhost:8787', true);
      return;
    }

    this.lanClient.disconnect();
    this.lanClient.lastError = '';
    const result = await bridge.startHost({ hostName: this._joinName || 'Host' });
    if (!result?.ok) {
      this.lanClient.lastError = result?.error
        ? `Could not start LAN hosting: ${result.error}`
        : 'Could not start LAN hosting. Close any other Sign99RTS host and check your firewall settings.';
      return;
    }
    this.beginLanConnection(result.wsUrl ?? 'ws://127.0.0.1:8787', true);
  }

  /** Shared setup for both hosting (connecting to our own freshly-started local server) and joining. */
  private beginLanConnection(url: string, isHostConnection: boolean): void {
    this.lanClient.disconnect();
    this.lanClient = new LanClient(url);
    this._lanLobby = null;

    this.lanClient.onLobbyUpdate = (lobby) => {
      this._lanLobby = lobby;
      if (!isHostConnection && (this.state === 'lan_join' || this.state === 'lan_browser')) {
        this.setState('lan_client_lobby');
      }
    };
    this.lanClient.onJoinRejected = (reason) => {
      this.lanClient.lastError = reason;
    };
    this.lanClient.onKicked = () => {
      this._lanLobby = null;
      this.setState('lan_type');
    };
    this.lanClient.onMatchStart = (msg) => {
      this._lanMatchStart = msg;
      this.pendingLanMatchStart = msg;
      this.pendingAction = isHostConnection ? 'start_lan_host' : 'start_lan_client';
    };
    this.lanClient.onMatchEnd = (reason) => {
      this._lanLobby = null;
      this.lanClient.lastError = reason;
      if (this.state === 'lan_client_lobby' || this.state === 'lan_host_lobby') {
        this.setState('lan_type');
      }
    };
    this.lanClient.onDisconnected = () => {
      this._lanLobby = null;
      if (!isHostConnection && this.state === 'lan_client_lobby') {
        this.setState('lan_type');
      }
    };
    this.lanClient.onError = (message) => {
      this.lanClient.lastError = message;
    };

    if (!isHostConnection) {
      // Non-host: wait for the server's explicit "ready to join" signal
      // (server_connected) before sending join_request — this is a
      // deterministic protocol handshake, not a race on socket-open timing.
      this.lanClient.onServerReady = () => {
        this.lanClient.sendJoinRequest(this._joinName || 'Player', LAN_PROTOCOL_VERSION, buildLabel());
      };
    }

    this.lanClient.connect();
  }

  private connectToJoinUrl(): void {
    if (this.lanClient.busy) return; // guards against duplicate rapid-click connects
    const normalized = normalizeLanTarget(this._joinUrl);
    if (!normalized.ok) {
      this.lanClient.lastError = normalized.error;
      return;
    }
    this.beginLanConnection(normalized.url, false);
  }

  // -------------------------------------------------------------------
  // LAN: Host lobby screen
  // -------------------------------------------------------------------

  private drawLanHostLobby(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(28);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('HOST LOBBY', cx, 68);

    // Server setup instructions
    const st = this.lanClient.state;
    const statusText = st === 'lobby' ? `Hosting on ${this.lanClient.url} — share your LAN IP with others`
      : st === 'connecting' ? `Starting host at ${this.lanClient.url} …`
      : st === 'error' ? `Error: ${this.lanClient.lastError}`
      : this.lanClient.lastError ? this.lanClient.lastError
      : 'Disconnected';
    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(
      st === 'lobby' ? Colors.radar_friendly_status
      : st === 'error' ? Colors.alert1 : Colors.alert2, 0.85);
    ctx.fillText(statusText, cx, 100);

    // Show hint if not connected yet
    if (st !== 'lobby') {
      ctx.font = gameFont(11);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.65);
      ctx.fillText('If this stays here, another Sign99RTS host may already be running, or a firewall is blocking the port.', cx, 118);
    }

    // Slots table
    const lobby = this._lanLobby;
    this.drawSlotsTable(ctx, cx, h, lobby, true);

    // Hints at bottom
    ctx.font = gameFont(11);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.55);
    ctx.fillText('Host: add AI, cycle Team for allies/enemies, and set AI race/difficulty. Players can change race before readying.', cx, h - 120);
    ctx.fillStyle = colorToCSS(Colors.alert2, 0.55);
    ctx.fillText('⚠ For others to join, share your LAN IP — e.g. ws://192.168.1.25:8787', cx, h - 104);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.45);
    ctx.fillText('Note: GitHub Pages (HTTPS) blocks ws:// connections.  Use http://IP:5173 for local Vite hosting.', cx, h - 88);

    // Bottom buttons
    const allReady = lobby ? lobby.slots.every(s =>
      s.type !== 'human' || s.slotIndex === 0 || s.ready) : false;

    this.drawButtonRow(ctx, [
      { label: 'Back / Disconnect', action: () => {
        this.lanClient.disconnect();
        void this.lanBridge?.stopHost();
        this._lanLobby = null;
        this.lanClient.lastError = '';
        this.setState('lan_type');
      }},
      ...(st === 'lobby'
        ? [{ label: 'Start Match', emphasis: allReady, action: () => {
            this.lanClient.sendStartMatch();
          }}]
        : [{ label: 'Retry Connect', emphasis: true, action: () => {
            void this.openHostLobby();
          }}]),
    ], cx, h - 56);
  }


  /** Unsubscribe handle for the current onDiscoveredGamesChanged subscription, if any. */
  private _lanDiscoveryUnsub: (() => void) | null = null;
  /** True while this menu has asked the Electron main process to keep listening for LAN hosts. */
  private _lanDiscoveryListening: boolean = false;

  private openLanBrowser(): void {
    this._discoveredLobbies = [];
    this._lanDiscoveryError = '';
    this.setState('lan_browser');
    void this.startLanDiscoveryListening();
  }

  /** Start (or resume) discovery listening. Safe to call repeatedly. */
  private async startLanDiscoveryListening(): Promise<void> {
    const bridge = this.lanBridge;
    if (!bridge) {
      this._lanDiscoveryError = 'Automatic LAN discovery requires the desktop app. In a browser, use Join Manually with the host’s IP address.';
      return;
    }
    this._lanDiscoveryError = '';
    if (!this._lanDiscoveryUnsub) {
      this._lanDiscoveryUnsub = bridge.onDiscoveredGamesChanged((lobbies) => {
        this._discoveredLobbies = lobbies;
      });
    }
    const result = await bridge.startDiscovery();
    this._lanDiscoveryListening = !!result?.ok;
    if (!result?.ok) {
      this._lanDiscoveryError = result?.error
        ? `LAN discovery failed to start: ${result.error}`
        : 'LAN discovery failed to start. You can still enter the host URL manually.';
      return;
    }
    const initial = await bridge.getDiscoveredGames();
    this._discoveredLobbies = initial?.lobbies ?? [];
  }

  /** Stop discovery listening when leaving every LAN menu screen. Safe to call repeatedly. */
  private stopLanDiscoveryListening(): void {
    if (!this._lanDiscoveryListening) return;
    this._lanDiscoveryListening = false;
    void this.lanBridge?.stopDiscovery();
  }

  private drawLanBrowser(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);
    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(28);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('FIND LAN GAMES', cx, 68);
    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.8);
    ctx.fillText('Hosts on your local network are detected automatically.', cx, 96);
    if (this._lanDiscoveryError) { ctx.fillStyle = colorToCSS(Colors.alert2, 0.9); ctx.fillText(this._lanDiscoveryError, cx, 122); }
    const startY = 150;
    this._discoveredLobbies.forEach((lobby, i) => {
      const y = startY + i * 46;
      const rect = { x: cx - 320, y: y - 16, w: 640, h: 38 };
      const hover = pointInRect(this.mouseX(), this.mouseY(), rect);
      ctx.fillStyle = colorToCSS(Colors.friendly_background, hover ? 0.35 : 0.2);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      const age = Math.max(0, Math.floor((Date.now() - lobby.lastSeenAt) / 1000));
      const status = lobby.matchStarted ? 'In progress' : 'Open';
      ctx.font = gameFont(12);
      ctx.textAlign = 'left';
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
      ctx.fillText(`${lobby.hostName}  ${lobby.wsUrl}  ${lobby.openSlots}/${lobby.maxSlots} open  H:${lobby.occupiedHumanSlots} AI:${lobby.aiSlots}  ${status}  ${age}s ago`, rect.x + 8, y + 2);
      if (
        this.handleClick(rect) &&
        !lobby.matchStarted &&
        this.lanClient.state !== 'connecting' &&
        this.lanClient.state !== 'lobby'
      ) {
        this._joinUrl = lobby.wsUrl;
        this.connectToJoinUrl();
      }
    });
    this.drawButtonRow(ctx, [
      { label: tr('common.back'), action: () => this.setState('lan_type') },
      { label: 'Join Manually', action: () => this.setState('lan_join') },
      { label: 'Refresh LAN Games', emphasis: true, action: () => { void this.startLanDiscoveryListening(); } },
    ], cx, h - 56);
  }

  // -------------------------------------------------------------------
  // LAN: Join screen
  // -------------------------------------------------------------------

  private drawLanJoin(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(28);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('JOIN LOBBY', cx, 68);

    const fieldW = 400;
    const fieldX = cx - fieldW / 2;

    // ---- URL format hint ----
    ctx.font = gameFont(11);
    ctx.textAlign = 'center';
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
    ctx.fillText('Just the host IP works, e.g. 192.168.1.25 — or the full ws://192.168.1.25:8787', cx, 116);

    // ---- URL field ----
    ctx.font = gameFont(13);
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.75);
    ctx.fillText('Host WebSocket URL:', fieldX, 135);

    const urlRect: HitRect = { x: fieldX, y: 150, w: fieldW, h: 32 };
    const urlActive = this._joinActiveField === 'url';
    ctx.strokeStyle = colorToCSS(urlActive ? Colors.radar_friendly_status : Colors.radar_gridlines, urlActive ? 0.9 : 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(urlRect.x + 0.5, urlRect.y + 0.5, urlRect.w - 1, urlRect.h - 1);
    ctx.fillStyle = colorToCSS(Colors.friendly_background, 0.85);
    ctx.fillRect(urlRect.x + 1, urlRect.y + 1, urlRect.w - 2, urlRect.h - 2);
    ctx.font = gameFont(14);
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
    ctx.fillText(this._joinUrl, fieldX + 8, 167);
    this.drawJoinTextCaret(ctx, this._joinUrl, this._joinUrlCursor, urlActive, fieldX + 8, 167);
    if (this.handleClick(urlRect)) {
      this._joinActiveField = 'url';
      this._joinUrlCursor = this._joinUrl.length;
    }

    // ---- Name field ----
    ctx.font = gameFont(13);
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.75);
    ctx.fillText('Your name:', fieldX, 205);

    const nameRect: HitRect = { x: fieldX, y: 220, w: fieldW * 0.5, h: 32 };
    const nameActive = this._joinActiveField === 'name';
    ctx.strokeStyle = colorToCSS(nameActive ? Colors.radar_friendly_status : Colors.radar_gridlines, nameActive ? 0.9 : 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(nameRect.x + 0.5, nameRect.y + 0.5, nameRect.w - 1, nameRect.h - 1);
    ctx.fillStyle = colorToCSS(Colors.friendly_background, 0.85);
    ctx.fillRect(nameRect.x + 1, nameRect.y + 1, nameRect.w - 2, nameRect.h - 2);
    ctx.font = gameFont(14);
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(TextColors.normal, 0.95);
    ctx.fillText(this._joinName, fieldX + 8, 237);
    this.drawJoinTextCaret(ctx, this._joinName, this._joinNameCursor, nameActive, fieldX + 8, 237);
    if (this.handleClick(nameRect)) {
      this._joinActiveField = 'name';
      this._joinNameCursor = this._joinName.length;
    }

    // Handle keyboard input for the active field
    this.handleTextInput();

    // Status
    const st = this.lanClient.state;
    if (st === 'connecting') {
      ctx.font = gameFont(13);
      ctx.textAlign = 'center';
      ctx.fillStyle = colorToCSS(Colors.alert2, 0.9);
      ctx.fillText('Connecting…', cx, 280);
    } else if (st === 'error') {
      ctx.font = gameFont(13);
      ctx.textAlign = 'center';
      ctx.fillStyle = colorToCSS(Colors.alert1, 0.9);
      ctx.fillText(`Error: ${this.lanClient.lastError}`, cx, 280);
    }

    // Buttons
    this.drawButtonRow(ctx, [
      { label: tr('common.back'), action: () => {
        this.lanClient.disconnect();
        this.setState('lan_type');
      }},
      { label: 'Connect & Join', emphasis: true, action: () => {
        this.connectToJoinUrl();
      }},
    ], cx, h - 56);
  }

  // -------------------------------------------------------------------
  // LAN: Client lobby screen
  // -------------------------------------------------------------------

  private drawLanClientLobby(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(28);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('WAITING FOR HOST', cx, 68);

    const st = this.lanClient.state;
    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(
      st === 'lobby' ? Colors.radar_friendly_status : Colors.alert1, 0.85);
    ctx.fillText(st === 'lobby' ? 'Connected' : `Status: ${st}`, cx, 100);

    const lobby = this._lanLobby;
    this.drawSlotsTable(ctx, cx, h, lobby, false);

    // Ready button
    const mySlot = lobby?.slots.find(s => s.clientId === this.lanClient.clientId);
    const isReady = mySlot?.ready ?? false;
    this.drawButtonRow(ctx, [
      { label: 'Leave', action: () => {
        this.lanClient.sendLeave();
        this.lanClient.disconnect();
        this._lanLobby = null;
        this.setState('lan_type');
      }},
      { label: isReady ? 'Unready' : 'Ready', emphasis: !isReady, action: () => {
        this.lanClient.sendReadyToggle();
      }},
    ], cx, h - 56);
  }

  // -------------------------------------------------------------------
  // LAN: shared slot table
  // -------------------------------------------------------------------

  private drawSlotsTable(
    ctx: CanvasRenderingContext2D,
    cx: number,
    h: number,
    lobby: LobbyState | null,
    isHost: boolean,
  ): void {
    const tableTop = 130;
    const rowH = 36;
    const tableW = 840;
    const tableLeft = cx - tableW / 2;

    // Header
    ctx.font = gameFont(11);
    ctx.textAlign = 'left';
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
    ctx.fillText('#', tableLeft + 8, tableTop - 10);
    ctx.fillText('Status', tableLeft + 40, tableTop - 10);
    ctx.fillText('Name', tableLeft + 160, tableTop - 10);
    ctx.fillText('Type / Difficulty', tableLeft + 360, tableTop - 10);
    ctx.fillText('Race', tableLeft + 500, tableTop - 10);
    ctx.fillText('Team', tableLeft + 592, tableTop - 10);
    ctx.fillText('Controls', tableLeft + 658, tableTop - 10);

    ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tableLeft, tableTop - 2);
    ctx.lineTo(tableLeft + tableW, tableTop - 2);
    ctx.stroke();

    const slots: LobbySlot[] = lobby?.slots ?? Array.from({ length: 8 }, (_, i) => ({
      slotIndex: i, type: 'open' as const, ready: false,
    } as LobbySlot));

    const AI_DIFFICULTIES: AIDifficulty[] = ['easy', 'normal', 'hard', 'nightmare'];

    for (let i = 0; i < 8; i++) {
      const slot = slots[i];
      const y = tableTop + i * rowH + rowH / 2;
      const rowRect: HitRect = { x: tableLeft, y: tableTop + i * rowH, w: tableW, h: rowH - 2 };

      // Row background
      if (i % 2 === 0) {
        ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.06);
        ctx.fillRect(rowRect.x, rowRect.y, rowRect.w, rowRect.h);
      }

      // Slot #
      ctx.font = gameFont(14);
      ctx.textAlign = 'left';
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.6);
      ctx.fillText(`${i + 1}`, tableLeft + 12, y);

      // Status indicator
      const statusColor = slot.type === 'human'
        ? (slot.ready || i === 0 ? Colors.radar_friendly_status : Colors.alert2)
        : slot.type === 'ai' ? Colors.radar_allied_status
        : slot.type === 'closed' ? Colors.radar_enemy_status
        : Colors.radar_gridlines;
      const statusText = slot.type === 'human'
        ? (slot.ready || i === 0 ? 'Ready' : 'Waiting')
        : slot.type === 'ai' ? 'AI'
        : slot.type === 'closed' ? 'Closed'
        : 'Open';
      ctx.fillStyle = colorToCSS(statusColor, 0.85);
      ctx.fillText(statusText, tableLeft + 44, y);

      // Name
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.9);
      ctx.fillText(slot.playerName ?? (slot.type === 'ai' ? `AI Bot` : '—'), tableLeft + 164, y);

      // Type / difficulty
      const typeText = slot.type === 'ai'
        ? `AI / ${slot.aiDifficulty ?? 'normal'}`
        : slot.type;
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.6);
      ctx.fillText(typeText, tableLeft + 364, y);

      const race = slot.race ?? 'terran';
      const teamId = Math.max(0, Math.min(7, slot.teamId ?? slot.slotIndex));
      ctx.fillStyle = colorToCSS(TextColors.normal, 0.72);
      ctx.fillText(factionLabel(race), tableLeft + 504, y);
      ctx.fillText(`T${teamId + 1}`, tableLeft + 596, y);

      const canChangeRace = (slot.type === 'human' && slot.clientId === this.lanClient.clientId) ||
        (isHost && slot.type === 'ai') ||
        (isHost && slot.type === 'human' && i === 0);
      if (canChangeRace) {
        const raceRect: HitRect = { x: tableLeft + 638, y: tableTop + i * rowH + 6, w: 46, h: rowH - 14 };
        const raceHovered = pointInRect(this.mouseXLatched, this.mouseYLatched, raceRect);
        ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, raceHovered ? 0.8 : 0.4);
        ctx.lineWidth = 1;
        ctx.strokeRect(raceRect.x + 0.5, raceRect.y + 0.5, raceRect.w - 1, raceRect.h - 1);
        ctx.font = gameFont(11);
        ctx.textAlign = 'center';
        ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, raceHovered ? 1.0 : 0.75);
        ctx.fillText('Race', raceRect.x + raceRect.w / 2, raceRect.y + raceRect.h / 2);
        if (this.handleClick(raceRect)) {
          const idx = RACE_SELECTIONS.indexOf(race);
          const nextRace = RACE_SELECTIONS[(idx + 1) % RACE_SELECTIONS.length];
          const typeForMsg = slot.type === 'human' ? 'human' : slot.type;
          this.lanClient.sendSlotConfig(i, typeForMsg, slot.aiDifficulty, nextRace, teamId);
        }
      }

      if (isHost) {
        const teamRect: HitRect = { x: tableLeft + 688, y: tableTop + i * rowH + 6, w: 32, h: rowH - 14 };
        const teamHovered = pointInRect(this.mouseXLatched, this.mouseYLatched, teamRect);
        ctx.strokeStyle = colorToCSS(Colors.radar_friendly_status, teamHovered ? 0.8 : 0.4);
        ctx.lineWidth = 1;
        ctx.strokeRect(teamRect.x + 0.5, teamRect.y + 0.5, teamRect.w - 1, teamRect.h - 1);
        ctx.font = gameFont(11);
        ctx.textAlign = 'center';
        ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, teamHovered ? 1.0 : 0.75);
        ctx.fillText('Team', teamRect.x + teamRect.w / 2, teamRect.y + teamRect.h / 2);
        if (this.handleClick(teamRect)) {
          this.lanClient.sendSlotConfig(i, slot.type, slot.aiDifficulty, race, (teamId + 1) % 8);
        }
      }

      // Host controls for non-slot-0 slots
      if (isHost && i > 0) {
        // Toggle type button
        const toggleRect: HitRect = { x: tableLeft + 724, y: tableTop + i * rowH + 6, w: 32, h: rowH - 14 };
        const toggleHovered = pointInRect(this.mouseXLatched, this.mouseYLatched, toggleRect);
        ctx.strokeStyle = colorToCSS(Colors.radar_gridlines, toggleHovered ? 0.8 : 0.45);
        ctx.lineWidth = 1;
        ctx.strokeRect(toggleRect.x + 0.5, toggleRect.y + 0.5, toggleRect.w - 1, toggleRect.h - 1);
        ctx.font = gameFont(12);
        ctx.textAlign = 'center';
        ctx.fillStyle = colorToCSS(TextColors.normal, toggleHovered ? 1.0 : 0.7);
        const nextType = slot.type === 'open' ? 'AI' : slot.type === 'ai' ? 'Cls' : 'Opn';
        ctx.fillText(nextType, toggleRect.x + toggleRect.w / 2, toggleRect.y + toggleRect.h / 2);
        if (this.handleClick(toggleRect)) {
          if (slot.type === 'open') {
            this.lanClient.sendSlotConfig(i, 'ai', 'normal', slot.race ?? 'terran', teamId === i ? 1 : teamId);
          } else if (slot.type === 'ai') {
            this.lanClient.sendSlotConfig(i, 'closed', undefined, slot.race ?? 'terran', teamId);
          } else {
            this.lanClient.sendSlotConfig(i, 'open', undefined, slot.race ?? 'terran', teamId);
          }
        }

        // AI difficulty cycle (only for AI slots)
        if (slot.type === 'ai') {
          const diffRect: HitRect = { x: tableLeft + 760, y: tableTop + i * rowH + 6, w: 32, h: rowH - 14 };
          const diffHovered = pointInRect(this.mouseXLatched, this.mouseYLatched, diffRect);
          ctx.strokeStyle = colorToCSS(Colors.radar_allied_status, diffHovered ? 0.8 : 0.4);
          ctx.lineWidth = 1;
          ctx.strokeRect(diffRect.x + 0.5, diffRect.y + 0.5, diffRect.w - 1, diffRect.h - 1);
          ctx.font = gameFont(11);
          ctx.textAlign = 'center';
          ctx.fillStyle = colorToCSS(Colors.radar_allied_status, diffHovered ? 1.0 : 0.75);
          ctx.fillText('Diff', diffRect.x + diffRect.w / 2, diffRect.y + diffRect.h / 2);
          if (this.handleClick(diffRect)) {
            const cur = slot.aiDifficulty ?? 'normal';
            const idx = AI_DIFFICULTIES.indexOf(cur);
            const next = AI_DIFFICULTIES[(idx + 1) % AI_DIFFICULTIES.length];
            this.lanClient.sendSlotConfig(i, 'ai', next, slot.race ?? 'terran', teamId);
          }
        }

        // Kick button for occupied human slots
        if (slot.type === 'human' && slot.clientId) {
          const kickRect: HitRect = { x: tableLeft + 760, y: tableTop + i * rowH + 6, w: 32, h: rowH - 14 };
          const kickHovered = pointInRect(this.mouseXLatched, this.mouseYLatched, kickRect);
          ctx.strokeStyle = colorToCSS(Colors.alert1, kickHovered ? 0.8 : 0.4);
          ctx.lineWidth = 1;
          ctx.strokeRect(kickRect.x + 0.5, kickRect.y + 0.5, kickRect.w - 1, kickRect.h - 1);
          ctx.font = gameFont(11);
          ctx.textAlign = 'center';
          ctx.fillStyle = colorToCSS(Colors.alert1, kickHovered ? 1.0 : 0.7);
          ctx.fillText('Kick', kickRect.x + kickRect.w / 2, kickRect.y + kickRect.h / 2);
          if (this.handleClick(kickRect)) {
            this.lanClient.sendKickPlayer(i);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Text input for Join screen fields
  // -------------------------------------------------------------------

  private handleTextInput(): void {
    // Only handle typed characters for LAN join fields
    if (this.state !== 'lan_join') return;

    const text = this.getActiveJoinText();
    const cursor = this.getActiveJoinCursor();

    if (Input.wasPressed('Backspace')) {
      if (cursor > 0) {
        this.setActiveJoinText(text.slice(0, cursor - 1) + text.slice(cursor));
        this.setActiveJoinCursor(cursor - 1);
      }
    }
    if (Input.wasPressed('Delete')) {
      if (cursor < text.length) {
        this.setActiveJoinText(text.slice(0, cursor) + text.slice(cursor + 1));
      }
    }
    if (Input.wasPressed('ArrowLeft')) {
      this.setActiveJoinCursor(Math.max(0, this.getActiveJoinCursor() - 1));
    }
    if (Input.wasPressed('ArrowRight')) {
      this.setActiveJoinCursor(Math.min(this.getActiveJoinText().length, this.getActiveJoinCursor() + 1));
    }
    if (Input.wasPressed('Home')) {
      this.setActiveJoinCursor(0);
    }
    if (Input.wasPressed('End')) {
      this.setActiveJoinCursor(this.getActiveJoinText().length);
    }
    if (Input.wasPressed('Tab')) {
      this._joinActiveField = this._joinActiveField === 'url' ? 'name' : 'url';
      this.clampJoinCursors();
    }
  }

  /**
   * Called by game.ts on every tick during the join screen to forward
   * typed characters into the active input field.
   */
  appendJoinChar(ch: string): void {
    if (this.state !== 'lan_join') return;
    if (ch.length !== 1) return;
    if (this._joinActiveField === 'url') {
      if (this._joinUrl.length >= 120) return;
      this._joinUrl = this._joinUrl.slice(0, this._joinUrlCursor) + ch + this._joinUrl.slice(this._joinUrlCursor);
      this._joinUrlCursor += ch.length;
    } else {
      if (this._joinName.length >= 24) return;
      this._joinName = this._joinName.slice(0, this._joinNameCursor) + ch + this._joinName.slice(this._joinNameCursor);
      this._joinNameCursor += ch.length;
    }
  }

  private drawJoinTextCaret(
    ctx: CanvasRenderingContext2D,
    text: string,
    cursor: number,
    active: boolean,
    x: number,
    y: number,
  ): void {
    if (!active || Math.floor(this.animTime * 2) % 2 !== 0) return;
    const caretX = x + ctx.measureText(text.slice(0, cursor)).width + 1;
    ctx.strokeStyle = colorToCSS(TextColors.normal, 0.95);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(caretX, y - 11);
    ctx.lineTo(caretX, y + 9);
    ctx.stroke();
  }

  private getActiveJoinText(): string {
    return this._joinActiveField === 'url' ? this._joinUrl : this._joinName;
  }

  private setActiveJoinText(text: string): void {
    if (this._joinActiveField === 'url') {
      this._joinUrl = text.slice(0, 120);
    } else {
      this._joinName = text.slice(0, 24);
    }
    this.clampJoinCursors();
  }

  private getActiveJoinCursor(): number {
    return this._joinActiveField === 'url' ? this._joinUrlCursor : this._joinNameCursor;
  }

  private setActiveJoinCursor(cursor: number): void {
    if (this._joinActiveField === 'url') {
      this._joinUrlCursor = Math.max(0, Math.min(this._joinUrl.length, cursor));
    } else {
      this._joinNameCursor = Math.max(0, Math.min(this._joinName.length, cursor));
    }
  }

  private clampJoinCursors(): void {
    this._joinUrlCursor = Math.max(0, Math.min(this._joinUrl.length, this._joinUrlCursor));
    this._joinNameCursor = Math.max(0, Math.min(this._joinName.length, this._joinNameCursor));
  }

  /**
   * Returns the pending LanClient so game.ts can wire up the match.
   */
  takePendingLanMatchStart(): MsgMatchStart | null {
    const m = this.pendingLanMatchStart;
    this.pendingLanMatchStart = null;
    return m;
  }

  /**
   * Returns the pending online (WebRTC) match-start data for game.ts to consume.
   * Also clears the stored reference so it is not double-consumed.
   */
  takePendingOnlineMatchStart(): { transport: MultiplayerTransport; matchStart: MsgMatchStart } | null {
    const m = this._pendingOnlineMatchStart;
    this._pendingOnlineMatchStart = null;
    return m;
  }

  /**
   * Returns the pending LanClient (host or client) for use during the match.
   */
  getLanClient(): LanClient {
    return this.lanClient;
  }

  // -------------------------------------------------------------------
  // Online Multiplayer stub screen (Phase 7)
  // -------------------------------------------------------------------

  /**
   * Renders the Online Multiplayer screen.
   *
   * If VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables are
   * present at build time, the screen shows a "Lobby" placeholder.
   * If the env vars are absent (the default for all current deployments),
   * a clear "not configured" message is shown with setup instructions.
   *
   * This screen is intentionally a stub — full Supabase lobby + WebRTC
   * transport are documented in docs/ONLINE_MULTIPLAYER.md and nextSteps.md.
   */
  private drawOnlineMultiplayer(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(28);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('ONLINE MULTIPLAYER', cx, 68);

    const supabaseConfigured = isSupabaseConfigured();

    if (supabaseConfigured) {
      ctx.font = gameFont(13);
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.9);
      ctx.fillText('Supabase connected — WebRTC online lobbies available.', cx, 118);
      if (this._onlineStatus) {
        ctx.font = gameFont(11);
        ctx.fillStyle = colorToCSS(Colors.alert2, 0.9);
        ctx.fillText(this._onlineStatus, cx, 145);
      }

      this.drawButtonRow(ctx, [
        {
          label: 'Host Online Game',
          action: () => this.beginOnlineHost(),
        },
        {
          label: 'Join by Room Code',
          action: () => this.setState('online_join'),
        },
      ], cx, h * 0.5 - 24);
    } else {
      // Not configured: show setup instructions.
      ctx.font = gameFont(13);
      ctx.fillStyle = colorToCSS(Colors.alert2, 0.9);
      ctx.fillText('Online multiplayer is not configured.', cx, 118);

      const setupLines = [
        'To enable online lobbies, set the following environment variables:',
        '',
        '  VITE_SUPABASE_URL=https://your-project.supabase.co',
        '  VITE_SUPABASE_ANON_KEY=your-anon-key',
        '',
        'Create a free Supabase project at supabase.com, then run:',
        '  supabase/schema.sql in the Supabase SQL editor',
        '  npm run dev',
        '',
        'See docs/ONLINE_MULTIPLAYER.md for SQL setup and full instructions.',
        'LAN Multiplayer continues to work without any configuration.',
      ];

      ctx.font = gameFont(11);
      const lineH = 18;
      const startY = 155;
      for (let i = 0; i < setupLines.length; i++) {
        const line = setupLines[i];
        ctx.fillStyle = line.startsWith('  ')
          ? colorToCSS(Colors.general_building, 0.85)
          : colorToCSS(Colors.radar_gridlines, 0.75);
        ctx.fillText(line, cx, startY + i * lineH);
      }
    }

    if (SteamMultiplayerController.isAvailable()) {
      ctx.font = gameFont(11);
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status, 0.85);
      ctx.fillText('Steam detected — Steam-native lobbies & networking available.', cx, h * 0.5 + 40);
      this.drawButtonRow(ctx, [
        { label: 'Host via Steam', action: () => { this.setState('steam_lobby'); void this.steam()?.host({ maxMembers: 8, visibility: 'friends' }); } },
        { label: 'Browse Steam', action: () => { this.setState('steam_lobby'); void this.steam()?.browse(); } },
      ], cx, h * 0.5 + 76);
    }

    this.drawButtonRow(ctx, [
      { label: 'LAN Multiplayer Instead', action: () => this.setState('lan_type') },
      { label: tr('common.back'), action: () => this.setState('play') },
    ], cx, h - 56);
  }

  // ---------------------------------------------------------------------------
  // Steam lobby screen (desktop build)
  // ---------------------------------------------------------------------------

  private drawSteamLobby(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);
    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = gameFont(26);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('STEAM MULTIPLAYER', cx, 62);

    const ctrl = this.steam();
    const st = ctrl?.state;

    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(
      st?.phase === 'error' ? Colors.alert1 : Colors.radar_friendly_status, 0.9,
    );
    ctx.fillText(st?.status || 'Steam is not available in this build.', cx, 100);

    if (st && st.members.length) {
      ctx.font = gameFont(13);
      let y = 150;
      for (const m of st.members) {
        ctx.fillStyle = colorToCSS(m.isLocal ? Colors.radar_friendly_status : Colors.radar_gridlines, 0.95);
        ctx.fillText(
          `Slot ${m.slot + 1}: ${m.name}${m.isOwner ? '  (host)' : ''}${m.isLocal ? '  — you' : ''}`,
          cx, y,
        );
        y += 22;
      }
    }

    if (st && st.phase === 'browsing' && st.browseResults.length) {
      let y = 150;
      for (const lb of st.browseResults.slice(0, 8)) {
        this.drawButtonRow(ctx, [{
          label: `${lb.hostName}  (${lb.memberCount}/${lb.maxMembers})`,
          action: () => { void ctrl?.join(lb.id); },
        }], cx, y);
        y += 44;
      }
    }

    const buttons: Array<{ label: string; action: () => void; emphasis?: boolean }> = [];
    if (st && (st.phase === 'lobby_host' || st.phase === 'lobby_client')) {
      buttons.push({ label: 'Invite Friend', action: () => { void ctrl?.invite(); } });
    }
    if (st && st.phase === 'lobby_host') {
      buttons.push({
        label: 'Start Match',
        emphasis: true,
        action: () => { this._steamSeed = Math.floor(Math.random() * 1e9); void ctrl?.startMatch(this._steamSeed); },
      });
    }
    if (st && st.phase === 'browsing') {
      buttons.push({ label: 'Refresh', action: () => { void ctrl?.browse(); } });
    }
    buttons.push({ label: tr('common.back'), action: () => { this.leaveSteam(); this.setState('online_multiplayer'); } });
    this.drawButtonRow(ctx, buttons, cx, h - 56);
  }

  // ---------------------------------------------------------------------------
  // Online host lobby
  // ---------------------------------------------------------------------------

  private beginOnlineHost(): void {
    const client = createSupabaseClient();
    if (!client) {
      this._onlineStatus = 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';
      return;
    }
    this._onlineStatus = 'Signing in anonymously...';
    this._onlineDebugLines = [];
    this.addOnlineDebug('Supabase configured; signing in anonymously');
    this._onlineSeed = Math.random() * 0xFFFFFF | 0;
    const manager = new OnlineLobbyManager(client);
    ensureAnonymousSession(client).then(() => manager.createLobby(this._onlinePlayerName || 'Host')).then((row) => {
      this._onlineLobbyRow = row;
      this._onlineRequestedSlots = [];
      this._onlineReadySlots = [];
      this._onlineLobbyHeartbeatTimer = 0;
      const signaling = new SignalingClient(client, row.id, row.host_slot);
      this._onlineSignaling = signaling;
      const transport = new WebRtcTransport(signaling, true, row.host_slot, row.host_slot);
      this._onlineTransport = transport;
      transport.onPeerConnectionStateChanged = (slot, state) => this.noteOnlinePeerState(slot, state);
      transport.onPeerChannelsReady = (slot) => {
        this._onlineReadySlots = transport.getReadyRemoteSlots();
        this._onlineStatus = `Slot ${slot + 1} WebRTC channels ready.`;
      };
      signaling.startPolling((signal) => {
        this.addOnlineDebug(`Signal ${signal.type} from slot ${signal.from_slot + 1}`);
        if (signal.type === 'want_connect') {
          const slot = Number((signal.payload as { slot?: unknown }).slot ?? signal.from_slot);
          if (Number.isInteger(slot) && slot >= 1 && slot <= 7 && !this._onlineRequestedSlots.includes(slot)) {
            this._onlineRequestedSlots.push(slot);
          }
        }
        transport.handleSignal(signal);
      });
      this.addOnlineDebug(`Lobby ${row.room_code} created; host slot ${row.host_slot + 1}`);
      this._onlineStatus = 'Waiting for players to connect.';
      this.setState('online_host_lobby');
    }).catch((e) => {
      console.error('[OnlineHost] createLobby failed:', e);
      this._onlineStatus = describeSupabaseError(e);
    });
  }

  private addOnlineDebug(line: string): void {
    const text = line.length > 90 ? `${line.slice(0, 87)}...` : line;
    this._onlineDebugLines.push(text);
    if (this._onlineDebugLines.length > 8) this._onlineDebugLines.shift();
    console.info(`[Online] ${line}`);
  }

  private noteOnlinePeerState(slot: number, state: WebRtcPeerConnectionState): void {
    const label = state.replace(/_/g, ' ');
    this.addOnlineDebug(`Slot ${slot + 1}: ${label}`);
  }

  private handleOnlineMatchStartMessage(msg: unknown, transport: WebRtcTransport, mySlot: number): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const record = msg as Record<string, unknown>;
    const raw = record['type'] === 'match_start' && record['matchStart']
      ? record['matchStart']
      : record['type'] === 'match_start'
        ? record
        : null;
    if (!raw || typeof raw !== 'object') return false;
    const matchStart = { ...(raw as MsgMatchStart), mySlot };
    this._pendingOnlineMatchStart = { transport, matchStart };
    this._onlineSignaling?.stopPolling();
    this.addOnlineDebug(`Match start received for slot ${mySlot + 1}`);
    this.pendingAction = 'start_online_client';
    return true;
  }

  private drawOnlineHostLobby(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(24);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('ONLINE LOBBY — HOST', cx, 64);

    const row = this._onlineLobbyRow;
    if (!row) {
      ctx.font = gameFont(14);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
      ctx.fillText('Creating lobby…', cx, 130);
    } else {
      const nowMs = Date.now();
      if (nowMs - this._onlineLobbyHeartbeatTimer > MainMenu.ONLINE_HEARTBEAT_INTERVAL) {
        this._onlineLobbyHeartbeatTimer = nowMs;
        const client = createSupabaseClient();
        if (client) {
          new OnlineLobbyManager(client).heartbeat(row.id).catch((e) => {
            this._onlineStatus = describeSupabaseError(e);
            console.warn('[OnlineHost] heartbeat failed:', e);
          });
        }
      }

      // Room code
      ctx.font = gameFont(14);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
      ctx.fillText('Share this room code with other players:', cx, 110);
      ctx.font = gameFont(32);
      ctx.fillStyle = colorToCSS(Colors.radar_friendly_status);
      ctx.fillText(row.room_code, cx, 148);

      // Player list
      ctx.font = gameFont(11);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.6);
      ctx.fillText('Waiting for players to join via "Join by Room Code"…', cx, 185);

      const requestedCount = this._onlineRequestedSlots.length;
      const readyCount = this._onlineReadySlots.length;
      const connectedCount = readyCount + 1; // +1 for host
      ctx.font = gameFont(13);
      ctx.fillStyle = colorToCSS(Colors.general_building, 0.9);
      ctx.fillText(`Requested: ${requestedCount} | WebRTC ready: ${connectedCount} / ${row.max_players}`, cx, 215);
      if (this._onlineStatus) {
        ctx.font = gameFont(10);
        ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
        ctx.fillText(this._onlineStatus.slice(0, 96), cx, 242);
      }
      if (this._onlineDebugLines.length > 0) {
        ctx.font = gameFont(9);
        ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.72);
        const startY = 266;
        for (let i = 0; i < Math.min(5, this._onlineDebugLines.length); i++) {
          ctx.fillText(this._onlineDebugLines[this._onlineDebugLines.length - 1 - i], cx, startY + i * 14);
        }
      }

      // Start Match button requires at least one fully opened WebRTC peer.
      if (readyCount >= 1) {
        this.drawButtonRow(ctx, [
          {
            label: `Start Match (${connectedCount} player${connectedCount !== 1 ? 's' : ''})`,
            action: () => this.startOnlineHostMatch(),
          },
        ], cx, h * 0.68);
      } else {
        ctx.font = gameFont(10);
        ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.65);
        ctx.fillText('Start Match enables after a remote client opens control, input, and snapshot channels.', cx, h * 0.68);
      }
    }

    this.drawButtonRow(ctx, [
      {
        label: 'Cancel',
        action: () => {
          if (this._onlineLobbyRow) {
            const client = createSupabaseClient();
            if (client) {
              new OnlineLobbyManager(client).deleteLobby(this._onlineLobbyRow!.id).catch((e) => {
                this._onlineStatus = describeSupabaseError(e);
                console.warn(e);
              });
            }
          }
          this._onlineLobbyRow = null;
          this._onlineSignaling?.cleanup().catch(console.warn);
          this._onlineSignaling = null;
          this._onlineTransport?.disconnect();
          this._onlineTransport = null;
          this._onlineRequestedSlots = [];
          this._onlineReadySlots = [];
          this.setState('online_multiplayer');
        },
      },
    ], cx, h - 56);
  }

  private startOnlineHostMatch(): void {
    const row = this._onlineLobbyRow;
    if (!row) return;
    const transport = this._onlineTransport;
    const readySlots = transport?.getReadyRemoteSlots() ?? [];
    if (!transport || readySlots.length < 1) {
      this._onlineStatus = 'Waiting for at least one remote WebRTC connection to finish.';
      this.addOnlineDebug('Start blocked: no remote slot has all DataChannels open');
      return;
    }

    // Build a synthetic MsgMatchStart matching the LAN format.
    const mkSlot = (slotIndex: number, playerName: string): LobbySlot => ({
      slotIndex,
      type: 'human' as const,
      playerName,
      race: 'terran' as const,
      ready: true,
    });

    const lobby: LobbyState = {
      slots: [
        mkSlot(0, this._onlinePlayerName || 'Host'),
        ...readySlots.map((slot) => mkSlot(slot, `Player ${slot + 1}`)),
      ],
      hostClientId: '',
      matchStarted: true,
    };

    const matchStart: MsgMatchStart = {
      type: 'match_start',
      mySlot: 0,
      hostSlot: 0,
      seed: this._onlineSeed,
      lobby,
    };

    const controlMessage = { type: 'match_start', matchStart };

    // Send match_start through WebRTC control first; signaling is only a fallback for clients still polling.
    transport.sendControl('all', controlMessage);
    this.addOnlineDebug(`Match start sent to ${readySlots.length} ready remote slot(s)`);

    if (this._onlineSignaling) {
      this._onlineSignaling.sendSignal(-1, 'match_start', controlMessage).catch(console.warn);
    }
    this._pendingOnlineMatchStart = { transport, matchStart };

    // Mark started in Supabase.
    const client = createSupabaseClient();
    if (client) {
      new OnlineLobbyManager(client).markStarted(row.id).catch((e) => {
        this._onlineStatus = describeSupabaseError(e);
        console.warn(e);
      });
    }

    this._onlineLobbyRow = null;
    this._onlineSignaling?.stopPolling();
    this.pendingAction = 'start_online_host';
  }

  // ---------------------------------------------------------------------------
  // Online join
  // ---------------------------------------------------------------------------

  private drawOnlineJoin(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawBackground(ctx, w, h);
    this.drawBuildBadge(ctx, w);

    const cx = w * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = gameFont(24);
    ctx.fillStyle = colorToCSS(TextColors.title);
    ctx.fillText('JOIN ONLINE GAME', cx, 64);

    // Room code input
    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
    ctx.fillText('Room Code (6 characters):', cx, 110);

    const codeFieldRect: HitRect = { x: cx - 120, y: 122, w: 240, h: 32 };
    const codeActive = this._onlineJoinActiveField === 'code';
    ctx.strokeStyle = colorToCSS(codeActive ? Colors.radar_friendly_status : Colors.radar_gridlines, 0.6);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(codeFieldRect.x, codeFieldRect.y, codeFieldRect.w, codeFieldRect.h);
    ctx.fillStyle = colorToCSS(Colors.menu_background, 0.85);
    ctx.fillRect(codeFieldRect.x, codeFieldRect.y, codeFieldRect.w, codeFieldRect.h);
    ctx.fillStyle = colorToCSS(codeActive ? Colors.radar_friendly_status : Colors.alert1);
    ctx.font = gameFont(18);
    ctx.fillText(this._onlineRoomCode || '______', cx, 138);
    if (this.handleClick(codeFieldRect)) this._onlineJoinActiveField = 'code';

    // Player name input
    ctx.font = gameFont(12);
    ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.7);
    ctx.fillText('Your Name:', cx, 174);

    const nameFieldRect: HitRect = { x: cx - 120, y: 184, w: 240, h: 28 };
    const nameActive = this._onlineJoinActiveField === 'name';
    ctx.strokeStyle = colorToCSS(nameActive ? Colors.radar_friendly_status : Colors.radar_gridlines, 0.6);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(nameFieldRect.x, nameFieldRect.y, nameFieldRect.w, nameFieldRect.h);
    ctx.fillStyle = colorToCSS(Colors.menu_background, 0.85);
    ctx.fillRect(nameFieldRect.x, nameFieldRect.y, nameFieldRect.w, nameFieldRect.h);
    ctx.fillStyle = colorToCSS(nameActive ? Colors.radar_friendly_status : Colors.alert1);
    ctx.font = gameFont(13);
    ctx.fillText(this._onlinePlayerName || 'Player', cx, 198);
    if (this.handleClick(nameFieldRect)) this._onlineJoinActiveField = 'name';

    // Status message
    if (this._onlineJoinStatus) {
      ctx.font = gameFont(11);
      ctx.fillStyle = colorToCSS(Colors.alert2, 0.85);
      ctx.fillText(this._onlineJoinStatus, cx, 234);
    }
    if (this._onlineDebugLines.length > 0) {
      ctx.font = gameFont(9);
      ctx.fillStyle = colorToCSS(Colors.radar_gridlines, 0.72);
      for (let i = 0; i < Math.min(5, this._onlineDebugLines.length); i++) {
        ctx.fillText(this._onlineDebugLines[this._onlineDebugLines.length - 1 - i], cx, 258 + i * 14);
      }
    }

    // Handle typing into active field
    if (Input.typedChars) {
      for (const ch of Input.typedChars) {
        if (this._onlineJoinActiveField === 'code') {
          if (ch === 'Backspace') {
            this._onlineRoomCode = this._onlineRoomCode.slice(0, -1);
          } else if (this._onlineRoomCode.length < 6) {
            this._onlineRoomCode = (this._onlineRoomCode + ch).toUpperCase().replace(/[^A-Z0-9]/g, '');
          }
        } else {
          if (ch === 'Backspace') {
            this._onlinePlayerName = this._onlinePlayerName.slice(0, -1);
          } else if (this._onlinePlayerName.length < 20) {
            this._onlinePlayerName += ch;
          }
        }
      }
    }

    this.drawButtonRow(ctx, [
      {
        label: 'Join Game',
        action: () => {
          if (this._onlineRoomCode.length < 2) {
            this._onlineJoinStatus = 'Enter a room code first.';
            return;
          }
          this._onlineJoinStatus = 'Looking up lobby…';
          this.joinOnlineGame(this._onlineRoomCode);
        },
      },
      { label: tr('common.back'), action: () => this.setState('online_multiplayer') },
    ], cx, h - 56);
  }

  private joinOnlineGame(code: string): void {
    const client = createSupabaseClient();
    if (!client) {
      this._onlineJoinStatus = 'Supabase not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';
      return;
    }
    const manager = new OnlineLobbyManager(client);
    this._onlineDebugLines = [];
    this.addOnlineDebug('Supabase configured; signing in anonymously');
    ensureAnonymousSession(client).then(() => manager.joinLobbyByCode(code)).then(({ lobby: row, assignedSlot }) => {
      if (!row) {
        this._onlineJoinStatus = `No lobby found with code "${code}".`;
        return;
      }
      if (row.match_started) {
        this._onlineJoinStatus = 'That match has already started.';
        return;
      }
      // Assign a slot index (simple: slots 1–7 in order).
      const mySlot = assignedSlot;
      const signalingClient = new SignalingClient(client, row.id, mySlot);
      this._onlineSignaling = signalingClient;
      const transport = new WebRtcTransport(signalingClient, false, mySlot, row.host_slot);
      this._onlineTransport = transport;
      this.addOnlineDebug(`Lobby ${row.room_code} joined; assigned slot ${mySlot + 1}`);
      transport.onPeerConnectionStateChanged = (slot, state) => {
        this.noteOnlinePeerState(slot, state);
        this._onlineJoinStatus = `Slot ${mySlot + 1}: ${state.replace(/_/g, ' ')}`;
      };
      transport.onPeerChannelsReady = () => {
        this._onlineJoinStatus = 'WebRTC channels ready. Waiting for host start.';
      };
      transport.onControlMessage = (msg) => {
        this.handleOnlineMatchStartMessage(msg, transport, mySlot);
      };
      this._onlineJoinStatus = 'Connecting…';

      this._onlineJoinStatus = `Joined as slot ${mySlot + 1}. Connecting WebRTC...`;
      transport.startSignaling([row.host_slot]);
    }).catch((e) => {
      this._onlineJoinStatus = describeSupabaseError(e).slice(0, 90);
    });
  }

  /**
   * Returns the pending action for game.ts to handle and resets it.
   */
  private handleClick(rect: HitRect): boolean {
    if (!this.mousePressedLatched) return false;
    if (!pointInRect(this.mouseXLatched, this.mouseYLatched, rect)) return false;
    Audio.playSound('menuselection');
    this.clickPulse = { rect, t: 0.18 };
    this.mousePressedLatched = false;
    Input.consumeMouseButton(0);
    return true;
  }

  private mouseX(): number {
    return Input.mousePos.x / Math.max(0.01, this.uiZoom);
  }

  private mouseY(): number {
    return Input.mousePos.y / Math.max(0.01, this.uiZoom);
  }
}

// ---------------------------------------------------------------------------
// Local label helpers
// ---------------------------------------------------------------------------

function visualQualityLabel(v: VisualQuality): string {
  return tr(`enum.quality.${v}`);
}

function researchUnlockLabel(v: ResearchUnlock): string {
  return tr(`enum.research.${v}`);
}

function victoryLabel(v: VictoryCondition): string {
  return tr(`enum.victory.${v}`);
}

function defeatLabel(v: DefeatCondition): string {
  return tr(`enum.defeat.${v}`);
}
