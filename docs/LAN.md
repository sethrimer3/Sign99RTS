# Sign99RTS — LAN Multiplayer Guide

Sign99RTS supports local-area-network (LAN) multiplayer for up to 8 players,
host-authoritative over a WebSocket relay. **The desktop (Electron) build is
fully self-contained** — the game itself hosts the relay and LAN discovery
in its own process. Players never need to install or run Node, `tsx`, `npm`,
or a dev server.

## Desktop usage (normal players)

1. Launch Sign99RTS.
2. **Host:** Play → LAN Multiplayer → **Host LAN Lobby**. The game starts a
   WebSocket relay on port `8787` and begins advertising the lobby on the
   local network.
3. **Join automatically:** Play → LAN Multiplayer → **Find LAN Games**. Hosts
   on the same network appear within a few seconds; click one to join.
4. **Join manually (fallback):** Play → LAN Multiplayer → **Join Manually**,
   and enter the host's LAN IP — just `192.168.1.25` works, or the full
   `ws://192.168.1.25:8787` if you prefer. Useful when discovery is blocked
   (some routers isolate Wi-Fi clients, some VPNs don't pass broadcast
   traffic) but a direct connection still works.
5. Leaving the lobby, or closing the game, cleanly stops hosting and LAN
   discovery — a fresh **Host LAN Lobby** always starts a brand-new,
   empty lobby.

No configuration or firewall setup is required in the common case; see
**Firewall ports** below if a connection fails.

## Architecture

```
HOST MACHINE                          CLIENT MACHINE
Sign99RTS Electron                    Sign99RTS Electron
├── Renderer                          ├── Renderer
│   └── UI + game simulation          │   └── UI + game
│       (connects to its own          │       (connects out to the
│        local host over              │        host's LAN IP over
│        ws://127.0.0.1:8787)         │        ws://<host-ip>:8787)
└── Electron main process             └── Electron main process
    ├── WebSocket LAN relay               └── UDP LAN discovery listener
    ├── UDP LAN discovery broadcaster
    └── UDP LAN discovery listener
```

- The **WebSocket relay** (`server/lanHost.ts` → compiled to
  `dist-server/server/lanHost.js`) is host-authoritative: the host's
  renderer runs the real game simulation and broadcasts snapshots through
  the relay; other clients send input and receive snapshots.
- **LAN discovery** (`server/lanDiscoveryCore.ts` + the pure protocol logic
  in `src/lan/discovery.ts`) is a separate concern from hosting: discovery
  *listening* can run any time the multiplayer menu is open, independent of
  whether this machine is also hosting.
- The renderer never touches raw sockets. It talks to the main process
  through a narrow, explicit bridge (`electron/preload.cjs`):
  `window.sign99Lan.{startHost, stopHost, startDiscovery, stopDiscovery,
  getDiscoveredGames, onDiscoveredGamesChanged}`. `contextIsolation`,
  `nodeIntegration: false`, and the sandboxed preload are unchanged.
- **Local host server**, **LAN discovery**, and **remote host connection**
  are kept architecturally distinct: only the player who clicked *Host LAN
  Lobby* ever starts a local server or advertises; a joining client only
  ever opens an outbound WebSocket to the address it discovered or typed,
  and never starts or connects to a server of its own.
- **Host identity is deterministic, not order-dependent.** When Electron
  starts a hosted lobby it generates a fresh, cryptographically random
  `hostToken` (`src/lan/hostToken.ts`) and returns it *only* in that IPC
  response, to the local renderer. The renderer's own WebSocket connection
  presents that token; the relay only ever promotes the connection
  presenting the matching token to host (slot 0) — a remote machine that
  happens to reach the relay before the local renderer finishes connecting
  can never be mistaken for the host, and a connection presenting a wrong
  token is rejected outright. The token is never included in discovery
  advertisements and never logged. (The standalone dev/browser CLI,
  `server/lanServer.ts`, has no IPC channel to hand a token to a plain
  browser tab, so it falls back to the original first-connection-is-host
  behavior — acceptable for local development only.)
- **Hosting has one authoritative shutdown path.** Whether the host clicks
  Back/Disconnect, quits an active match to the menu, the local host's
  WebSocket connection drops unexpectedly (crash/reload), or the app
  quits, the same teardown runs: the WebSocket server stops accepting
  connections and releases its port, UDP advertising stops, and remaining
  clients receive a clean `match_end`/disconnect reason. A fresh *Host LAN
  Lobby* afterward always starts a brand-new lobby and can immediately
  rebind the same port.

### Production build

`npm run build` compiles both the client (`dist/`, via Vite) and the LAN
server modules (`dist-server/`, via `npm run build:server` /
`tsc --project tsconfig.server.json`) to plain JavaScript. The Electron main
process (`electron/lan.cjs`) loads `dist-server/server/lanHost.js` and
`dist-server/server/lanDiscoveryCore.js` with a dynamic `import()` — there is
no `tsx`, no TypeScript, and no separate Node process involved at runtime.
Packaging the desktop app must include `dist/`, `dist-server/`, `electron/`,
and `node_modules/ws` (the only runtime dependency the LAN modules need).

