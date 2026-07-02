'use strict';

/**
 * main.js — Electron entry point.
 *
 * Responsibilities:
 *   - configure logging + storage
 *   - hold the Roblox single-instance Event (the multi-instance enabler)
 *   - create the native-framed window
 *   - run the process monitor and stream updates to the renderer
 *   - guard against unhandled errors so the app does not crash
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, session } = require('electron');
const path = require('path');

const logger = require('./logger');
const store = require('./store');
const native = require('./native');
const roblox = require('./roblox');
const clones = require('./clones');
const guard = require('./guard');
const accounts = require('./accounts');
const games = require('./games');
const people = require('./people');
const updater = require('./updater');
const ipc = require('./ipc');
const { ProcessMonitor } = require('./monitor');

let mainWindow = null;
let splashWindow = null;
let splashShownAt = 0;
let monitor = null;
const SPLASH_MIN_MS = 900;
let mainShown = false;
let startupWatchdog = null;

// Only allow a single Fleet instance; a second launch focuses the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.toluwa.fleet');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(onReady).catch(showStartupError);
}

async function onReady() {
  // 1. Storage + logging
  const userData = app.getPath('userData');
  logger.configure(userData);
  store.configure(userData, logger);
  logger.info('Fleet ' + app.getVersion() + ' starting');

  // Put something on screen before probing Roblox/native components. On slow
  // or locked-down PCs those probes can take several seconds.
  createSplash();
  startupWatchdog = setTimeout(() => {
    logger.warn('Startup watchdog revealed the main window');
    finishSplashThenShow();
  }, 12000);
  await new Promise(resolve => setTimeout(resolve, 60));

  const settings = store.getSettings();

  // 2. Initialise FFI + multi-instance machinery
  try { native.init(); } catch (err) { logger.warn('Native initialization failed', err && err.message); }
  if (!native.isAvailable()) {
    logger.warn('Native FFI unavailable; multi-instance disabled', native.getLoadError());
  } else {
    logger.info('Native ready; object type indices ' + JSON.stringify(native.getTypeIndices()));
  }
  clones.configure(path.join(userData, 'clones'), logger);
  accounts.configure({ baseDir: userData, safeStorage, BrowserWindow, session, logger });
  games.configure({ logger });
  people.configure({ logger });
  const loc = roblox.locate(settings);
  guard.configure({
    logger,
    playerPath: loc.playerPath,
    getPids: () => (monitor ? monitor.snapshot().map(i => i.pid) : []),
  });
  if (native.isAvailable()) guard.start();

  // 3. Process monitor
  monitor = new ProcessMonitor({ intervalMs: settings.pollIntervalMs, logger });
  monitor.on('update', (payload) => sendToRenderer('instances:update', payload));
  monitor.start();

  // 4. Stream new log lines to the Diagnostics page
  logger.onEntry((entry) => sendToRenderer('log:entry', entry));

  // 4b. Real-time per-account presence: push only the cards that changed.
  // Expired sessions are reported to the UI, but Fleet never opens a login
  // window or Roblox client during startup/background polling.
  accounts.startPolling({
    intervalMs: 12000,
    onUpdate: (acc) => sendToRenderer('account:update', acc),
    onExpired: (acc) => handleExpiredAccount(acc),
  });

  // 5. IPC
  ipc.register({
    ipcMain, app, dialog, shell, monitor,
    getWindow: () => mainWindow,
  });

  // 6. Window + menu
  Menu.setApplicationMenu(null); // keep it minimal; native frame stays
  createWindow();
  updater.configure({ app, logger, getWindow: () => mainWindow, send: sendToRenderer });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// Renderer theme changes recolor the native window-controls overlay so the
// min/max/close buttons match light/dark mode.
ipcMain.handle('ui:titlebar', (_event, payload) => {
  const dark = !!(payload && payload.dark);
  try {
    if (mainWindow) {
      mainWindow.setTitleBarOverlay({ color: dark ? '#0b0c0e' : '#ffffff', symbolColor: dark ? '#f2f3f5' : '#14161a', height: 44 });
      mainWindow.setBackgroundColor(dark ? '#0b0c0e' : '#ffffff');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

function createWindow() {
  mainShown = false;
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'Fleet',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    show: false,
    // Hidden title bar with the native min/max/close controls overlaid (Windows
    // Controls Overlay) — no title-bar icon or text, but real native buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#14161a', height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    const elapsed = Date.now() - splashShownAt;
    const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
    setTimeout(() => finishSplashThenShow(), wait);
  });

  // ready-to-show is not guaranteed after a renderer/GPU hiccup. A completed
  // load and a hard timeout both reveal the window so users are never trapped
  // behind a permanent splash screen.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => finishSplashThenShow(), SPLASH_MIN_MS);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    logger.error('UI load failed', `${code}: ${description}`);
    finishSplashThenShow();
    try { dialog.showErrorBox('Fleet could not load its interface', `${description}\n\nOpen Diagnostics after restarting Fleet, or reinstall the latest version.`); } catch (_) {}
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer stopped', details && details.reason);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    .catch(err => logger.error('Failed to load UI', err && err.message));
}

function createSplash() {
  splashShownAt = Date.now();
  splashWindow = new BrowserWindow({
    width: 380, height: 260,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, center: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html')).catch(() => {});
  splashWindow.once('ready-to-show', () => { try { splashWindow.show(); } catch (_) {} });
}

function finishSplashThenShow() {
  const showMain = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainShown) {
      mainShown = true;
      if (startupWatchdog) { clearTimeout(startupWatchdog); startupWatchdog = null; }
      mainWindow.show();
    }
    if (monitor) sendToRenderer('instances:update', { instances: monitor.snapshot(), summary: null });
  };
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => {});
    setTimeout(() => {
      try { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close(); } catch (_) {}
      splashWindow = null;
      showMain();
    }, 430);
  } else {
    showMain();
  }
}

function handleExpiredAccount(acc) {
  logger.warn('Account session expired: ' + acc.username + ' — waiting for explicit sign-in');
  sendToRenderer('account:expired', acc);
}

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (_) { /* window may be closing */ }
}

/* ----------------------------- Lifecycle ----------------------------- */

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { if (monitor) monitor.stop(); } catch (_) {}
  try { accounts.stopPolling(); } catch (_) {}
  try { guard.stop(); } catch (_) {}
  try { clones.cleanup(); } catch (_) {}
  try { updater.stop(); } catch (_) {}
  logger.info('Fleet shutting down');
});

/* ----------------------------- Crash guards ----------------------------- */

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err && (err.stack || err.message));
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason && (reason.stack || reason.message || String(reason)));
});

function showStartupError(err) {
  const detail = err && (err.stack || err.message) || String(err);
  console.error('STARTUP FAILED:', detail);
  try {
    logger.error('Startup failed', detail);
    dialog.showErrorBox('Fleet could not start', `${detail}\n\nReinstall Fleet or open its logs under your AppData folder.`);
  } catch (_) {}
  app.quit();
}
