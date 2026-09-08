/**
 * End-to-end LAN integration test: a real WebSocket server (the same
 * factory Electron's main process uses in production) plus two real
 * LanClient instances talking to it over actual loopback sockets.
 *
 * This exercises the full host → join → ready → start_match flow without
 * any mocking, catching wire-format regressions the pure unit tests can't.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startLanHostServer, type LanHostHandle } from '../../server/lanHost.js';
import { LanClient } from './lanClient.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';

let host: LanHostHandle | null = null;
const clients: LanClient[] = [];

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  if (host) {
    await host.stop();
    host = null;
  }
});

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

describe('LAN host/client integration', () => {
  it('hosts, joins, readies up, and starts a match on both sides', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');
    expect(hostClient.isHost).toBe(true);
    expect(hostClient.mySlot).toBe(0);

    const joiner = new LanClient(url);
    clients.push(joiner);
    let joinedLobbyUpdate = false;
    joiner.onLobbyUpdate = () => { joinedLobbyUpdate = true; };
    joiner.onServerReady = () => joiner.sendJoinRequest('Joiner');
    joiner.connect();
    await waitFor(() => joiner.state === 'lobby');
    expect(joiner.isHost).toBe(false);
    expect(joiner.mySlot).toBe(1);
    expect(joinedLobbyUpdate).toBe(true);

    // Host sees the second player join via a lobby_update.
    await waitFor(() => hostClient.lobby?.slots.some(s => s.slotIndex === 1 && s.type === 'human'));

    joiner.sendReadyToggle();
    await waitFor(() => joiner.lobby?.slots.find(s => s.slotIndex === 1)?.ready === true);

    let hostMatchStarted = false;
    let joinerMatchStarted = false;
    hostClient.onMatchStart = () => { hostMatchStarted = true; };
    joiner.onMatchStart = () => { joinerMatchStarted = true; };

    hostClient.sendStartMatch();

    await waitFor(() => hostMatchStarted);
    await waitFor(() => joinerMatchStarted);
    expect(hostClient.state).toBe('in_match');
    expect(joiner.state).toBe('in_match');
  });

  it('rejects a join with a mismatched protocol version', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    const joiner = new LanClient(url);
    clients.push(joiner);
    let rejection = '';
    joiner.onJoinRejected = (reason) => { rejection = reason; };
    joiner.onServerReady = () => joiner.sendJoinRequest('Bob', LAN_PROTOCOL_VERSION + 1, 'Bad Build');
    joiner.connect();
    await waitFor(() => rejection.length > 0);
    expect(rejection).toContain('different Sign99RTS network version');
  });

  it('rejects a join once the lobby is full', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    // Fill the remaining 7 slots.
    const fillers: LanClient[] = [];
    for (let i = 0; i < 7; i++) {
      const c = new LanClient(url);
      clients.push(c);
      fillers.push(c);
      c.onServerReady = () => c.sendJoinRequest(`Filler${i}`);
      c.connect();
    }
    await Promise.all(fillers.map(c => waitFor(() => c.state === 'lobby')));

    const overflow = new LanClient(url);
    clients.push(overflow);
    let rejection = '';
    overflow.onJoinRejected = (reason) => { rejection = reason; };
    overflow.onServerReady = () => overflow.sendJoinRequest('Overflow');
    overflow.connect();
    await waitFor(() => rejection.length > 0);
    expect(rejection).toBe('Lobby is full.');
  });

  it('notifies remaining clients cleanly when the host disappears', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    const joiner = new LanClient(url);
    clients.push(joiner);
    joiner.onServerReady = () => joiner.sendJoinRequest('Joiner');
    joiner.connect();
    await waitFor(() => joiner.state === 'lobby');

    let matchEndReason = '';
    joiner.onMatchEnd = (reason) => { matchEndReason = reason; };

    await host.stop();
    host = null;

    await waitFor(() => matchEndReason.length > 0);
    expect(matchEndReason).toBe('Host closed the lobby.');
  });
});
