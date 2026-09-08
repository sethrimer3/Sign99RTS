/**
 * LAN multiplayer protocol message types for Sign99RTS.
 *
 * All messages are JSON-serialised over a WebSocket connection.
 * The Node LAN server (server/lanServer.ts) acts as the relay hub.
 * The host browser client owns the authoritative GameState simulation;
 * remote clients send input and receive periodic state snapshots.
 *
 * Port: 8787 (configurable via LAN_PORT env variable).
 *
 * Connection flow:
 *   Host:      connect → server sends welcome(slot=0) → host lobby ready
 *   Non-host:  connect → server sends server_connected(clientId) →
 *              client sends join_request → server sends welcome(slotN) or join_rejected
 */

// ---------------------------------------------------------------------------
// Lobby slot model
// ---------------------------------------------------------------------------

export type SlotType = 'open' | 'human' | 'ai' | 'closed';
export type AIDifficulty = 'easy' | 'normal' | 'hard' | 'nightmare';
export type FactionType = 'terran' | 'synonymous';
export type RaceSelection = FactionType | 'random';

export interface LobbySlot {
  slotIndex: number;       // 0–7
  type: SlotType;
  teamId?: number;
  playerName?: string;     // set when a human occupies it
  clientId?: string;       // ws client id that owns this slot
  ready: boolean;          // for human slots
  aiDifficulty?: AIDifficulty;
  race?: RaceSelection;
}

/** Full lobby state snapshot broadcast to all clients */
export interface LobbyState {
  slots: LobbySlot[];
  hostClientId: string;
  matchStarted: boolean;
}

// ---------------------------------------------------------------------------
// C → S messages (client → server)
// ---------------------------------------------------------------------------

export interface MsgJoinRequest {
  type: 'join_request';
  playerName: string;
  /**
   * Client's LAN protocol version. Required — a join_request missing this
   * field (e.g. from a client older than this field's introduction) is
   * rejected exactly like a mismatched version, never silently accepted.
   */
  protocolVersion: number;
  /** Human-readable build label (e.g. "Build 055"), surfaced in mismatch errors. */
  build?: string;
}

export interface MsgReadyToggle {
  type: 'ready_toggle';
}

export interface MsgLeave {
  type: 'leave';
}

/** Host-only: reconfigure a slot */
export interface MsgSlotConfig {
  type: 'slot_config';
  slotIndex: number;
  slotType: SlotType;
  aiDifficulty?: AIDifficulty;
  race?: RaceSelection;
  teamId?: number;
}

/** Host-only: kick a human from a slot */
export interface MsgKickPlayer {
  type: 'kick_player';
  slotIndex: number;
}

/** Host-only: start the match */
export interface MsgStartMatch {
  type: 'start_match';
}

/** Remote client input snapshot (sent every tick) */
export interface MsgInputSnapshot {
  type: 'input_snapshot';
  seq: number;
  dx: number;  // -1 | 0 | 1
  dy: number;  // -1 | 0 | 1
  aimX: number;
  aimY: number;
  firePrimary: boolean;
  fireSpecial: boolean;
  boost: boolean;
}

/** Client ping to server (heartbeat) */
export interface MsgPing {
  type: 'ping';
  t: number; // client timestamp (ms)
}

/** Host → server: authoritative game state snapshot to relay to all clients */
export interface MsgGameSnapshot {
  type: 'game_snapshot';
  seq: number;
  gameTime: number;
  ships: SerializedShip[];
  projectiles: SerializedProjectile[];
  fighters: SerializedFighter[];
  buildings: SerializedBuilding[];
  factionsByTeam?: Array<{ team: number; faction: FactionType }>;
  territoryCircles?: SerializedTerritoryCircle[];
  /** Resources indexed by slot (sparse — only active slots included). */
  resourcesPerSlot: number[];
  hostSlot: number;
  /**
   * Per-slot last processed input sequence number (host-side).
   * Indexed by slot; undefined slots were not seen this tick.
   * Clients use this to prune their unacknowledged input ring buffer
   * and replay only genuinely unprocessed inputs after prediction correction.
   */
  lastProcessedInputSeqBySlot?: number[];
}

export interface SerializedShip {
  slotIndex: number;
  team: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  health: number;
  maxHealth: number;
  battery: number;
  shield: number;
  alive: boolean;
}

export interface SerializedProjectile {
  id: number;
  /** EntityType enum value */
  entityType: number;
  team: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
}

export interface SerializedFighter {
  id: number;
  /** EntityType enum value (Fighter or Bomber) */
  entityType: number;
  team: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  alive: boolean;
  advancedTier?: boolean;
}

export interface SerializedTerritoryCircle {
  id: string;
  team: number;
  x: number;
  y: number;
  radius: number;
  targetRadius: number;
  parentCircleId?: string;
  sourceBuildingId?: string;
  createdAt: number;
  growthStartTime: number;
  growthDuration: number;
}

