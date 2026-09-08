/**
 * Tests for the Electron main-process LAN owner (electron/lan.cjs).
 *
 * electron/lan.cjs has no dependency on the `electron` module itself — it's
 * plain Node (dynamic import + the same server/lanHost.ts /
 * server/lanDiscoveryCore.ts used elsewhere) — so its lifecycle can be
 * tested directly, without a real Electron process or window.
 *
 * Two kinds of coverage here:
 *   - Real lifecycle tests against the actual compiled dist-server/
 *     modules (requires `npm run build:server` to have run — see the
 *     `pretest` npm script), covering host start/stop/restart and token
 *     issuance end-to-end over real loopback sockets.
 *   - Fake-module tests via `createLanOwner(fakeLoader)`, covering the
 *     event-driven discovery-advertisement wiring without depending on
 *     real UDP broadcast (which may not even reach a usable interface in
 *     a sandboxed/CI network namespace).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import lanCjs from './lan.cjs';
import { LanClient } from '../src/lan/lanClient.js';

const { createLanOwner } = lanCjs as unknown as {
  createLanOwner: (loader?: () => Promise<unknown[]>) => LanOwner;
};

interface LanOwner {
  startHost(opts?: { hostName?: string; port?: number }): Promise<{ ok: boolean; port?: number; lobbyId?: string; wsUrl?: string; hostToken?: string; error?: string }>;
  stopHost(): Promise<void>;
  isHosting(): boolean;
  startDiscoveryListening(): Promise<{ ok: boolean; error?: string }>;
  stopDiscoveryListening(): void;
  getDiscoveredGames(): unknown[];
  setDiscoveredGamesListener(cb: ((lobbies: unknown[]) => void) | null): void;
  disposeAll(): void;
}

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = check();
      if (value) { resolve(value); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('electron/lan.cjs — real host lifecycle', () => {
  const owner: LanOwner = createLanOwner();
  const clients: LanClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
    await owner.stopHost();
  });

  it('starts hosting, issues a host token, and a client presenting it becomes slot 0', async () => {
    const result = await owner.startHost({ hostName: 'Test Owner', port: 0 });
    expect(result.ok).toBe(true);
    expect(result.hostToken).toBeTruthy();
    expect(owner.isHosting()).toBe(true);

    const client = new LanClient(`ws://127.0.0.1:${result.port}`);
    clients.push(client);
    client.connect(result.hostToken);
    await waitFor(() => client.state === 'lobby');
    expect(client.isHost).toBe(true);
    expect(client.mySlot).toBe(0);
  });

  it('rejects a join attempt from a remote-looking client that arrives before the local host connects', async () => {
    const result = await owner.startHost({ hostName: 'Test Owner', port: 0 });
    expect(result.ok).toBe(true);

    // A second client connects with no token at all (as any real remote
    // machine on the LAN would) before the local renderer has presented
    // its hostToken.
    const early = new LanClient(`ws://127.0.0.1:${result.port}`);
    clients.push(early);
    let rejection = '';
    early.onJoinRejected = (reason) => { rejection = reason; };
    early.onServerReady = () => early.sendJoinRequest('TooEarly');
    early.connect();
    await waitFor(() => rejection.length > 0);
    expect(rejection).toBe('Waiting for the host to finish connecting. Try again in a moment.');
  });

  it('stopHost is idempotent and actually releases the port for an immediate restart', async () => {
    const first = await owner.startHost({ port: 0 });
    const port = first.port!;
    await owner.stopHost();
    expect(owner.isHosting()).toBe(false);
    // Calling stopHost again while already stopped must not throw.
    await expect(owner.stopHost()).resolves.toBeUndefined();

    const second = await owner.startHost({ port });
    expect(second.ok).toBe(true);
    expect(second.port).toBe(port);
    // A fresh hostToken every time — never reused across sessions.
    expect(second.hostToken).not.toBe(first.hostToken);
  });

  it('startHost always produces a fresh lobby, even if called again while already hosting', async () => {
    const first = await owner.startHost({ port: 0 });
    const client = new LanClient(`ws://127.0.0.1:${first.port}`);
    clients.push(client);
    client.connect(first.hostToken);
    await waitFor(() => client.state === 'lobby');

    const second = await owner.startHost({ port: 0 });
    expect(second.ok).toBe(true);
    // The previous host connection must have been cut loose by the
    // implicit stopHost() at the top of startHost().
    await waitFor(() => client.state === 'disconnected' || client.state === 'error');
  });
});

describe('electron/lan.cjs — event-driven discovery advertisement (fake modules)', () => {
  function makeFakeModules() {
    const advertiseCalls: unknown[] = [];
    let hostConnected = false;
    let lobbySnapshot = {
      // Slot 0 is only actually "human" once the fake host connection is
      // simulated (setHostConnected(true)) — mirrors the real relay, where
      // slot 0 is assigned only on the authenticated welcome.
      slots: Array.from({ length: 8 }, (_, i) => ({ slotIndex: i, type: 'open' })),
      matchStarted: false,
    };
    let capturedOptions: Record<string, unknown> = {};

    const fakeHandle = {
      port: 8787,
      lobbyId: 'lobby_fake',
      getLobbySnapshot: () => lobbySnapshot,
      isHostConnected: () => hostConnected,
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const fakeHostMod = {
      startLanHostServer: vi.fn(async (opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return fakeHandle;
      }),
    };

    const fakeDiscovery = {
      startListening: vi.fn().mockResolvedValue(undefined),
      stopListening: vi.fn(),
      advertise: vi.fn((info: unknown) => { advertiseCalls.push(info); }),
      stopAdvertising: vi.fn(),
      getDiscovered: vi.fn(() => []),
      dispose: vi.fn(),
    };
    const fakeDiscoveryMod = {
      createLanDiscovery: vi.fn(() => fakeDiscovery),
    };

    const fakeVersionMod = { buildLabel: () => 'Build FAKE' };
    const fakeHostTokenMod = { generateHostToken: () => 'fake-token' };

    const loader = async () => [fakeHostMod, fakeDiscoveryMod, fakeVersionMod, fakeHostTokenMod];

    /** Simulate the authenticated local host connection completing (or being lost). */
    function setHostConnected(value: boolean): void {
      hostConnected = value;
      if (value) {
        lobbySnapshot = {
          slots: [
            { slotIndex: 0, type: 'human' },
            ...Array.from({ length: 7 }, (_, i) => ({ slotIndex: i + 1, type: 'open' })),
          ],
          matchStarted: false,
        };
      }
    }

    return {
      loader,
      advertiseCalls,
      fakeHandle,
      fakeDiscovery,
      setLobby: (next: typeof lobbySnapshot) => { lobbySnapshot = next; },
      setHostConnected,
      getCapturedOptions: () => capturedOptions as {
        onHostConnected?: () => void;
        onLobbyChanged?: () => void;
        onMatchStarted?: () => void;
        onHostDisconnected?: () => void;
      },
    };
  }

  it('does not advertise a joinable lobby before the local host connects (startHost() alone)', async () => {
    const fx = makeFakeModules();
    const owner = createLanOwner(fx.loader);

    await owner.startHost({ hostName: 'Fake Host', port: 8787 });

    // The relay is up (startLanHostServer resolved) but nobody has
    // authenticated as host yet — slot 0 is still open. Nothing should
    // have been broadcast.
    expect(fx.advertiseCalls).toHaveLength(0);
    expect(fx.fakeHandle.isHostConnected()).toBe(false);

    await owner.stopHost();
  });

  it('the authenticated host connection triggers the first advertisement, with correct slot counts', async () => {
    const fx = makeFakeModules();
    const owner = createLanOwner(fx.loader);
    await owner.startHost({ hostName: 'Fake Host', port: 8787 });
    expect(fx.advertiseCalls).toHaveLength(0);

    // Simulate the local renderer's hostToken handshake completing —
    // server/lanHost.ts calls onHostConnected exactly here in production.
    fx.setHostConnected(true);
    fx.getCapturedOptions().onHostConnected?.();

    expect(fx.advertiseCalls).toHaveLength(1);
    expect(fx.advertiseCalls[0]).toMatchObject({
      openSlots: 7,
      occupiedHumanSlots: 1,
      aiSlots: 0,
      matchStarted: false,
    });

    await owner.stopHost();
  });

  it('later lobby changes still advertise correctly after the initial host-connected advertisement', async () => {
    const fx = makeFakeModules();
    const owner = createLanOwner(fx.loader);

    await owner.startHost({ hostName: 'Fake Host', port: 8787 });
    fx.setHostConnected(true);
    const opts = fx.getCapturedOptions();
    opts.onHostConnected?.();
    expect(fx.advertiseCalls).toHaveLength(1);

    // Simulate a second player joining: onLobbyChanged fires with a fresh snapshot.
    fx.setLobby({
      slots: [
        { slotIndex: 0, type: 'human' },
        { slotIndex: 1, type: 'human' },
        ...Array.from({ length: 6 }, (_, i) => ({ slotIndex: i + 2, type: 'open' })),
      ],
      matchStarted: false,
    });
    opts.onLobbyChanged?.();

    expect(fx.advertiseCalls).toHaveLength(2);
    expect(fx.advertiseCalls[1]).toMatchObject({ openSlots: 6, occupiedHumanSlots: 2 });

    // Simulate an AI slot being added.
    fx.setLobby({
      slots: [
        { slotIndex: 0, type: 'human' },
        { slotIndex: 1, type: 'human' },
        { slotIndex: 2, type: 'ai' },
        ...Array.from({ length: 5 }, (_, i) => ({ slotIndex: i + 3, type: 'open' })),
      ],
      matchStarted: false,
    });
    opts.onLobbyChanged?.();
    expect(fx.advertiseCalls).toHaveLength(3);
    expect(fx.advertiseCalls[2]).toMatchObject({ openSlots: 5, occupiedHumanSlots: 2, aiSlots: 1 });

    // Simulate the match starting — discovery must reflect "in progress"
    // immediately so the LAN browser stops offering it as joinable.
    fx.setLobby({ ...fx.fakeHandle.getLobbySnapshot(), matchStarted: true });
    opts.onMatchStarted?.();
    expect(fx.advertiseCalls).toHaveLength(4);
    expect(fx.advertiseCalls[3]).toMatchObject({ matchStarted: true });

    await owner.stopHost();
  });

  it('routes an unexpected host disconnect through the same stopHost() teardown', async () => {
    const fx = makeFakeModules();
    const owner = createLanOwner(fx.loader);

    await owner.startHost({ port: 8787 });
    expect(owner.isHosting()).toBe(true);

    const opts = fx.getCapturedOptions();
    opts.onHostDisconnected?.();

    // stopHost() is async; wait for it to actually finish.
    await waitFor(() => fx.fakeHandle.stop.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(owner.isHosting()).toBe(false);
    expect(fx.fakeDiscovery.stopAdvertising).toHaveBeenCalled();
  });

  it('never includes the host token in the discovery advertisement', async () => {
    const fx = makeFakeModules();
    const owner = createLanOwner(fx.loader);
    await owner.startHost({ port: 8787 });
    fx.setHostConnected(true);
    fx.getCapturedOptions().onHostConnected?.();
    expect(fx.advertiseCalls.length).toBeGreaterThan(0);
    for (const call of fx.advertiseCalls) {
      expect(JSON.stringify(call)).not.toContain('fake-token');
    }
    await owner.stopHost();
  });
});

describe('electron/lan.cjs — discovery listener ref-counting', () => {
  it('keeps listening while any caller holds a ref, and stops once all release it', async () => {
    const owner: LanOwner = createLanOwner();
    const r1 = await owner.startDiscoveryListening();
    expect(r1.ok).toBe(true);
    const r2 = await owner.startDiscoveryListening();
    expect(r2.ok).toBe(true);

    owner.stopDiscoveryListening();
    // One ref still outstanding — getDiscoveredGames should not throw.
    expect(() => owner.getDiscoveredGames()).not.toThrow();

    owner.stopDiscoveryListening();
    owner.disposeAll();
  });
});
