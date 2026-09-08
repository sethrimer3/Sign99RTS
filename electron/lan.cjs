/**
 * Electron main-process LAN networking owner.
 *
 * The desktop game hosts its own LAN relay and discovery service directly
 * inside the Electron main process — no external Node process, no `tsx`,
 * no `npm run lan:server`. The actual protocol logic lives in TypeScript
 * under server/ and src/lan/, compiled ahead of time by `npm run build`
 * (via `npm run build:server`) into plain ESM under dist-server/, which
 * this CommonJS module loads with a dynamic import().
 *
 * This module exposes three clearly separate concepts, per the desired
 * architecture:
 *   - local host server   (WebSocket relay this machine may be running)
 *   - LAN discovery        (UDP broadcast/listen, independent of hosting)
 *   - remote host connection (owned entirely by the renderer's LanClient —
 *     this module never connects out anywhere; it only serves data in)
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_SERVER = path.join(REPO_ROOT, 'dist-server');

let modulesPromise = null;
function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import(pathToFileURL(path.join(DIST_SERVER, 'server', 'lanHost.js')).href),
      import(pathToFileURL(path.join(DIST_SERVER, 'server', 'lanDiscoveryCore.js')).href),
      import(pathToFileURL(path.join(DIST_SERVER, 'src', 'version.js')).href),
    ]);
  }
  return modulesPromise;
}

/** @type {import('../server/lanHost.js').LanHostHandle | null} */
let activeHost = null;
/** @type {ReturnType<typeof import('../server/lanDiscoveryCore.js').createLanDiscovery> | null} */
let discovery = null;
let discoveryListenerRefCount = 0;
let onDiscoveredChanged = null;

/** Build a diagnostic-friendly error message distinguishing common failure modes. */
function describeStartError(err) {
  const message = err && err.message ? err.message : String(err);
  return message;
}

async function ensureDiscovery() {
  if (discovery) return discovery;
  const [, discoveryMod] = await loadModules();
  discovery = discoveryMod.createLanDiscovery({
    onDiscoveredChanged: (lobbies) => {
      onDiscoveredChanged?.(lobbies);
    },
  });
  return discovery;
}

/** Start (or reuse) UDP discovery *listening* — safe to call while just browsing the menu. */
async function startDiscoveryListening() {
  const d = await ensureDiscovery();
  discoveryListenerRefCount++;
  try {
    await d.startListening();
    return { ok: true };
  } catch (err) {
    discoveryListenerRefCount = Math.max(0, discoveryListenerRefCount - 1);
    return { ok: false, error: describeStartError(err) };
  }
}

function stopDiscoveryListening() {
  discoveryListenerRefCount = Math.max(0, discoveryListenerRefCount - 1);
  // Keep listening while a local host is still advertising (it also wants
  // to see other hosts / avoid stepping on them), and while any other
  // caller still holds a listening ref.
  if (discoveryListenerRefCount === 0 && !activeHost && discovery) {
    discovery.stopListening();
  }
}

function getDiscoveredGames() {
  return discovery ? discovery.getDiscovered() : [];
}

/**
 * Start hosting: opens the WebSocket relay on the given port (default
 * 8787) and begins advertising this lobby over UDP discovery. Always
 * produces a clean, fresh lobby — any previous host instance is fully
 * stopped first.
 */
async function startHost(opts = {}) {
  await stopHost();
  const [hostMod, , versionMod] = await loadModules();
  const build = versionMod.buildLabel();

  let handle;
  try {
    handle = await hostMod.startLanHostServer({
      port: opts.port,
      build,
      logger: console,
    });
  } catch (err) {
    return { ok: false, error: describeStartError(err) };
  }
  activeHost = handle;

  const d = await ensureDiscovery();
  try {
    await d.startListening();
  } catch (err) {
    // Hosting still works without discovery (manual IP join remains
    // available) — surface the failure but don't fail startHost entirely.
    console.warn('[LAN] Discovery failed to start while hosting:', describeStartError(err));
  }

  const advertiseFromSnapshot = () => {
    if (!activeHost) return;
    const lobby = activeHost.getLobbySnapshot();
    const occupiedHumanSlots = lobby.slots.filter((s) => s.type === 'human').length;
    const aiSlots = lobby.slots.filter((s) => s.type === 'ai').length;
    const openSlots = lobby.slots.filter((s) => s.type === 'open').length;
    d.advertise({
      lobbyId: handle.lobbyId,
      hostName: opts.hostName || 'Sign99 Host',
      lanPort: handle.port,
      maxSlots: 8,
      openSlots,
      occupiedHumanSlots,
      aiSlots,
      matchStarted: lobby.matchStarted,
      build,
    });
  };
  advertiseFromSnapshot();

  return { ok: true, port: handle.port, lobbyId: handle.lobbyId, wsUrl: `ws://127.0.0.1:${handle.port}` };
}

/** Cleanly stop hosting: closes all sockets and stops advertising. Idempotent. */
async function stopHost() {
  if (discovery) discovery.stopAdvertising();
  if (activeHost) {
    const h = activeHost;
    activeHost = null;
    await h.stop();
  }
  // If nothing else needs discovery listening, release it too.
  if (discovery && discoveryListenerRefCount === 0) {
    discovery.stopListening();
  }
}

function isHosting() {
  return activeHost !== null;
}

function setDiscoveredGamesListener(cb) {
  onDiscoveredChanged = cb;
}

function disposeAll() {
  onDiscoveredChanged = null;
  void stopHost();
  if (discovery) {
    discovery.dispose();
    discovery = null;
  }
  discoveryListenerRefCount = 0;
}

module.exports = {
  startHost,
  stopHost,
  isHosting,
  startDiscoveryListening,
  stopDiscoveryListening,
  getDiscoveredGames,
  setDiscoveredGamesListener,
  disposeAll,
};