## LAN protocol version

Every WebSocket handshake and UDP advertisement carries `LAN_PROTOCOL_VERSION`
(`src/lan/protocol.ts`). A client running a different network protocol
version is rejected with:

> This LAN game is running a different Sign99RTS network version.

...instead of connecting and behaving unpredictably. Bump
`LAN_PROTOCOL_VERSION` whenever the wire format changes.

## Firewall ports

| Purpose                    | Protocol | Port (default) |
|-----------------------------|----------|-----------------|
| LAN relay (game traffic)    | TCP      | `8787`          |
| LAN discovery (broadcast)   | UDP      | `47888`         |
| Vite dev server (browser dev only) | TCP | `5173`     |

On first host/join, Windows may prompt to allow the game through the
firewall on a private network — accept it. The game logs enough to tell
these apart:

```
[LAN] WebSocket server listening on 0.0.0.0:8787
[LAN] Advertising lobby on 192.168.1.25
[LAN] Discovery listening on UDP 47888
```

If something fails, the log (and the in-game error text) distinguishes:
- **host server failed to start** — e.g. `LAN port 8787 is already in use.`
- **discovery failed to bind** — UDP port already in use or blocked.
- **discovered a host but the TCP connection failed** — a firewall is likely
  blocking port 8787 on the host machine, even though discovery worked.
- **protocol mismatch** — `This LAN game is running a different Sign99RTS
  network version.`
- **host closed the lobby** — `Host closed the lobby.` / `Host disconnected.`

We don't guess "it's your firewall" — the log tells you which stage failed.

## Developer / browser testing

The Electron LAN modules are TypeScript under `server/` and `src/lan/`, so
they can also run standalone for testing the game in a plain browser
(`vite`) instead of Electron:

```bash
# machine A
npm run dev:lan

# machine B, same network
http://<machine-A-LAN-IP>:5173
```

`npm run dev:lan` runs two dev-only processes concurrently:
- `npm run dev:host` — the normal Vite dev server, bound to all interfaces
  (`vite --host`) instead of just localhost, so another machine on the LAN
  can load the page.
- `npm run lan:server` — `server/lanServer.ts` via `tsx`, a thin standalone
  entry point around the same `lanHost`/`lanDiscoveryCore` modules Electron
  uses in production. It also exposes a **loopback-only**, read-only HTTP
  endpoint (`http://127.0.0.1:8788/lan/discovered`) so a plain browser page
  — which cannot open raw UDP sockets or talk to Electron IPC — can still
  poll discovered lobbies. This endpoint has no control operations (no
  remote reset/start/stop) and is never exposed to the network.

Plain `npm run dev` is unaffected — it still binds to localhost only.

Browsers cannot send or receive raw UDP, so **automatic discovery from a
plain browser tab is not possible**; use **Join Manually** with the host's
IP when testing this way. Discovery works normally in the Electron desktop
build on both sides.

### HTTPS / mixed-content note

If the game is ever served over HTTPS (e.g. GitHub Pages), browsers block
plain `ws://` connections from an HTTPS page (mixed content). For LAN
development, open the game itself over `http://HOST_IP:5173` rather than an
HTTPS URL, so the page can open `ws://HOST_IP:8787`.

## Manual join address formats

The **Join Manually** field accepts, and normalizes automatically
(`src/lan/lanAddress.ts`):
- a bare IP or hostname: `192.168.1.25`, `my-host` (port `8787` assumed)
- host with an explicit port: `192.168.1.25:9001`
- a full URL: `ws://192.168.1.25:8787`, `wss://host:8787`
- `http://`/`https://` URLs, converted to `ws://`/`wss://` automatically
- bracketed or bare IPv6 literals: `[fe80::1]:8787`, `fe80::1`

## Testing

- `src/lan/lanAddress.test.ts` — manual address normalization
- `src/lan/discovery.test.ts` — advertisement build/parse, stale pruning,
  duplicate/malformed advertisements, source-address verification,
  multi-adapter interface selection
- `src/lan/lanLobby.test.ts` — slot bookkeeping, protocol-mismatch/lobby-full/
  match-in-progress join decisions
- `src/lan/lanIntegration.test.ts` — end-to-end: a real `startLanHostServer`
  plus real `LanClient`s over loopback sockets, covering host→join→ready→
  start_match, protocol-mismatch rejection, lobby-full rejection, and clean
  host-disappearance notification

Run with `npm test`. `npm run typecheck` and `npm run typecheck:server`
check the client and server/`src/lan` TypeScript respectively; `npm run
build` produces the full production output (`dist/` + `dist-server/`).
