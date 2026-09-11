/**
 * Sign99RTS — Versioned Network Protocol Types (Phase 2)
 *
 * These types define the compact over-the-wire format for gameplay messages.
 * They are transport-agnostic: the same types are used by LAN (WebSocket),
 * future WebRTC DataChannels, and any other transport.
 *
 * HOST-AUTHORITATIVE DESIGN:
 *   - Only the host browser sends NetGameSnapshot messages.
 *   - Remote clients only send NetInputSnapshot messages.
 *   - The host never trusts client-provided game state.
 *   - All damage, projectile creation, resource changes, and win/loss
 *     decisions are made exclusively by the host simulation.
 *
 * Validation:
 *   - Always validate + clamp incoming messages before applying them.
 *   - `validateInputSnapshot` and `validateGameSnapshot` helpers are provided.
 *
 * JSON compatibility:
 *   - Messages are JSON-serialised for now to simplify debugging.
 *   - A future optimisation pass could switch to a binary format.
 *
 * Versioning:
 *   - `protocolVersion` must be checked on receipt.
 *   - Reject messages with a different version.
 *   - Increment NET_PROTOCOL_VERSION when making breaking changes.
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export type NetProtocolVersion = 1;
export const NET_PROTOCOL_VERSION: NetProtocolVersion = 1;

// ---------------------------------------------------------------------------
// Shared sub-types (gameplay-relevant state only; no cosmetics)
// ---------------------------------------------------------------------------

export interface NetShipState {
  slotIndex: number;
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  health: number;
  maxHealth: number;
  battery: number;
  shield: number;
  alive: boolean;
  structure?: import('../buildingStructureDamage.js').BuildingStructureSnapshot;
}

export interface NetProjectileState {
  id: number;
  /** EntityType enum value. */
  entityType: number;
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export interface NetFighterState {
  id: number;
  /** EntityType enum value (Fighter = 4, Bomber = 5). */
  entityType: number;
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  alive: boolean;
  structure?: import('../buildingStructureDamage.js').BuildingStructureSnapshot;
}

export interface NetBuildingState {
  id: number;
  /** EntityType enum value. */
  entityType: number;
  team: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  buildProgress: number;
  powered: boolean;
  alive: boolean;
  structure?: import('../buildingStructureDamage.js').BuildingStructureSnapshot;
}

export interface NetTerritoryCircleState {
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

export interface NetBuildCommand {
  buildingType: string;
  cellX: number;
  cellY: number;
}

// ---------------------------------------------------------------------------
// Client → Host: input snapshot
// ---------------------------------------------------------------------------

/**
 * Sent by remote clients to the host every tick.
 * The host applies these inputs to the remote player's ship.
 *
 * seq: monotonically increasing per-client counter used for reconciliation.
 * clientTimeMs: client-side timestamp for latency measurement.
 * simTick: optional host sim tick the client believes it is at (for debug).
 */
export interface NetInputSnapshot {
  protocolVersion: NetProtocolVersion;
  seq: number;
  clientTimeMs: number;
  simTick?: number;

  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  aimX: number;
  aimY: number;
  firePrimary: boolean;
  fireSpecial: boolean;
  boost: boolean;

  buildCommand?: NetBuildCommand;
  weaponSelect?: number;
}

// ---------------------------------------------------------------------------
// Host → Clients: authoritative game snapshot
// ---------------------------------------------------------------------------

/**
 * Sent by the host at NET_SNAPSHOT_HZ (default 20 Hz) to all remote clients.
 *
 * seq: monotonically increasing host snapshot counter.
 * serverTimeMs: host-side timestamp for latency/jitter measurement.
 * gameTime: authoritative in-game time in seconds.
 * hostSlot: slot index of the host player (always 0 in current implementation).
 * lastProcessedInputSeqBySlot: the last seq the host processed per client slot.
 *   Remote clients use this for client-side prediction reconciliation.
 */
export interface NetGameSnapshot {
  protocolVersion: NetProtocolVersion;
  seq: number;
  serverTimeMs: number;
  gameTime: number;
  hostSlot: number;

  ships: NetShipState[];
  projectiles: NetProjectileState[];
  fighters: NetFighterState[];
  buildings: NetBuildingState[];
  resourcesPerSlot: number[];
  factionsByTeam?: Array<{ team: number; faction: string }>;
  territoryCircles?: NetTerritoryCircleState[];

  /**
   * The last input sequence number the host processed for each slot.
   * Index = slot number; value = last seq processed (or -1 if no input yet).
   * Used by clients to know which of their unacknowledged inputs to reapply
   * after receiving a corrected authoritative position.
   */
  lastProcessedInputSeqBySlot?: number[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Clamp a number to [min, max], treating non-finite values as `fallback`. */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampDir(v: unknown): -1 | 0 | 1 {
  const n = clampNum(v, -1, 1, 0);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** Maximum reasonable timestamp in milliseconds (~317 years from epoch). */
const MAX_TIMESTAMP_MS = 1e13;

/**
 * Validates and sanitises an incoming input snapshot.
 * Returns null if the message is fundamentally malformed.
 */
export function validateInputSnapshot(raw: unknown): NetInputSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['protocolVersion'] !== NET_PROTOCOL_VERSION) return null;
  const seq = typeof r['seq'] === 'number' ? Math.max(0, Math.floor(r['seq'])) : 0;
  const clientTimeMs = clampNum(r['clientTimeMs'], 0, MAX_TIMESTAMP_MS, 0);
  return {
    protocolVersion: NET_PROTOCOL_VERSION,
    seq,
    clientTimeMs,
    simTick: typeof r['simTick'] === 'number' ? Math.max(0, Math.floor(r['simTick'])) : undefined,
    dx: clampDir(r['dx']),
    dy: clampDir(r['dy']),
    aimX: clampNum(r['aimX'], -1e6, 1e6, 0),
    aimY: clampNum(r['aimY'], -1e6, 1e6, 0),
    firePrimary: Boolean(r['firePrimary']),
    fireSpecial: Boolean(r['fireSpecial']),
    boost: Boolean(r['boost']),
    weaponSelect: typeof r['weaponSelect'] === 'number' ? Math.max(0, Math.floor(r['weaponSelect'])) : undefined,
  };
}

/**
 * Validates and sanitises an incoming authoritative game snapshot.
 * Returns null if the message is fundamentally malformed.
 * Only the host should be allowed to send these.
 */
export function validateGameSnapshot(raw: unknown): NetGameSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['protocolVersion'] !== NET_PROTOCOL_VERSION) return null;
  // Basic structural checks — additional field validation happens at apply time.
  if (!Array.isArray(r['ships'])) return null;
  if (!Array.isArray(r['buildings'])) return null;
  if (!Array.isArray(r['fighters'])) return null;
  if (!Array.isArray(r['projectiles'])) return null;
  return raw as NetGameSnapshot;
}