export interface SerializedBuilding {
  id: number;
  /** EntityType enum value */
  entityType: number;
  team: number;
  x: number; y: number;
  health: number;
  maxHealth: number;
  buildProgress: number;
  powered: boolean;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// S → C messages (server → client)
// ---------------------------------------------------------------------------

/**
 * Server sends this to non-host clients immediately on connect, before they
 * have sent a join_request. Contains only the client id.
 * Host clients receive `welcome` directly (slot 0 is auto-assigned).
 */
export interface MsgServerConnected {
  type: 'server_connected';
  clientId: string;
  /** The host's LAN protocol version, so clients can self-check before joining. */
  protocolVersion: number;
  build: string;
}

/** Server assigns this client an id, role, and slot after successful join */
export interface MsgWelcome {
  type: 'welcome';
  clientId: string;
  isHost: boolean;
  slotIndex: number;
  lobby: LobbyState;
  protocolVersion: number;
  build: string;
}

/** Lobby state changed */
export interface MsgLobbyUpdate {
  type: 'lobby_update';
  lobby: LobbyState;
}

/** Join was rejected */
export interface MsgJoinRejected {
  type: 'join_rejected';
  reason: string;
}

/** You were kicked */
export interface MsgKicked {
  type: 'kicked';
}

/** Broadcast: match is starting */
export interface MsgMatchStart {
  type: 'match_start';
  lobby: LobbyState;
  seed: number;
  hostSlot: number;
  mySlot: number;
}

/** Relayed game snapshot from host */
export interface MsgRelayedSnapshot {
  type: 'game_snapshot';
  seq: number;
  gameTime: number;
  ships: SerializedShip[];
  projectiles: SerializedProjectile[];
  fighters: SerializedFighter[];
  buildings: SerializedBuilding[];
  factionsByTeam?: Array<{ team: number; faction: FactionType }>;
  territoryCircles?: SerializedTerritoryCircle[];
  resourcesPerSlot: number[];
  hostSlot: number;
  /** See MsgGameSnapshot.lastProcessedInputSeqBySlot */
  lastProcessedInputSeqBySlot?: number[];
}

/** Relayed input from a remote player (host receives this) */
export interface MsgRelayedInput {
  type: 'relayed_input';
  fromSlot: number;
  input: MsgInputSnapshot;
}

/** Match ended (host disconnected or game over) */
export interface MsgMatchEnd {
  type: 'match_end';
  reason: string;
}

/** Chat / system text message */
export interface MsgChat {
  type: 'chat';
  from: string;
  text: string;
}

/** Server pong response to client ping */
export interface MsgPong {
  type: 'pong';
  t: number; // echoes the client's timestamp
}

// ---------------------------------------------------------------------------
// Union type helpers
// ---------------------------------------------------------------------------

export type ClientMessage =
  | MsgJoinRequest
  | MsgReadyToggle
  | MsgLeave
  | MsgSlotConfig
  | MsgKickPlayer
  | MsgStartMatch
  | MsgInputSnapshot
  | MsgGameSnapshot
  | MsgPing;

export type ServerMessage =
  | MsgServerConnected
  | MsgWelcome
  | MsgLobbyUpdate
  | MsgJoinRejected
  | MsgKicked
  | MsgMatchStart
  | MsgRelayedSnapshot
  | MsgRelayedInput
  | MsgMatchEnd
  | MsgChat
  | MsgPong;


export const DEFAULT_LAN_PORT = 8787;

/**
 * Single network-protocol version shared by the WebSocket lobby handshake
 * (join_request / welcome / server_connected) and the UDP discovery
 * advertisement. Bump this whenever a wire-incompatible change is made to
 * either; mismatched clients/hosts are rejected with a human-readable error
 * instead of silently misbehaving.
 */
export const LAN_PROTOCOL_VERSION = 2;
/** @deprecated use LAN_PROTOCOL_VERSION — kept as an alias for older references. */
export const DISCOVERY_PROTOCOL_VERSION = LAN_PROTOCOL_VERSION;

export interface LanDiscoveryAdvertisement {
  type: 'sign99_lan_advertise';
  protocolVersion: number;
  game: 'Sign99RTS';
  lobbyId: string;
  hostName: string;
  wsUrl: string;
  httpUrl: string;
  lanPort: number;
  maxSlots: number;
  openSlots: number;
  occupiedHumanSlots: number;
  aiSlots: number;
  matchStarted: boolean;
  build: string;
  timestamp: number;
}

export interface LanDiscoveredLobby extends LanDiscoveryAdvertisement {
  sourceIp: string;
  lastSeenAt: number;
  expiresAt: number;
}
