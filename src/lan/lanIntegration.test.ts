/**
 * End-to-end LAN integration test: a real WebSocket server (the same
 * factory Electron's main process uses in production) plus two real
 * LanClient instances talking to it over actual loopback sockets.
 *
 * This exercises the full host → join → ready → start_match flow without
 * any mocking, catching wire-format regressions the pure unit tests can't.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { startLanHostServer, type LanHostHandle } from '../../server/lanHost.js';
import { LanClient } from './lanClient.js';
import { LAN_PROTOCOL_VERSION } from './protocol.js';
import { generateHostToken } from './hostToken.js';

let host: LanHostHandle | null = null;
const clients: LanClient[] = [];
const extraServers: Array<{ close: () => void }> = [];

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  if (host) {
    await host.stop();
    host = null;
  }
  for (const s of extraServers) s.close();
  extraServers.length = 0;
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

describe('deterministic host identity (hostToken)', () => {
  it('never promotes a remote connection that arrives before the local host to host/slot 0', async () => {
    const hostToken = generateHostToken();
    host = await startLanHostServer({ port: 0, build: 'Build TEST', hostToken });
    const url = `ws://127.0.0.1:${host.port}`;

    // A remote client connects first, with no token at all — simulating a
    // machine on the LAN that reached the relay before the local renderer
    // finished its own handshake.
    const remote = new LanClient(url);
    clients.push(remote);
    let remoteWasHost: boolean | null = null;
    remote.onServerReady = () => { remoteWasHost = remote.isHost; };
    remote.connect();
    await waitFor(() => remoteWasHost !== null);
    expect(remoteWasHost).toBe(false);
    expect(remote.isHost).toBe(false);
    expect(remote.state).not.toBe('lobby'); // never welcomed as host

    // The real local host connects afterward, presenting the token, and
    // must still become host/slot 0 regardless of arrival order.
    const localHost = new LanClient(url);
    clients.push(localHost);
    localHost.connect(hostToken);
    await waitFor(() => localHost.state === 'lobby');
    expect(localHost.isHost).toBe(true);
    expect(localHost.mySlot).toBe(0);

    // Ordinary joiners still work normally once the real host is present.
    remote.onServerReady = () => remote.sendJoinRequest('Remote');
    // onServerReady already fired once (before host connected); manually
    // resend the join now that the host exists (mirrors what a client's
    // own retry-after-rejection UI would do).
    remote.sendJoinRequest('Remote');
    await waitFor(() => remote.state === 'lobby');
    expect(remote.isHost).toBe(false);
    expect(remote.mySlot).toBeGreaterThan(0);
  });

  it('rejects a connection presenting an invalid host token', async () => {
    const hostToken = generateHostToken();
    host = await startLanHostServer({ port: 0, build: 'Build TEST', hostToken });
    const url = `ws://127.0.0.1:${host.port}`;

    const impostor = new LanClient(url);
    clients.push(impostor);
    let rejection = '';
    impostor.onJoinRejected = (reason) => { rejection = reason; };
    impostor.connect('totally-wrong-token');
    await waitFor(() => rejection.length > 0);
    expect(rejection).toBe('Invalid host token.');
    expect(impostor.isHost).toBe(false);
  });

  it('rejects an ordinary join_request while the designated host has not connected yet', async () => {
    const hostToken = generateHostToken();
    host = await startLanHostServer({ port: 0, build: 'Build TEST', hostToken });
    const url = `ws://127.0.0.1:${host.port}`;

    const early = new LanClient(url);
    clients.push(early);
    let rejection = '';
    early.onJoinRejected = (reason) => { rejection = reason; };
    early.onServerReady = () => early.sendJoinRequest('TooEarly');
    early.connect();
    await waitFor(() => rejection.length > 0);
    expect(rejection).toBe('Waiting for the host to finish connecting. Try again in a moment.');
  });

  it('accepts the valid local host as slot 0 and lets regular joiners in afterward', async () => {
    const hostToken = generateHostToken();
    host = await startLanHostServer({ port: 0, build: 'Build TEST', hostToken });
    const url = `ws://127.0.0.1:${host.port}`;

    const localHost = new LanClient(url);
    clients.push(localHost);
    localHost.connect(hostToken);
    await waitFor(() => localHost.state === 'lobby');
    expect(localHost.isHost).toBe(true);
    expect(localHost.mySlot).toBe(0);

    const joiner = new LanClient(url);
    clients.push(joiner);
    joiner.onServerReady = () => joiner.sendJoinRequest('Player Two');
    joiner.connect();
    await waitFor(() => joiner.state === 'lobby');
    expect(joiner.isHost).toBe(false);
    expect(joiner.mySlot).toBe(1);
  });
});

describe('host shutdown releases the relay, not just the lobby', () => {
  it('stops listening, releases the port, and lets a fresh host rebind it immediately', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const port = host.port;
    const url = `ws://127.0.0.1:${port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    const joiner = new LanClient(url);
    clients.push(joiner);
    joiner.onServerReady = () => joiner.sendJoinRequest('Joiner');
    joiner.connect();
    await waitFor(() => joiner.state === 'lobby');

    joiner.sendReadyToggle();
    await waitFor(() => joiner.lobby?.slots.find(s => s.slotIndex === 1)?.ready === true);

    hostClient.sendStartMatch();
    await waitFor(() => hostClient.state === 'in_match' || joiner.lobby?.matchStarted === true);

    let joinerEndReason = '';
    joiner.onMatchEnd = (reason) => { joinerEndReason = reason; };

    await host.stop();
    host = null;

    await waitFor(() => joinerEndReason.length > 0);
    expect(joinerEndReason).toBe('Host closed the lobby.');

    // The port must actually be released — rebind it immediately on a
    // brand new host instance (simulating "click Host LAN Lobby again").
    const rehost = await startLanHostServer({ port, build: 'Build TEST' });
    host = rehost;
    expect(rehost.port).toBe(port);
    expect(rehost.getLobbySnapshot().slots.every(s => s.type === 'open')).toBe(true);

    const freshClient = new LanClient(url);
    clients.push(freshClient);
    freshClient.connect();
    await waitFor(() => freshClient.state === 'lobby');
    expect(freshClient.isHost).toBe(true);
    expect(freshClient.mySlot).toBe(0);
  });

  it('fires onHostDisconnected exactly once when the host connection drops unexpectedly', async () => {
    let disconnectedCount = 0;
    host = await startLanHostServer({
      port: 0,
      build: 'Build TEST',
      onHostDisconnected: () => { disconnectedCount++; },
    });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    hostClient.disconnect(); // simulates the renderer/socket dropping unexpectedly
    await waitFor(() => disconnectedCount > 0);
    // Give any duplicate-firing bug a moment to manifest before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectedCount).toBe(1);
  });

  it('does not error or double-fire onHostDisconnected when stop() races an unexpected disconnect', async () => {
    let disconnectedCount = 0;
    host = await startLanHostServer({
      port: 0,
      build: 'Build TEST',
      onHostDisconnected: () => { disconnectedCount++; },
    });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    // Disconnect the client and call stop() at roughly the same time —
    // stop() must remain safe (no throw) and the disconnect hook must not
    // fire spuriously after an explicit stop.
    hostClient.disconnect();
    await host.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectedCount).toBeLessThanOrEqual(1);

    // stop() itself must be idempotent.
    await expect(host.stop()).resolves.toBeUndefined();
    host = null;
  });
});

describe('disconnect-path idempotency', () => {
  it('a voluntary leave followed by the socket close event does not double-release the slot or double-broadcast', async () => {
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
    await waitFor(() => hostClient.lobby?.slots.some(s => s.slotIndex === 1 && s.type === 'human'));

    let updateCount = 0;
    hostClient.onLobbyUpdate = () => { updateCount++; };

    joiner.sendLeave(); // triggers handleClientDisconnect(...) server-side, then closes the socket
    await waitFor(() => hostClient.lobby?.slots.find(s => s.slotIndex === 1)?.type === 'open');

    // Give the resulting socket 'close' event (a second, now-redundant
    // disconnect trigger for the same already-removed client) time to
    // land, then confirm the slot wasn't released twice / re-broadcast
    // spuriously and nothing threw.
    const countAfterLeave = updateCount;
    await new Promise((r) => setTimeout(r, 150));
    expect(updateCount).toBe(countAfterLeave);
    expect(hostClient.lobby?.slots.find(s => s.slotIndex === 1)?.type).toBe('open');
  });

  it('kicking a player then their socket closing does not double-broadcast or throw', async () => {
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
    await waitFor(() => hostClient.lobby?.slots.some(s => s.slotIndex === 1 && s.type === 'human'));

    let kicked = false;
    joiner.onKicked = () => { kicked = true; };
    let updateCount = 0;
    hostClient.onLobbyUpdate = () => { updateCount++; };

    hostClient.sendKickPlayer(1);
    await waitFor(() => kicked);
    await waitFor(() => hostClient.lobby?.slots.find(s => s.slotIndex === 1)?.type === 'open');

    const countAfterKick = updateCount;
    await new Promise((r) => setTimeout(r, 150));
    expect(updateCount).toBe(countAfterKick);
  });
});

describe('LanClient bounded connection timeouts', () => {
  it('times out if the socket never completes opening', async () => {
    // A raw TCP server that accepts the connection but never performs the
    // WebSocket upgrade handshake — the client's socket sits in
    // "connecting" forever without this bound.
    const tcp = net.createServer((socket) => {
      // Deliberately do nothing with the incoming data.
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    extraServers.push({ close: () => tcp.close() });
    const addr = tcp.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new LanClient(`ws://127.0.0.1:${port}`, { connectTimeoutMs: 150 });
    clients.push(client);
    let errorMessage = '';
    client.onError = (msg) => { errorMessage = msg; };
    client.connect();

    await waitFor(() => errorMessage.length > 0, 2000);
    expect(errorMessage).toContain('timed out');
    expect(client.state).toBe('error');
  });

  it('times out if the server accepts the socket but never answers join_request', async () => {
    // A minimal fake relay: greets with server_connected, then goes silent
    // forever — never sends welcome or join_rejected.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    extraServers.push({ close: () => wss.close() });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'server_connected', clientId: 'fake', protocolVersion: LAN_PROTOCOL_VERSION, build: 'x' }));
      // No further messages, ever.
    });
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new LanClient(`ws://127.0.0.1:${port}`, { joinTimeoutMs: 150 });
    clients.push(client);
    let errorMessage = '';
    client.onError = (msg) => { errorMessage = msg; };
    client.onServerReady = () => client.sendJoinRequest('Stuck');
    client.connect();

    await waitFor(() => errorMessage.length > 0, 2000);
    expect(errorMessage).toBe('The host did not complete the join request.');
    expect(client.state).toBe('error');
  });

  it('does not fire a stale join-timeout error after the socket closes mid-join', async () => {
    // Regression test: server_connected -> join_request -> the socket
    // closes before any welcome/join_rejected arrives. The client must
    // report a clean disconnect and must NOT later fire a
    // "did not complete the join request" error from the now-orphaned
    // join timer.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    extraServers.push({ close: () => wss.close() });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'server_connected', clientId: 'fake', protocolVersion: LAN_PROTOCOL_VERSION, build: 'x' }));
      ws.on('message', () => {
        // Close the socket instead of ever answering the join_request.
        ws.close();
      });
    });
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // Join timeout is deliberately longer than how long we'll actually wait,
    // so if it fires at all, it can only be the stale timer this test guards against.
    const client = new LanClient(`ws://127.0.0.1:${port}`, { joinTimeoutMs: 300 });
    clients.push(client);
    let errorMessage = '';
    let disconnectedReason = '';
    client.onError = (msg) => { errorMessage = msg; };
    client.onDisconnected = (reason) => { disconnectedReason = reason; };
    client.onServerReady = () => client.sendJoinRequest('Stuck');
    client.connect();

    await waitFor(() => disconnectedReason.length > 0);
    expect(client.state).toBe('disconnected');

    // Wait well past the join timeout window — the stale timer must not fire.
    await new Promise((r) => setTimeout(r, 500));
    expect(errorMessage).toBe('');
    expect(client.state).toBe('disconnected');
  });

  it('a normal join cancels the join-response timeout (no spurious late error)', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    const joiner = new LanClient(url, { joinTimeoutMs: 150 });
    clients.push(joiner);
    let errorMessage = '';
    joiner.onError = (msg) => { errorMessage = msg; };
    joiner.onServerReady = () => joiner.sendJoinRequest('Fast Joiner');
    joiner.connect();
    await waitFor(() => joiner.state === 'lobby');

    // Wait past the (short) join timeout window to prove it was cancelled.
    await new Promise((r) => setTimeout(r, 300));
    expect(errorMessage).toBe('');
    expect(joiner.state).toBe('lobby');
  });

  it('a join rejection cancels the join-response timeout (no follow-up timeout error)', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    const joiner = new LanClient(url, { joinTimeoutMs: 150 });
    clients.push(joiner);
    let errorMessage = '';
    let rejection = '';
    joiner.onError = (msg) => { errorMessage = msg; };
    joiner.onJoinRejected = (reason) => { rejection = reason; };
    joiner.onServerReady = () => joiner.sendJoinRequest('Bob', LAN_PROTOCOL_VERSION + 1);
    joiner.connect();
    await waitFor(() => rejection.length > 0);

    await new Promise((r) => setTimeout(r, 300));
    expect(errorMessage).toBe('');
  });
});

describe('LanClient preserves connection-error state across the socket close that follows', () => {
  it('keeps state=error and the useful lastError after onerror is followed by onclose', async () => {
    // Reproduce a genuine post-open transport failure: the server violates
    // the WebSocket framing protocol, which fires a real 'error' event on
    // the client socket, immediately followed by 'close' (as commonly
    // happens in browsers/Electron too) — without this fix, 'close' would
    // overwrite the useful error state with a generic 'disconnected'.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    extraServers.push({ close: () => wss.close() });
    wss.on('connection', (ws) => {
      // @ts-expect-error -- reaching into the ws internals purely to corrupt the wire protocol for this test
      ws._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    });
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new LanClient(`ws://127.0.0.1:${port}`);
    clients.push(client);
    let errorMessage = '';
    let disconnectedCalled = false;
    client.onError = (msg) => { errorMessage = msg; };
    client.onDisconnected = () => { disconnectedCalled = true; };
    client.connect();

    await waitFor(() => client.state === 'error');
    expect(errorMessage).not.toBe('');
    const errorAtOnError = errorMessage;

    // The 'close' event follows shortly after — state and lastError must
    // survive it, and onDisconnected should still fire (it's a distinct
    // callback, so this isn't a duplicate onError).
    await waitFor(() => disconnectedCalled);
    expect(client.state).toBe('error');
    expect(client.lastError).toBe(errorAtOnError);
    expect(client.lastError).not.toBe('');
  });

  it('still reports a plain disconnected state when the server just closes cleanly (no preceding error)', async () => {
    host = await startLanHostServer({ port: 0, build: 'Build TEST' });
    const url = `ws://127.0.0.1:${host.port}`;

    const hostClient = new LanClient(url);
    clients.push(hostClient);
    hostClient.connect();
    await waitFor(() => hostClient.state === 'lobby');

    let disconnectedReason = '';
    hostClient.onDisconnected = (reason) => { disconnectedReason = reason; };

    await host.stop();
    host = null;

    await waitFor(() => disconnectedReason.length > 0);
    // No error preceded this close, so onclose must still produce the
    // normal 'disconnected' state — the error-preservation fix must not
    // leak into ordinary clean disconnects.
    expect(hostClient.state).toBe('disconnected');
  });
});
