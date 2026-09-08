const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const steamBridge = require('./steam/steamworksBridge.cjs');
const lan = require('./lan.cjs');

// Enable the Steam overlay for Electron (appends GPU command-line switches, so
// must run before app is ready). Safe no-op if the native addon is missing.
try {
  require('steamworks.js').electronEnableSteamOverlay();
} catch (e) {
  console.warn('[Steam] overlay not enabled:', e && e.message ? e.message : e);
}

const REPO_ROOT = path.join(__dirname, '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.html');
const USER_DATA_DIR = path.join(REPO_ROOT, '.electron-user-data');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
const APP_ICON_PATH = path.resolve(REPO_ROOT, 'ASSETS', 'icon', 'Sign99_Icon.ico');
const OPEN_DEVTOOLS =
  process.argv.includes('--devtools') ||
  process.env.ELECTRON_DEBUG === '1' ||
  process.env.ELECTRON_DEBUG === 'true';
const ELECTRON_DEV_URL = process.env.SIGN99_ELECTRON_DEV_URL ?? '';
const IS_DEV_RENDERER = ELECTRON_DEV_URL.length > 0;
const DISABLE_GPU =
  process.env.SIGN99_DISABLE_GPU === '1' ||
  process.env.SIGN99_DISABLE_GPU === 'true';

app.setPath('userData', USER_DATA_DIR);

if (DISABLE_GPU) {
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------------------
// LAN networking IPC — the desktop game owns its own LAN relay + discovery
// (see electron/lan.cjs). No external process, no tsx, no dev server.
//
// Hosting is never started automatically at app launch: it starts only when
// the renderer explicitly asks (the player clicked "Host LAN Lobby"), and
// stops cleanly when the renderer asks or the app quits. Discovery
// *listening* is cheap and may run independently while the multiplayer
// menu is open, regardless of whether this machine is also hosting.
// ---------------------------------------------------------------------------

function broadcastDiscoveredGames(win, lobbies) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('sign99:lan:discovered-changed', lobbies);
  }
}

function installLanIpc(win) {
  lan.setDiscoveredGamesListener((lobbies) => broadcastDiscoveredGames(win, lobbies));

  ipcMain.handle('sign99:lan:start-host', async (_event, opts) => {
    return lan.startHost(opts || {});
  });
  ipcMain.handle('sign99:lan:stop-host', async () => {
    await lan.stopHost();
    return { ok: true };
  });
  ipcMain.handle('sign99:lan:start-discovery', async () => {
    return lan.startDiscoveryListening();
  });
  ipcMain.handle('sign99:lan:stop-discovery', async () => {
    lan.stopDiscoveryListening();
    return { ok: true };
  });
  ipcMain.handle('sign99:lan:get-discovered', async () => {
    return { lobbies: lan.getDiscoveredGames() };
  });
}

function joinCspDirectives(directives) {
  return directives
    .map(([name, ...values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

function createProductionCsp() {
  return joinCspDirectives([
    ['default-src', "'self'", 'file:'],
    ['script-src', "'self'", 'file:'],
    ['style-src', "'self'", "'unsafe-inline'", 'file:'],
    ['img-src', "'self'", 'data:', 'blob:', 'file:'],
    ['media-src', "'self'", 'data:', 'blob:', 'file:'],
    ['font-src', "'self'", 'data:', 'file:'],
    ['connect-src', "'self'", 'http://127.0.0.1:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'ws://localhost:*', 'http://*:*', 'ws://*:*'],
    ['worker-src', "'self'", 'blob:', 'file:'],
    ['child-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['frame-ancestors', "'none'"],
  ]);
}

function createDevelopmentCsp() {
  return joinCspDirectives([
    ['default-src', "'self'", 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['script-src', "'self'", "'unsafe-eval'", 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['style-src', "'self'", "'unsafe-inline'", 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['img-src', "'self'", 'data:', 'blob:', 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['media-src', "'self'", 'data:', 'blob:', 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['font-src', "'self'", 'data:', 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['connect-src', "'self'", 'http://localhost:*', 'http://127.0.0.1:*', 'ws://localhost:*', 'ws://127.0.0.1:*', 'http://*:*', 'ws://*:*'],
    ['worker-src', "'self'", 'blob:', 'file:', 'http://localhost:*', 'http://127.0.0.1:*'],
    ['child-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['frame-ancestors', "'none'"],
  ]);
}

function installElectronCsp() {
  const csp = IS_DEV_RENDERER ? createDevelopmentCsp() : createProductionCsp();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    delete responseHeaders['Content-Security-Policy'];
    delete responseHeaders['content-security-policy'];
    responseHeaders['Content-Security-Policy'] = [csp];
    callback({ responseHeaders });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#000000',
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      ...(fs.existsSync(PRELOAD_PATH) ? { preload: PRELOAD_PATH } : {}),
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (OPEN_DEVTOOLS) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  if (IS_DEV_RENDERER) {
    void win.loadURL(ELECTRON_DEV_URL);
    return;
  }

  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(`Missing built game entry: ${DIST_INDEX}. Run npm run build first.`);
  }

  void win.loadFile(DIST_INDEX);
}

// Single-instance lock so a "Join Game" launch while the game is already
// running is delivered to the existing instance via `second-instance` argv
// instead of starting a duplicate process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  steamBridge.ingestLaunchArgs(argv);
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  installElectronCsp();
  createWindow();
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    installLanIpc(win);
    // Lazy init: the bridge only calls steamworks.init() when the renderer first
    // asks (Multiplayer menu). Pass { eager: true } to init at boot instead.
    steamBridge.attach(win, { eager: process.env.SIGN99_STEAM_EAGER === '1' });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  lan.disposeAll();
  steamBridge.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
