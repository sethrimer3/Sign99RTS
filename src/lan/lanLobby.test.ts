import { describe, it, expect } from 'vitest';
import {
  initLobbySlots,
  findOpenSlot,
  assignSlot,
  releaseSlot,
  slotIndexForClient,
  evaluateJoinRequest,
  MAX_LAN_SLOTS,
  type JoinRequestInput,
} from './lanLobby.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';

/** Base valid input — individual tests override just the field under test. */
function baseInput(overrides: Partial<JoinRequestInput> = {}): JoinRequestInput {
  return {
    matchStarted: false,
    slots: initLobbySlots(),
    clientProtocolVersion: LAN_PROTOCOL_VERSION,
    hostBuild: 'Build 055',
    hostConnected: true,
    ...overrides,
  };
}

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
    const decision = evaluateJoinRequest(baseInput({ slots }));
    expect(decision).toEqual({ accept: true, slotIndex: 1 });
  });

  describe('protocol version is mandatory', () => {
    it('accepts an exact protocol version match', () => {
      const decision = evaluateJoinRequest(baseInput({ clientProtocolVersion: LAN_PROTOCOL_VERSION }));
      expect(decision.accept).toBe(true);
    });

    it('rejects a higher (newer) client protocol version', () => {
      const decision = evaluateJoinRequest(baseInput({ clientProtocolVersion: LAN_PROTOCOL_VERSION + 1 }));
      expect(decision).toEqual({
        accept: false,
        reason: 'This LAN game is running a different Sign99RTS network version.',
      });
    });

    it('rejects a lower (older) client protocol version', () => {
      const decision = evaluateJoinRequest(baseInput({ clientProtocolVersion: LAN_PROTOCOL_VERSION - 1 }));
      expect(decision).toEqual({
        accept: false,
        reason: 'This LAN game is running a different Sign99RTS network version.',
      });
    });

    it('rejects a missing protocol version rather than silently accepting a legacy client', () => {
      // Simulates a malformed/legacy join_request where the field never
      // arrived over the wire, despite the TS type saying it's required.
      const input = baseInput();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (input as any).clientProtocolVersion = undefined;
      const decision = evaluateJoinRequest(input);
      expect(decision).toEqual({
        accept: false,
        reason: 'This LAN game is running a different Sign99RTS network version.',
      });
    });

    it('rejects a non-numeric protocol version', () => {
      const input = baseInput();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (input as any).clientProtocolVersion = 'two';
      const decision = evaluateJoinRequest(input);
      expect(decision.accept).toBe(false);
    });
  });

  describe('host-not-yet-connected gating', () => {
    it('rejects an ordinary join while the designated host has not connected yet', () => {
      const decision = evaluateJoinRequest(baseInput({ hostConnected: false }));
      expect(decision).toEqual({
        accept: false,
        reason: 'Waiting for the host to finish connecting. Try again in a moment.',
      });
    });

    it('accepts a join once the host has connected', () => {
      const decision = evaluateJoinRequest(baseInput({ hostConnected: true }));
      expect(decision.accept).toBe(true);
    });

    it('still prioritizes the protocol-mismatch message over the host-not-connected one', () => {
      const decision = evaluateJoinRequest(baseInput({
        hostConnected: false,
        clientProtocolVersion: LAN_PROTOCOL_VERSION + 1,
      }));
      expect(decision).toEqual({
        accept: false,
        reason: 'This LAN game is running a different Sign99RTS network version.',
      });
    });
  });

  it('rejects when the match has already started', () => {
    const decision = evaluateJoinRequest(baseInput({ matchStarted: true }));
    expect(decision).toEqual({ accept: false, reason: 'Match already in progress.' });
  });

  it('rejects when the lobby is full', () => {
    const slots = initLobbySlots(2);
    assignSlot(slots, 'c1', 0, 'A');
    assignSlot(slots, 'c2', 1, 'B');
    const decision = evaluateJoinRequest(baseInput({ slots }));
    expect(decision).toEqual({ accept: false, reason: 'Lobby is full.' });
  });

  it('checks protocol version before lobby-full, so a stale client gets the clearer error', () => {
    const slots = initLobbySlots(1);
    assignSlot(slots, 'c1', 0, 'A');
    const decision = evaluateJoinRequest(baseInput({ slots, clientProtocolVersion: LAN_PROTOCOL_VERSION + 1 }));
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.reason).toContain('different Sign99RTS network version');
  });
});
