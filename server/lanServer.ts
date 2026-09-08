/**
 * Sign99RTS standalone LAN dev helper.
 *
 * This is ONLY used for browser-based development (`npm run dev:lan`).
 * The production Electron desktop build does NOT use this file — the
 * Electron main process hosts the LAN relay and discovery directly
 * (see electron/main.cjs + electron/lan.cjs), so a shipped game never
 * needs Node, tsx, or this script.
 *
 * Run with:  npm run lan:server
 *            (or tsx server/lanServer.ts)
 *
 * A browser page cannot open raw UDP sockets or IPC to a native process,
 * so this helper exposes a tiny, read-only, loopback-only HTTP bridge for
 * the dev page to poll discovered LAN lobbies. It intentionally has no
 * control endpoints (no remote reset/start/stop) — those are meaningless
 * outside of hosting from this same process's own WebSocket relay below,
 * which starts immediately and stays up for the life of this script.
 *
 * Env vars:
 *   LAN_PORT            – WebSocket relay port (default 8787)
 *   LAN_DISCOVERY_PORT  – UDP discovery port (default 47888)
 *   LAN_DISCOVERY_HTTP_PORT – loopback-only HTTP bridge port (default 8788)
 */

import http from 'node:http';
import os from 'node:os';
import { startLanHostServer } from './lanHost.js';
import { createLanDiscovery } from './lanDiscoveryCore.js';
import { buildLabel } from '../src/version.js';

const PORT = parseInt(process.env.LAN_PORT ?? '8787', 10);
const HTTP_PORT = parseInt(process.env.LAN_DISCOVERY_HTTP_PORT ?? '8788', 10);

async function main(): Promise<void> {
  const discovery = createLanDiscovery();
  await discovery.startListening();

  const host = await startLanHostServer({ build: buildLabel() });
  discovery.advertise({
    lobbyId: host.lobbyId,
    hostName: os.hostname() || 'Sign99 Host',
    lanPort: host.port,
    maxSlots: 8,
    openSlots: 8,
    occupiedHumanSlots: 0,
    aiSlots: 0,
    matchStarted: false,
    build: buildLabel(),
  });

  // Refresh the advertised lobby counts whenever the lobby changes. Since
  // this dev helper always hosts (it never stops), re-advertise on a timer
  // reading the live snapshot rather than wiring a callback through.
  setInterval(() => {
    const lobby = host.getLobbySnapshot();
    const occupiedHumanSlots = lobby.slots.filter(s => s.type === 'human').length;
    const aiSlots = lobby.slots.filter(s => s.type === 'ai').length;
    const openSlots = lobby.slots.filter(s => s.type === 'open').length;
    discovery.advertise({
      lobbyId: host.lobbyId,
      hostName: os.hostname() || 'Sign99 Host',
      lanPort: host.port,
      maxSlots: 8,
      openSlots,
      occupiedHumanSlots,
      aiSlots,
      matchStarted: lobby.matchStarted,
      build: buildLabel(),
    });
  }, 2000);

  // Read-only, loopback-only bridge for the browser dev page.
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.url === '/lan/discovered') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ lobbies: discovery.getDiscovered(), timestamp: Date.now() }));
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });
  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[LAN] Dev discovery bridge at http://127.0.0.1:${HTTP_PORT}/lan/discovered (loopback only)`);
  });

  process.on('SIGINT', () => {
    console.log('\n[LAN] Shutting down.');
    httpServer.close();
    discovery.dispose();
    void host.stop().then(() => process.exit(0));
  });
}

void main().catch((err) => {
  console.error('[LAN] Failed to start dev LAN server:', err instanceof Error ? err.message : err);
  process.exit(1);
});
