'use strict';

/** GitHub Releases auto-update support for installed NSIS builds. */

let autoUpdater = null;
let appRef = null;
let logger = { info() {}, warn() {}, error() {} };
let getWindow = () => null;
let send = () => {};
let checkTimer = null;
let promptShown = false;
let current = { state: 'idle', version: null, percent: 0, error: null };

function emit(patch) {
  current = Object.assign({}, current, patch || {});
  try { send('updater:status', current); } catch (_) {}
}

function configure(opts) {
  opts = opts || {};
  appRef = opts.app;
  logger = opts.logger || logger;
  getWindow = opts.getWindow || getWindow;
  send = opts.send || send;
  current.version = appRef && appRef.getVersion ? appRef.getVersion() : null;

  // Development/portable runs have no NSIS updater metadata. They remain fully
  // functional; only installed production builds check GitHub Releases.
  if (!appRef || !appRef.isPackaged) {
    emit({ state: 'disabled', error: null });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: message => logger.info('Updater', String(message)),
      warn: message => logger.warn('Updater', String(message)),
      error: message => logger.error('Updater', String(message)),
      debug: message => logger.info('Updater debug', String(message)),
    };

    autoUpdater.on('checking-for-update', () => emit({ state: 'checking', error: null }));
    autoUpdater.on('update-available', info => emit({ state: 'available', availableVersion: info.version, error: null }));
    autoUpdater.on('update-not-available', () => emit({ state: 'current', error: null }));
    autoUpdater.on('download-progress', progress => emit({
      state: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)), error: null,
    }));
    autoUpdater.on('error', err => emit({ state: 'error', error: (err && err.message) || String(err) }));
    autoUpdater.on('update-downloaded', info => {
      emit({ state: 'ready', availableVersion: info.version, percent: 100, error: null });
      promptRestart(info.version);
    });

    setTimeout(() => check(false), 5000);
    checkTimer = setInterval(() => check(false), 4 * 60 * 60 * 1000);
  } catch (err) {
    logger.warn('Auto-updater unavailable', err && err.message);
    emit({ state: 'error', error: 'Automatic updates could not start.' });
  }
}

async function promptRestart(version) {
  if (promptShown) return;
  promptShown = true;
  try {
    const { dialog } = require('electron');
    const result = await dialog.showMessageBox(getWindow() || undefined, {
      type: 'info',
      title: 'Fleet update ready',
      message: `Fleet ${version || 'update'} is ready to install.`,
      detail: 'Restart now to finish updating, or choose Later and Fleet will update when you close it.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) install();
  } catch (err) {
    logger.warn('Could not show update prompt', err && err.message);
  }
}

async function check(manual) {
  if (!autoUpdater) return { ok: false, error: 'Automatic updates are available in the installed version.' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result && result.updateInfo || null, status: current };
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (manual) emit({ state: 'error', error: message });
    return { ok: false, error: message };
  }
}

function install() {
  if (!autoUpdater || current.state !== 'ready') return { ok: false, error: 'No downloaded update is ready.' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

function status() { return Object.assign({ ok: true }, current); }
function stop() { if (checkTimer) { clearInterval(checkTimer); checkTimer = null; } }

module.exports = { configure, check, install, status, stop };
