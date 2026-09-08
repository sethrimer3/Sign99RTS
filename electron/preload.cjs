const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// LAN bridge.
//
// Narrow, explicit surface — the renderer never gets raw Node networking
// objects. All actual LAN networking (WebSocket relay, UDP discovery) runs
// in the Electron main process (electron/lan.cjs); this just forwards
// requests and discovery-changed pushes across the context bridge.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('sign99Lan', {
  /** Start hosting a LAN lobby. Resolves { ok, port, lobbyId, wsUrl } or { ok: false, error }. */
  startHost: (opts) => ipcRenderer.invoke('sign99:lan:start-host', opts),
  /** Stop hosting (safe to call even if not hosting). */
  stopHost: () => ipcRenderer.invoke('sign99:lan:stop-host'),
  /** Begin listening for other LAN hosts' advertisements. */
  startDiscovery: () => ipcRenderer.invoke('sign99:lan:start-discovery'),
  /** Stop listening for advertisements. */
  stopDiscovery: () => ipcRenderer.invoke('sign99:lan:stop-discovery'),
  /** One-shot read of the currently known discovered lobbies. */
  getDiscoveredGames: () => ipcRenderer.invoke('sign99:lan:get-discovered'),
  /** Subscribe to live discovery updates. Returns an unsubscribe function. */
  onDiscoveredGamesChanged: (handler) => {
    const wrapped = (_e, lobbies) => handler(lobbies);
    ipcRenderer.on('sign99:lan:discovered-changed', wrapped);
    return () => ipcRenderer.removeListener('sign99:lan:discovered-changed', wrapped);
  },
});

// ---------------------------------------------------------------------------
// Steam bridge.
//
// The preload runs sandboxed, so it cannot `require` electron/steam/steamChannels.cjs.
// Channel strings are duplicated here verbatim; electron/steam/__tests__ (or the
// vitest parity test in src/steam) asserts they match the single source of truth.
// The renderer only ever sees this explicit, minimal method surface — never a
// generic `invoke(anyChannel)`.
// ---------------------------------------------------------------------------

const REQ = {
  init: 'sign99:steam:init',
  identity: 'sign99:steam:identity',
  lobbyHost: 'sign99:steam:lobby:host',
  lobbyList: 'sign99:steam:lobby:list',
  lobbyJoin: 'sign99:steam:lobby:join',
  lobbyLeave: 'sign99:steam:lobby:leave',
  lobbySetData: 'sign99:steam:lobby:setData',
  lobbyInvite: 'sign99:steam:lobby:invite',
  setConnect: 'sign99:steam:setConnect',
  takePendingJoin: 'sign99:steam:takePendingJoin',
  netSend: 'sign99:steam:net:send',
  netAccept: 'sign99:steam:net:accept',
};

const EVT = {
  status: 'sign99:steam:evt:status',
  lobby: 'sign99:steam:evt:lobby',
  joinRequested: 'sign99:steam:evt:joinRequested',
  netPacket: 'sign99:steam:evt:netPacket',
  netSessionRequest: 'sign99:steam:evt:netSessionRequest',
  netSessionFailed: 'sign99:steam:evt:netSessionFailed',
};

/** Wrap webContents push events as add/remove listener pairs with cleanup. */
function subscription(channel) {
  return (handler) => {
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('sign99Steam', {
  /** True in every Electron build — lets the renderer know the bridge exists. */
  available: true,

  init: () => ipcRenderer.invoke(REQ.init),
  getIdentity: () => ipcRenderer.invoke(REQ.identity),

  hostLobby: (opts) => ipcRenderer.invoke(REQ.lobbyHost, opts),
  listLobbies: () => ipcRenderer.invoke(REQ.lobbyList),
  joinLobby: (lobbyId) => ipcRenderer.invoke(REQ.lobbyJoin, { lobbyId }),
  leaveLobby: () => ipcRenderer.invoke(REQ.lobbyLeave),
  setLobbyData: (patch) => ipcRenderer.invoke(REQ.lobbySetData, { patch }),
  openInviteDialog: () => ipcRenderer.invoke(REQ.lobbyInvite),
  setConnectString: (connect) => ipcRenderer.invoke(REQ.setConnect, { connect }),
  takePendingJoin: () => ipcRenderer.invoke(REQ.takePendingJoin),

  netSend: (toSteamId, reliable, bytes) =>
    ipcRenderer.invoke(REQ.netSend, { toSteamId, reliable, bytes, channel: reliable ? 0 : 1 }),
  netAccept: (steamId) => ipcRenderer.invoke(REQ.netAccept, { steamId }),

  onStatus: subscription(EVT.status),
  onLobbyEvent: subscription(EVT.lobby),
  onJoinRequested: subscription(EVT.joinRequested),
  onNetPacket: subscription(EVT.netPacket),
  onNetSessionRequest: subscription(EVT.netSessionRequest),
  onNetSessionFailed: subscription(EVT.netSessionFailed),
});
