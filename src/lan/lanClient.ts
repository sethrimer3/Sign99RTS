/**
 * Browser-side WebSocket client for Sign99RTS LAN multiplayer.
 *
 * Usage:
 *   const client = new LanClient('ws://192.168.1.10:8787');
 *   client.onLobbyUpdate = (lobby) => { ... };
 *   client.connect();
 *   // For non-hosts: wait for onConnected, then sendJoinRequest
 *   // For hosts: the server auto-assigns slot 0 and sends welcome directly
 */

import type {
  ServerMessage,
  ClientMessage,
  LobbyState,
  MsgWelcome,
  MsgMatchStart,
  MsgRelayedSnapshot,
  MsgRelayedInput,
  MsgMatchEnd,
  MsgJoinRejected,
  MsgInputSnapshot,
  MsgGameSnapshot,
  MsgSlotConfig,
  SlotType,
  AIDifficulty,
  RaceSelection,
} from './protocol.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';

export type LanClientState =
  | 'disconnected'
  | 'connecting'
  | 'lobby'
  | 'in_match'
  | 'error';

/** Heartbeat ping interval in ms. Matches the server-side CLIENT_TIMEOUT_MS / 4. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** If the socket hasn't opened (or the server hasn't greeted us) within this long, give up. */
const CONNECT_TIMEOUT_MS = 8_000;

