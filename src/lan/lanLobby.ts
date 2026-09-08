/**
 * Pure LAN lobby state machine: slot bookkeeping and join-request
 * evaluation, extracted from the WebSocket relay so the decision logic
 * (protocol mismatch / lobby full / match already started) can be unit
 * tested without opening real sockets.
 */

import { LAN_PROTOCOL_VERSION, type LobbySlot, type LobbyState } from './protocol.js';

export const MAX_LAN_SLOTS = 8;

export function initLobbySlots(maxSlots: number = MAX_LAN_SLOTS): LobbySlot[] {
  const slots: LobbySlot[] = [];
  for (let i = 0; i < maxSlots; i++) {
    slots.push({ slotIndex: i, type: 'open', teamId: i, ready: false, race: 'terran' });
  }
  return slots;
}

export function findOpenSlot(slots: LobbySlot[]): number | null {
  for (const slot of slots) {
    if (slot.type === 'open' && !slot.clientId) return slot.slotIndex;
  }
  return null;
}

export function assignSlot(slots: LobbySlot[], clientId: string, slotIndex: number, playerName: string): void {
  const slot = slots[slotIndex];
  const slotWasOpenOnDefaultTeam = slot.type === 'open' && (slot.teamId ?? slotIndex) === slotIndex;
  slot.type = 'human';
  slot.teamId = slotWasOpenOnDefaultTeam ? 0 : slot.teamId ?? slotIndex;
  slot.clientId = clientId;
  slot.playerName = playerName;
  slot.ready = false;
  slot.race ??= 'terran';
}

export function releaseSlot(slots: LobbySlot[], clientId: string): void {
  for (const slot of slots) {
    if (slot.clientId === clientId) {
      slot.type = 'open';
      slot.teamId ??= slot.slotIndex;
      slot.clientId = undefined;
      slot.playerName = undefined;
      slot.ready = false;
      return;
    }
  }
}

export function slotIndexForClient(slots: LobbySlot[], clientId: string): number | null {
  return slots.find(s => s.clientId === clientId)?.slotIndex ?? null;
}

export function snapshotLobby(slots: LobbySlot[], hostClientId: string | null, matchStarted: boolean): LobbyState {
  return {
    slots: slots.map(s => ({ ...s })),
    hostClientId: hostClientId ?? '',
    matchStarted,
  };
}

// ---------------------------------------------------------------------------
// Join-request evaluation
// ---------------------------------------------------------------------------

export interface JoinRequestInput {
  matchStarted: boolean;
  slots: LobbySlot[];
  clientProtocolVersion?: number;
  clientBuild?: string;
  hostBuild: string;
}

export type JoinDecision =
  | { accept: true; slotIndex: number }
  | { accept: false; reason: string };

/**
 * Decide whether a join_request should be accepted, and if so which slot it
 * gets. Order matters: protocol mismatch is checked first so a stale client
 * gets a clear "different version" message instead of a confusing
 * "lobby full" one, even if both happen to be true.
 */
export function evaluateJoinRequest(input: JoinRequestInput): JoinDecision {
  if (input.clientProtocolVersion !== undefined && input.clientProtocolVersion !== LAN_PROTOCOL_VERSION) {
    return {
      accept: false,
      reason: 'This LAN game is running a different Sign99RTS network version.',
    };
  }
  if (input.matchStarted) {
    return { accept: false, reason: 'Match already in progress.' };
  }
  const slotIndex = findOpenSlot(input.slots);
  if (slotIndex === null) {
    return { accept: false, reason: 'Lobby is full.' };
  }
  return { accept: true, slotIndex };
}
