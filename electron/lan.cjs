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
 *
 * `createLanOwner()` builds one independent instance of this state machine
 * from a given module loader. `module.exports` is the real singleton the
 * app uses, wired to the actual compiled dist-server/ modules. Tests can
 * call `createLanOwner(fakeLoader)` directly to exercise the same lifecycle
 * logic (host lifecycle, token handling, event-driven advertisement
 * updates, idempotent stop/restart) against fake host/discovery modules —
 * this module has no dependency on `electron` itself, so none of that
 * requires a real Electron process or window.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_SERVER = path.join(REPO_ROOT, 'dist-server');

function defaultLoadModules() {
  return Promise.all([
    import(pathToFileURL(path.join(DIST_SERVER, 'server', 'lanHost.js')).href),
    import(pathToFileURL(path.join(DIST_SERVER, 'server', 'lanDiscoveryCore.js')).href),
    import(pathToFileURL(path.join(DIST_SERVER, 'src', 'version.js')).href),
    import(pathToFileURL(path.join(DIST_SERVER, 'src', 'lan', 'hostToken.js')).href),
  ]);
}

/** Build a diagnostic-friendly error message distinguishing common failure modes. */
function describeStartError(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * @param {() => Promise<[any, any, any, any]>} [loadModulesFn] Resolves to
 *   [lanHostModule, lanDiscoveryCoreModule, versionModule, hostTokenModule].
 *   Defaults to loading the real compiled dist-server/ modules.
 */
function createLanOwner(loadModulesFn) {
  const loadModules = (() => {
    let cached = null;
    const loader = loadModulesFn || defaultLoadModules;
    return () => {
      if (!cached) cached = loader();
      return cached;
    };
  })();

  /** @type {import('../server/lanHost.js').LanHostHandle | null} */
  let activeHost = null;
  let activeHostName = '';
  let activeBuild = '';
  /** @type {ReturnType<typeof import('../server/lanDiscoveryCore.js').createLanDiscovery> | null} */
  let discovery = null;
  let discoveryListenerRefCount = 0;
  let onDiscoveredChanged = null;
  /** @type {Promise<void> | null} */
  let stopHostPromise = null;
  /**
   * Bumped every time startHost() begins a new attempt, and every time
   * stopHost() is invoked (an explicit stop cancels whatever is currently
   * starting, not just whatever already finished starting). startHost()
   * checks this after every await; if it no longer matches the generation
   * it claimed, the operation was superseded or cancelled mid-flight, so
   * it must not assign its (possibly just-created) handle to `activeHost`
   * and must immediately stop that handle instead of leaving it running.
   */
  let hostOperationGeneration = 0;

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
   * Re-derive the discovery advertisement from the *current* lobby snapshot
   * and push it to the discovery broadcaster. Called once the authenticated
   * local host connection is established (onHostConnected), and again every
   * time the lobby actually changes thereafter (onLobbyChanged/
   * onMatchStarted) — event-driven, not a polling loop — so "Find LAN
   * Games" always reflects live slot counts and match state.
   *
   * Deliberately refuses to advertise until `isHostConnected()` is true:
   * between the WebSocket relay opening and the local renderer completing
   * its host-token handshake, slot 0 is still open and the lobby isn't
   * real yet — nothing should be discoverable during that window.
   */
  function syncAdvertisement() {
    if (!activeHost || !discovery) return;
    if (!activeHost.isHostConnected()) return;
    const lobby = activeHost.getLobbySnapshot();
    const occupiedHumanSlots = lobby.slots.filter((s) => s.type === 'human').length;
    const aiSlots = lobby.slots.filter((s) => s.type === 'ai').length;
    const openSlots = lobby.slots.filter((s) => s.type === 'open').length;
    discovery.advertise({
      lobbyId: activeHost.lobbyId,
      hostName: activeHostName,
      lanPort: activeHost.port,
      maxSlots: 8,
      openSlots,
      occupiedHumanSlots,
      aiSlots,
      matchStarted: lobby.matchStarted,
      build: activeBuild,
    });
  }

  /**
   * Start hosting: opens the WebSocket relay on the given port (default
   * 8787) and begins advertising this lobby over UDP discovery. Always
   * produces a clean, fresh lobby — any previous host instance is fully
   * stopped first.
   *
   * Host identity is deterministic: a fresh, cryptographically random
   * token is generated here and returned *only* in this IPC response, to
   * the local renderer that asked to host. The renderer must present it
   * back on its own WebSocket connection (see server/lanHost.ts's
   * hostToken handling) — a remote machine that happens to connect to the
   * relay first has no way to guess it, so it can never be mistaken for
   * the host. The token is never included in discovery advertisements, and
   * never logged.
   */
  async function startHost(opts = {}) {
    await stopHost(); // cancels/tears down any previous attempt or active host
    const generation = ++hostOperationGeneration;

    /** True once a newer startHost() or an explicit stopHost() has superseded this attempt. */
    const isStale = () => generation !== hostOperationGeneration;

    /** Make sure a handle that must not become active never stays alive. */
    async function discardStaleHandle(handle) {
      if (activeHost === handle) {
        activeHost = null;
        activeHostName = '';
        activeBuild = '';
      }
      await handle.stop();
    }

    const [hostMod, , versionMod, hostTokenMod] = await loadModules();
    if (isStale()) return { ok: false, error: 'Hosting was cancelled.' };

    const build = versionMod.buildLabel();
    const hostToken = hostTokenMod.generateHostToken();

    let handle;
    try {
      handle = await hostMod.startLanHostServer({
        port: opts.port,
        build,
        hostToken,
        logger: console,
        onHostConnected: () => syncAdvertisement(),
        onLobbyChanged: () => syncAdvertisement(),
        onMatchStarted: () => syncAdvertisement(),
        onHostDisconnected: () => {
          console.log('[LAN] Local host connection was lost unexpectedly — stopping the relay.');
          // Route through the single authoritative teardown path, exactly
          // as an explicit stopHost() IPC call would.
          void stopHost();
        },
      });
    } catch (err) {
      return { ok: false, error: describeStartError(err) };
    }

    // The relay is up — but if this attempt was cancelled (or superseded
    // by a newer startHost()) while startLanHostServer() was pending, this
    // handle must never become `activeHost`: stop it immediately instead
    // of leaving a server running for a screen nobody is looking at.
    if (isStale()) {
      await handle.stop();
      return { ok: false, error: 'Hosting was cancelled.' };
    }

    activeHost = handle;
    activeHostName = opts.hostName || 'Sign99 Host';
    activeBuild = build;

    const d = await ensureDiscovery();
    try {
      await d.startListening();
    } catch (err) {
      // Hosting still works without discovery (manual IP join remains
      // available) — surface the failure but don't fail startHost entirely.
      console.warn('[LAN] Discovery failed to start while hosting:', describeStartError(err));
    }

    if (isStale()) {
      // Cancelled while discovery was starting. A concurrent stopHost()
      // may already have torn this handle down (if it ran after we
      // assigned `activeHost` above); discardStaleHandle() is idempotent
      // either way and guarantees no server is left running.
      await discardStaleHandle(handle);
      return { ok: false, error: 'Hosting was cancelled.' };
    }

    // Deliberately no syncAdvertisement() call here: the local renderer
    // hasn't connected with its hostToken yet at this point (it only does
    // so after receiving this very IPC response), so the lobby isn't real
    // yet. The first advertisement fires from onHostConnected above, once
    // the authenticated host is actually in slot 0.

    return {
      ok: true,
      port: handle.port,
      lobbyId: handle.lobbyId,
      wsUrl: `ws://127.0.0.1:${handle.port}`,
      hostToken,
    };
  }

  /**
   * Cleanly stop hosting: closes all sockets, stops advertising, and
   * releases the port. This is the single authoritative teardown path —
   * it's used by the explicit "Back / Disconnect" IPC call, by quitting an
   * active match to the menu, by an unexpected loss of the local host
   * connection (onHostDisconnected above), and by app quit (disposeAll).
   * Idempotent and safe to call when not hosting or while a stop is
   * already in flight.
   */
  function stopHost() {
    // Cancel whatever is currently starting, not just whatever already
    // finished starting — see hostOperationGeneration above.
    hostOperationGeneration++;
    if (stopHostPromise) return stopHostPromise;
    stopHostPromise = (async () => {
      if (discovery) discovery.stopAdvertising();
      if (activeHost) {
        const h = activeHost;
        activeHost = null;
        activeHostName = '';
        activeBuild = '';
        await h.stop();
      }
      // If nothing else needs discovery listening, release it too.
      if (discovery && discoveryListenerRefCount === 0) {
        discovery.stopListening();
      }
    })().finally(() => {
      stopHostPromise = null;
    });
    return stopHostPromise;
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

  return {
    startHost,
    stopHost,
    isHosting,
    startDiscoveryListening,
    stopDiscoveryListening,
    getDiscoveredGames,
    setDiscoveredGamesListener,
    disposeAll,
  };
}

module.exports = createLanOwner();
module.exports.createLanOwner = createLanOwner;
