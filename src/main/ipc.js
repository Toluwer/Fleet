'use strict';

/**
 * ipc.js — the single place where renderer requests meet the service layer.
 *
 * Every channel is registered through `safe()` which wraps the handler in
 * try/catch, logs failures, and always resolves to a structured result. The
 * renderer therefore never sees an unhandled rejection, and one failing action
 * can never take the app down.
 */

const os = require('os');
const path = require('path');

const logger = require('./logger');
const store = require('./store');
const roblox = require('./roblox');
const native = require('./native');
const launcher = require('./launcher');
const processes = require('./processes');
const clones = require('./clones');
const guard = require('./guard');
const accounts = require('./accounts');
const people = require('./people');
const games = require('./games');
const updater = require('./updater');
const playtime = require('./playtime');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function asInt(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }

function register(ctx) {
  const { ipcMain, app, dialog, shell, getWindow, monitor } = ctx;

  const safe = (channel, fn) => {
    ipcMain.handle(channel, async (_evt, payload) => {
      try {
        return await fn(payload || {});
      } catch (err) {
        logger.error('IPC ' + channel + ' failed', err && err.message);
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
  };

  /* ----------------------------- App / status ----------------------------- */

  function buildStatus() {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    return {
      ok: true,
      appVersion: app.getVersion(),
      robloxFound: loc.found,
      playerPath: loc.playerPath,
      version: loc.version,
      source: loc.source,
      candidates: loc.candidates,
      multiInstance: native.isAvailable(),     // can we run multiple clients?
      ffiAvailable: native.isAvailable(),
      ffiError: native.getLoadError(),
      guard: guard.stats(),
      settings,
    };
  }

  safe('app:status', () => buildStatus());
  safe('updater:status', () => updater.status());
  safe('updater:check', () => updater.check(true));
  safe('updater:install', () => updater.install());

  safe('roblox:detect', () => {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    if (loc.found) guard.setPlayerPath(loc.playerPath);
    logger.info('Roblox detection: ' + (loc.found ? (loc.source + ' -> ' + loc.playerPath) : 'NOT FOUND'));
    return Object.assign({ ok: true }, loc);
  });

  /* ----------------------------- Launching ----------------------------- */

  /**
   * Launch one client with path isolation: each instance runs through its own
   * directory junction so its per-path mutex never collides with the others.
   */
  function launchIsolated(loc, opts, profileName) {
    let exe = loc.playerPath;
    let slot = null;
    // Path-isolate every launch (plain client OR authenticated deep link) so
    // each instance gets a unique per-path mutex and multiple coexist.
    if (native.isAvailable()) {
      try {
        const livePids = (monitor.snapshot() || []).map(i => i.pid);
        const acq = clones.acquire(path.dirname(loc.playerPath), livePids);
        exe = acq.exe;
        slot = acq.slot;
      } catch (err) {
        logger.warn('Path isolation unavailable, launching directly', err && err.message);
      }
    }
    guard.noteLaunch();
    const r = launcher.launchInstance({ playerPath: exe, mode: opts.mode, deeplink: opts.deeplink });
    if (r.ok && r.pid) {
      if (slot) clones.assign(slot, r.pid);
      monitor.markManaged(r.pid, { profileName, mode: opts.mode, deeplink: opts.deeplink, playerPath: loc.playerPath, exePath: exe });
    }
    store.addHistory({ profileName, mode: opts.mode, result: r.ok ? 'launched' : 'failed', pid: r.pid, message: r.ok ? '' : (r.reason || 'failed') });
    return r;
  }

  async function doLaunch({ mode, deeplink, count, profileName, accountIds, placeId, gameInstanceId, targetUserId }) {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    if (!loc.found) {
      const reason = 'Roblox is not installed or could not be found. Open Settings to set the path manually.';
      logger.warn('Launch blocked: ' + reason);
      return { ok: false, error: reason };
    }
    guard.setPlayerPath(loc.playerPath);
    guard.start();

    const results = [];

    if (Array.isArray(accountIds) && accountIds.length) {
      // Authenticated launches: one client per selected account.
      const pid = (placeId || '').toString().trim() || null;
      for (let i = 0; i < accountIds.length; i++) {
        const li = targetUserId
          ? await accounts.getPersonJoinLaunchInfo(accountIds[i], targetUserId)
          : await accounts.getLaunchInfo(accountIds[i], pid, gameInstanceId);
        if (!li.ok) {
          results.push({ ok: false, reason: li.reason });
          store.addHistory({ profileName: 'Account', mode: 'account', result: 'failed', message: li.reason });
        } else {
          results.push(launchIsolated(loc, { mode: 'deeplink', deeplink: li.deeplink }, li.username));
        }
        monitor.poll();
        if (i < accountIds.length - 1) await delay(settings.launchDelayMs);
      }
    } else {
      // Plain (signed-out) clients.
      const opts = { mode: mode === 'deeplink' ? 'deeplink' : 'client', deeplink: deeplink || '' };
      const name = profileName || 'Quick launch';
      const n = Math.max(1, Math.min(20, asInt(count) || 1));
      for (let i = 0; i < n; i++) {
        results.push(launchIsolated(loc, opts, name));
        monitor.poll();
        if (i < n - 1) await delay(settings.launchDelayMs);
      }
    }

    const launched = results.filter(r => r.ok).length;
    const failed = results.length - launched;
    logger.info(`Launch: ${launched} started, ${failed} failed`);
    monitor.poll();
    return {
      ok: launched > 0,
      launched, failed,
      multiInstance: native.isAvailable(),
      results,
    };
  }

  safe('launch:quick', (p) => doLaunch({ mode: 'client', count: p.count, profileName: 'Quick launch' }));

  safe('launch:accounts', (p) => doLaunch({ accountIds: p.accountIds, placeId: p.placeId }));

  // Join a specific person/game: place + optional exact server (gameId).
  safe('launch:join', (p) => doLaunch({
    accountIds: p.accountIds, placeId: p.placeId, gameInstanceId: p.gameId || null,
  }));

  // Resolve the target's exact server with the selected account's own session,
  // then launch only that account. Public presence can hide the server job ID.
  safe('launch:join-person', async (p) => {
    const accountId = String(p.accountId || '');
    const targetUserId = asInt(p.targetUserId);
    if (!accountId || !targetUserId) return { ok: false, error: 'Choose an account and player first.' };
    return doLaunch({ accountIds: [accountId], targetUserId });
  });

  // Follow the same player with several selected accounts. Each account gets
  // its own single-use ticket and Roblox evaluates its join permission.
  safe('launch:join-person-multi', async (p) => {
    const targetUserId = asInt(p.targetUserId);
    const accountIds = Array.from(new Set(
      (Array.isArray(p.accountIds) ? p.accountIds : []).map(id => String(id || '')).filter(Boolean),
    )).slice(0, 20);
    if (!targetUserId || !accountIds.length) return { ok: false, error: 'Choose at least one account and a player.' };
    return doLaunch({ accountIds, targetUserId });
  });

  /* ----------------------------- People ----------------------------- */

  safe('people:list', (p) => people.listFriends(asInt(p.page) || 0, asInt(p.pageSize) || 9, !!p.force));
  safe('people:server-list', (p) => people.listServerPeople(!!p.force));
  safe('people:search', (p) => people.search(p.query, p.cursor));
  safe('people:profile', (p) => people.profile(p.userId));
  safe('people:presence', (p) => people.presence(p.userIds));

  /* ----------------------------- Accounts ----------------------------- */

  safe('accounts:list', () => ({ ok: true, accounts: accounts.list() }));
  safe('accounts:add', () => accounts.add());
  safe('accounts:remove', (p) => accounts.remove(p.id));
  safe('accounts:refresh', (p) => accounts.refresh(p.id, p.full));
  safe('accounts:follow', async (p) => {
    const targetAccountId = String(p.targetAccountId || '');
    const followerAccountIds = Array.from(new Set(
      (Array.isArray(p.followerAccountIds) ? p.followerAccountIds : [])
        .map(id => String(id || ''))
        .filter(id => id && id !== targetAccountId),
    )).slice(0, 20);

    if (!targetAccountId) return { ok: false, error: 'Choose an account to follow.' };
    if (!followerAccountIds.length) return { ok: false, error: 'Choose at least one other account to follow with.' };

    const context = await accounts.getFollowContext(targetAccountId);
    if (!context.ok) return { ok: false, error: context.reason };

    logger.info(`Following ${context.username}'s server with ${followerAccountIds.length} account(s)`);
    const result = await doLaunch({
      accountIds: followerAccountIds,
      placeId: context.placeId,
      gameInstanceId: context.gameInstanceId,
    });
    return Object.assign({}, result, {
      targetUsername: context.username,
      targetDisplayName: context.displayName,
      placeId: context.placeId,
    });
  });

  /* ----------------------------- Games ----------------------------- */

  safe('games:browse', () => games.browse());
  safe('games:search', (p) => games.search(p.query, p.pageToken));
  safe('games:servers', (p) => games.servers(p.placeId, p.cursor));
  safe('games:server-scan', (p) => games.scanServers(p.placeId, p.pageLimit));

  /* ----------------------------- Instances ----------------------------- */

  safe('instances:get', () => ({ ok: true, instances: monitor.snapshot() }));

  safe('instance:focus', (p) => {
    const pid = asInt(p.pid);
    if (!pid) return { ok: false, error: 'Invalid PID.' };
    const r = native.focusByPid(pid);
    return Object.assign({ ok: r.ok }, r);
  });

  safe('instance:kill', async (p) => {
    const pid = asInt(p.pid);
    if (!pid) return { ok: false, error: 'Invalid PID.' };
    const r = await processes.kill(pid, true);
    monitor.forget(pid);
    logger.info('Ended instance PID ' + pid, r.output);
    monitor.poll();
    return r;
  });

  safe('instance:restart', async (p) => {
    const pid = asInt(p.pid);
    if (!pid) return { ok: false, error: 'Invalid PID.' };
    const managed = monitor.getManaged(pid);
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    if (!loc.found) return { ok: false, error: 'Roblox player not found for restart.' };
    guard.setPlayerPath(loc.playerPath);
    guard.start();

    const opts = { mode: (managed && managed.mode) || 'client', deeplink: (managed && managed.deeplink) || '' };
    const name = (managed && managed.profileName) || 'Restarted';

    await processes.kill(pid, true);
    monitor.forget(pid);
    await delay(700);
    const launch = launchIsolated(loc, opts, name);
    // history already recorded as 'launched' by launchIsolated; note the restart too
    logger.info('Restarted instance ' + pid + ' -> ' + (launch.pid || 'failed'));
    monitor.poll();
    return Object.assign({ ok: launch.ok }, launch);
  });

  safe('instances:killAll', async () => {
    const r = await processes.killAllPlayers();
    logger.warn('Ended all Roblox clients', r.output);
    monitor.poll();
    return r;
  });

  safe('instances:cleanup', async () => {
    const r = await processes.cleanupAll();
    logger.warn('Process cleanup performed', r);
    monitor.poll();
    return Object.assign({ ok: r.ok }, r);
  });

  // Tile every running Roblox window into an even grid (multi-boxing).
  safe('instances:arrange', () => {
    const pids = (monitor.snapshot() || []).map(i => i.pid);
    const r = native.tileWindows(pids);
    logger.info('Arrange windows', r);
    return Object.assign({ ok: r.ok }, r);
  });

  /* ----------------------------- History ----------------------------- */

  safe('history:get', () => ({ ok: true, history: store.getHistory() }));
  safe('playtime:stats', () => playtime.stats());
  safe('playtime:clear', () => playtime.clear());
  safe('history:clear', () => ({ ok: true, history: store.clearHistory() }));

  /* ----------------------------- Settings ----------------------------- */

  safe('settings:get', () => ({ ok: true, settings: store.getSettings() }));

  safe('settings:save', (p) => {
    const before = store.getSettings();
    const settings = store.saveSettings(p.partial || {});
    if (settings.pollIntervalMs !== before.pollIntervalMs) monitor.setInterval(settings.pollIntervalMs);
    logger.info('Settings saved');
    return { ok: true, settings };
  });

  safe('settings:reset', () => {
    const settings = store.resetSettings();
    monitor.setInterval(settings.pollIntervalMs);
    logger.info('Settings reset to defaults');
    return { ok: true, settings };
  });

  safe('settings:browse', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Select RobloxPlayerBeta.exe',
      properties: ['openFile'],
      filters: [{ name: 'Roblox Player', extensions: ['exe'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const picked = r.filePaths[0];
    const valid = roblox.validatePath(picked);
    return { ok: true, path: picked, valid };
  });

  /* ----------------------------- Logs / Diagnostics ----------------------------- */

  safe('logs:get', (p) => ({ ok: true, entries: logger.recent(asInt(p.limit) || 300) }));
  safe('logs:clear', () => { logger.clear(); return { ok: true }; });
  safe('logs:openFolder', async () => {
    const dir = logger.getLogDir();
    if (!dir) return { ok: false, error: 'No log folder.' };
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  safe('diag:get', () => {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    return {
      ok: true,
      diagnostics: {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        osType: os.type(),
        osRelease: os.release(),
        osHost: os.hostname(),
        totalMemGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
        cpu: (os.cpus()[0] || {}).model || 'unknown',
        userData: app.getPath('userData'),
        logFile: logger.getLogFile(),
        ffiAvailable: native.isAvailable(),
        ffiError: native.getLoadError(),
        multiInstance: native.isAvailable() ? 'enabled (path-isolation + guard)' : 'unavailable',
        guard: JSON.stringify(guard.stats()),
        singletonNames: native.EVENT_NAME + ', ' + native.MUTEX_NAME + ', <path>.mtx',
        typeIndices: JSON.stringify(native.getTypeIndices()),
        robloxFound: loc.found,
        robloxPath: loc.playerPath,
        robloxVersion: loc.version,
        robloxSource: loc.source,
        candidates: loc.candidates,
      },
    };
  });

  safe('app:openExternal', async (p) => {
    const url = String(p.url || '');
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'Only https links are allowed.' };
    await shell.openExternal(url);
    return { ok: true };
  });

  safe('app:openUserData', async () => {
    await shell.openPath(app.getPath('userData'));
    return { ok: true };
  });

  logger.info('IPC handlers registered');
}

module.exports = { register };
