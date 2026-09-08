import { describe, it, expect } from 'vitest';
import {
  initLobbySlots,
  findOpenSlot,
  assignSlot,
  releaseSlot,
  slotIndexForClient,
  evaluateJoinRequest,
  MAX_LAN_SLOTS,
} from './lanLobby.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';

describe('lobby slot bookkeeping', () => {
  it('initializes all slots as open', () => {
    const slots = initLobbySlots();
    expect(slots).toHaveLength(MAX_LAN_SLOTS);
    expect(slots.every(s => s.type === 'open')).toBe(true);
  });

  it('finds the first open slot', () => {
    const slots = initLobbySlots();
    assignSlot(slots, 'c1', 0, 'Host');
    expect(findOpenSlot(slots)).toBe(1);
  });

  it('returns null when no slots are open', () => {
    const slots = initLobbySlots(1);
    assignSlot(slots, 'c1', 0, 'Host');
    expect(findOpenSlot(slots)).toBeNull();
  });

  it('assigns and releases a slot', () => {
    const slots = initLobbySlots();
    assignSlot(slots, 'c1', 2, 'Bob');
    expect(slotIndexForClient(slots, 'c1')).toBe(2);
    expect(slots[2].type).toBe('human');
    releaseSlot(slots, 'c1');
    expect(slots[2].type).toBe('open');
    expect(slotIndexForClient(slots, 'c1')).toBeNull();
  });
});

describe('evaluateJoinRequest', () => {
  it('accepts a join into the first open slot', () => {
    const slots = initLobbySlots();
    assignSlot(slots, 'host', 0, 'Host');
    const decision = evaluateJoinRequest({ matchStarted: false, slots, hostBuild: 'Build 055' });
    expect(decision).toEqual({ accept: true, slotIndex: 1 });
  });

  it('rejects with a clear message on protocol mismatch', () => {
    const slots = initLobbySlots();
    const decision = evaluateJoinRequest({
      matchStarted: false, slots, hostBuild: 'Build 055',
      clientProtocolVersion: LAN_PROTOCOL_VERSION + 1,
    });
    expect(decision).toEqual({
      accept: false,
      reason: 'This LAN game is running a different Sign99RTS network version.',
    });
  });

  it('accepts a matching protocol version', () => {
    const slots = initLobbySlots();
    const decision = evaluateJoinRequest({
      matchStarted: false, slots, hostBuild: 'Build 055',
      clientProtocolVersion: LAN_PROTOCOL_VERSION,
    });
    expect(decision.accept).toBe(true);
  });

  it('rejects when the match has already started', () => {
    const slots = initLobbySlots();
    const decision = evaluateJoinRequest({ matchStarted: true, slots, hostBuild: 'Build 055' });
    expect(decision).toEqual({ accept: false, reason: 'Match already in progress.' });
  });

  it('rejects when the lobby is full', () => {
    const slots = initLobbySlots(2);
    assignSlot(slots, 'c1', 0, 'A');
    assignSlot(slots, 'c2', 1, 'B');
    const decision = evaluateJoinRequest({ matchStarted: false, slots, hostBuild: 'Build 055' });
    expect(decision).toEqual({ accept: false, reason: 'Lobby is full.' });
  });

  it('checks protocol version before lobby-full, so a stale client gets the clearer error', () => {
    const slots = initLobbySlots(1);
    assignSlot(slots, 'c1', 0, 'A');
    const decision = evaluateJoinRequest({
      matchStarted: false, slots, hostBuild: 'Build 055',
      clientProtocolVersion: LAN_PROTOCOL_VERSION + 1,
    });
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.reason).toContain('different Sign99RTS network version');
  });
});