export class LanClient {
  private ws: WebSocket | null = null;
  private _url: string;
  /** Heartbeat ping interval handle */
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  /** Time the last ping was sent (ms) */
  private lastPingSentAt: number = 0;
  private connectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every connect() call. Async callbacks (timeouts, and the
   * WebSocket's own event handlers) capture the token at creation time and
   * verify it still matches `this.generation` before touching instance
   * state — this prevents a stale connection attempt (e.g. from a rapid
   * double-click, or a socket that outlives a superseding connect() call)
   * from clobbering state that belongs to a newer attempt.
   */
  private generation: number = 0;

  // -------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------
  state: LanClientState = 'disconnected';
  clientId: string = '';
  isHost: boolean = false;
  mySlot: number = -1;
  lobby: LobbyState | null = null;
  lastError: string = '';
  /** Round-trip ping estimate in ms (0 = unknown). */
  pingMs: number = 0;
  /** Timestamp (ms) of the last received snapshot. */
  lastSnapshotAt: number = 0;
  /** Host's LAN protocol version, once known (from server_connected/welcome). */
  hostProtocolVersion: number = 0;
  /** Host's build label, once known. */
  hostBuild: string = '';

  // -------------------------------------------------------------------------
  // Callbacks (set by consumers)
  // -------------------------------------------------------------------------
  onConnected: (() => void) | null = null;
  /**
   * Fires once the server has assigned us a clientId and is ready to
   * receive `join_request` (non-host clients only — hosts get `welcome`
   * directly and never need to send join_request). Send join_request from
   * here, not from onConnected/socket-open — the server is not guaranteed
   * to have finished its own connection setup at the instant the socket
   * reports "open" on constrained/virtualized network stacks, whereas
   * server_connected is an explicit, in-order signal that it is.
   */
  onServerReady: (() => void) | null = null;
  onDisconnected: ((reason: string) => void) | null = null;
  onLobbyUpdate: ((lobby: LobbyState) => void) | null = null;
  onJoinRejected: ((reason: string) => void) | null = null;
  onKicked: (() => void) | null = null;
  onMatchStart: ((msg: MsgMatchStart) => void) | null = null;
  onGameSnapshot: ((msg: MsgRelayedSnapshot) => void) | null = null;
  onRelayedInput: ((msg: MsgRelayedInput) => void) | null = null;
  onMatchEnd: ((reason: string) => void) | null = null;
  /** Fires on a connect() that never completed (timeout / immediate error). */
  onError: ((message: string) => void) | null = null;

  constructor(url: string) {
    this._url = url;
  }

  /** The WebSocket URL this client connects (or last connected) to. */
  get url(): string {
    return this._url;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the connection. Safe to call multiple times: an in-flight or live
   * connection is torn down first, and a monotonic generation counter
   * ensures callbacks from the old attempt can never affect the new one.
   * Event handlers are attached synchronously before any I/O can complete,
   * so there is no window in which a message could arrive unhandled.
   */
  connect(): void {
    this.teardownSocket();
    const myGeneration = ++this.generation;

    this.state = 'connecting';
    this.lastError = '';
    this.pingMs = 0;
    this.lastSnapshotAt = 0;
    this.hostProtocolVersion = 0;
    this.hostBuild = '';

    let socket: WebSocket;
    try {
      socket = new WebSocket(this._url);
    } catch (e) {
      this.state = 'error';
      this.lastError = String(e);
      this.onError?.(this.lastError);
      return;
    }
    this.ws = socket;

    this.connectTimeoutHandle = setTimeout(() => {
      if (this.generation !== myGeneration) return;
      if (this.state === 'connecting') {
        this.lastError = 'Connection timed out. The host may be offline, or a firewall is blocking the connection.';
        this.state = 'error';
        this.onError?.(this.lastError);
        this.teardownSocket();
      }
    }, CONNECT_TIMEOUT_MS);

    // Handlers are installed here, before connect() returns and before any
    // event can fire — 'open'/'message'/'close'/'error' are always
    // dispatched asynchronously by the platform, never synchronously from
    // the `new WebSocket(...)` call above.
    socket.onopen = () => {
      if (this.generation !== myGeneration) return;
      this.state = 'connecting'; // wait for 'welcome' or 'server_connected'
      this.startHeartbeat();
      this.onConnected?.();
    };

    socket.onmessage = (ev) => {
      if (this.generation !== myGeneration) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    socket.onclose = (ev) => {
      if (this.generation !== myGeneration) return;
      const reason = ev.reason || 'Connection closed';
      this.state = 'disconnected';
      this.ws = null;
      this.clearConnectTimeout();
      this.stopHeartbeat();
      this.onDisconnected?.(reason);
    };

    socket.onerror = () => {
      if (this.generation !== myGeneration) return;
      this.lastError = 'WebSocket error — the host may be offline or unreachable.';
      this.state = 'error';
      this.onError?.(this.lastError);
    };
  }

  disconnect(): void {
    // Invalidate any in-flight callbacks from this attempt immediately.
    this.generation++;
    this.teardownSocket();
    this.state = 'disconnected';
  }

  private teardownSocket(): void {
    this.clearConnectTimeout();
    this.stopHeartbeat();
    if (this.ws) {
      // Detach handlers first so a close triggered by us doesn't fire a
      // stale onDisconnected for an attempt the caller already moved past.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutHandle !== null) {
      clearTimeout(this.connectTimeoutHandle);
      this.connectTimeoutHandle = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** True while a connect() attempt is in flight or already live — guards callers against duplicate rapid-click connects. */
  get busy(): boolean {
    return this.state === 'connecting' || this.state === 'lobby' || this.state === 'in_match';
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Send a ping every HEARTBEAT_INTERVAL_MS to keep the connection alive and measure RTT.
    this.pingInterval = setInterval(() => {
      if (!this.connected) return;
      this.lastPingSentAt = performance.now();
      this.send({ type: 'ping', t: this.lastPingSentAt });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Incoming message dispatch
  // -------------------------------------------------------------------------

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'server_connected': {
        // Non-host initial greeting: we now know our clientId and the
        // server is ready to receive join_request. This is the explicit,
        // in-order "ready" signal — send join_request from onServerReady,
        // not from onopen/onConnected, to avoid racing the server's own
        // per-connection setup.
        this.clientId = msg.clientId;
        this.hostProtocolVersion = msg.protocolVersion;
        this.hostBuild = msg.build;
        this.state = 'connecting'; // still waiting to join
        this.clearConnectTimeout();
        this.onServerReady?.();
        break;
      }
      case 'welcome': {
        const m = msg as MsgWelcome;
        this.clientId = m.clientId;
        this.isHost = m.isHost;
        this.mySlot = m.slotIndex;
        this.lobby = m.lobby;
        this.hostProtocolVersion = m.protocolVersion;
        this.hostBuild = m.build;
        this.state = 'lobby';
        this.clearConnectTimeout();
        this.onLobbyUpdate?.(m.lobby);
        break;
      }
      case 'lobby_update': {
        this.lobby = msg.lobby;
        this.onLobbyUpdate?.(msg.lobby);
        break;
      }
      case 'join_rejected': {
        this.lastError = msg.reason;
        this.state = 'error';
        this.onJoinRejected?.(msg.reason);
        break;
      }
      case 'kicked': {
        this.state = 'disconnected';
        this.onKicked?.();
        this.ws?.close();
        break;
      }
      case 'match_start': {
        const m = msg as MsgMatchStart;
        this.mySlot = m.mySlot;
        this.lobby = m.lobby;
        this.state = 'in_match';
        this.onMatchStart?.(m);
        break;
      }
      case 'game_snapshot': {
        this.lastSnapshotAt = performance.now();
        this.onGameSnapshot?.(msg as MsgRelayedSnapshot);
        break;
      }
      case 'relayed_input': {
        this.onRelayedInput?.(msg as MsgRelayedInput);
        break;
      }
      case 'match_end': {
        this.state = 'lobby';
        this.onMatchEnd?.(msg.reason);
        break;
      }
      case 'pong': {
        // Calculate round-trip time.
        if (this.lastPingSentAt > 0) {
          this.pingMs = Math.round(performance.now() - this.lastPingSentAt);
        }
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing helpers
  // -------------------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendJoinRequest(playerName: string, protocolVersion: number = LAN_PROTOCOL_VERSION, build?: string): void {
    this.send({ type: 'join_request', playerName, protocolVersion, build });
  }

  sendReadyToggle(): void {
    this.send({ type: 'ready_toggle' });
  }

  sendLeave(): void {
    this.send({ type: 'leave' });
  }

  sendSlotConfig(slotIndex: number, slotType: SlotType, aiDifficulty?: AIDifficulty, race?: RaceSelection, teamId?: number): void {
    this.send({ type: 'slot_config', slotIndex, slotType, aiDifficulty, race, teamId });
  }

  sendKickPlayer(slotIndex: number): void {
    this.send({ type: 'kick_player', slotIndex });
  }

  sendStartMatch(): void {
    this.send({ type: 'start_match' });
  }

  sendInputSnapshot(snap: Omit<MsgInputSnapshot, 'type'>): void {
    this.send({ type: 'input_snapshot', ...snap });
  }

  sendGameSnapshot(snap: Omit<MsgGameSnapshot, 'type'>): void {
    this.send({ type: 'game_snapshot', ...snap });
  }
}
