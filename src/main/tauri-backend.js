'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
const playtime = require('./playtime');
const { ProcessMonitor } = require('./monitor');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
function asInt(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }

function makeBackend(ctx) {
  const { appVersion, userData, emit, openPath, openExternal, pickFile, safeStorage } = ctx;

  logger.configure(userData);
  store.configure(userData, logger);
  try { native.init(); } catch (err) { logger.warn('Native initialization failed', err && err.message); }
  clones.configure(path.join(userData, 'clones'), logger);
  accounts.configure({
    baseDir: userData,
    safeStorage,
    logger,
  });
  playtime.configure({ store, logger });
  games.configure({ logger });
  people.configure({ logger });

  const settings = store.getSettings();
  const loc = roblox.locate(settings);
  guard.configure({
    logger,
    playerPath: loc.playerPath,
    getPids: () => (monitor ? monitor.snapshot().map(i => i.pid) : []),
  });
  if (native.isAvailable()) guard.start();

  let monitor = new ProcessMonitor({ intervalMs: settings.pollIntervalMs, logger });
  monitor.on('update', (payload) => emit('instances:update', payload));
  monitor.start();
  logger.onEntry((entry) => emit('log:entry', entry));
  accounts.startPolling({
    intervalMs: 12000,
    onUpdate: (acc) => emit('account:update', acc),
    onExpired: (acc) => emit('account:expired', acc),
    onObserve: (userId, username, status, game) => playtime.observe(userId, username, status, game),
  });

  function buildStatus() {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    return {
      ok: true,
      appVersion,
      robloxFound: loc.found,
      playerPath: loc.playerPath,
      version: loc.version,
      source: loc.source,
      candidates: loc.candidates,
      multiInstance: native.isAvailable(),
      ffiAvailable: native.isAvailable(),
      ffiError: native.getLoadError(),
      guard: guard.stats(),
      settings,
    };
  }

  function launchIsolated(loc, opts, profileName) {
    let exe = loc.playerPath;
    let slot = null;
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
    return { ok: launched > 0, launched, failed, multiInstance: native.isAvailable(), results };
  }

  const updateState = {
    state: 'idle',
    currentVersion: appVersion,
    latestVersion: null,
    url: null,
    path: null,
    sha512: null,
    size: null,
    downloadedPath: null,
    error: null,
    checkedAt: null,
  };

  function parseVersion(v) {
    return String(v || '').split('.').map(n => parseInt(n, 10) || 0).slice(0, 3);
  }

  function newerThan(a, b) {
    const av = parseVersion(a), bv = parseVersion(b);
    for (let i = 0; i < 3; i++) {
      if ((av[i] || 0) > (bv[i] || 0)) return true;
      if ((av[i] || 0) < (bv[i] || 0)) return false;
    }
    return false;
  }

  function readLatestYml(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+):\s*['\"]?(.+?)['\"]?\s*$/);
      if (m) out[m[1]] = m[2];
    }
    const fileUrl = (String(text || '').match(/url:\s*['\"]?(.+?)['\"]?\s*$/m) || [])[1];
    if (fileUrl) out.url = fileUrl;
    const fileSize = (String(text || '').match(/size:\s*(\d+)/m) || [])[1];
    if (fileSize) out.size = Number(fileSize);
    return out;
  }

  function emitUpdate() {
    emit('updater:status', Object.assign({ ok: true }, updateState));
  }

  async function downloadUpdate(latest) {
    const asset = latest.url || latest.path || 'FleetInstaller.exe';
    const url = /^https?:\/\//i.test(asset)
      ? asset
      : `https://github.com/Toluwer/Fleet/releases/latest/download/${asset}`;
    const target = path.join(userData, 'updates', 'FleetInstaller.exe');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = await fetch(url, { headers: { 'User-Agent': 'Fleet-Updater' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (latest.size && buf.length !== Number(latest.size)) throw new Error('Downloaded installer size did not match latest.yml.');
    // Verify the signed digest published in latest.yml BEFORE writing anything
    // to disk or executing it — a mismatched download is never run.
    const expected = normalizeDigest(latest.sha512);
    if (expected) {
      const actual = crypto.createHash('sha512').update(buf).digest('base64');
      if (normalizeDigest(actual) !== expected) {
        throw new Error('Downloaded installer failed checksum verification and was discarded.');
      }
    } else {
      throw new Error('Update feed did not publish a checksum for the installer, so it cannot be verified.');
    }
    fs.writeFileSync(target, buf);
    return target;
  }

  /** Accept base64, base64url or hex digests from latest.yml. */
  function normalizeDigest(value) {
    const raw = String(value || '').trim().replace(/\s+/g, '');
    if (!raw) return '';
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) && !/^[0-9a-fA-F]{128}$/.test(raw)) {
      // base64 / base64url form
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const bin = Buffer.from(b64, 'base64');
      return bin.length === 64 ? bin.toString('hex') : raw;
    }
    if (/^[0-9a-fA-F]{128}$/.test(raw)) return raw.toLowerCase();
    return raw;
  }

  async function checkForUpdate() {
    updateState.state = 'checking';
    updateState.error = null;
    emitUpdate();
    const res = await fetch('https://github.com/Toluwer/Fleet/releases/latest/download/latest.yml', { headers: { 'User-Agent': 'Fleet-Updater' } });
    if (!res.ok) throw new Error('Update feed unavailable (HTTP ' + res.status + ').');
    const latest = readLatestYml(await res.text());
    updateState.checkedAt = new Date().toISOString();
    updateState.latestVersion = latest.version || null;
    updateState.url = latest.url || latest.path || 'FleetInstaller.exe';
    updateState.path = latest.path || 'FleetInstaller.exe';
    updateState.sha512 = latest.sha512 || null;
    updateState.size = latest.size || null;
    if (!updateState.latestVersion || !newerThan(updateState.latestVersion, appVersion)) {
      updateState.state = 'current';
      updateState.downloadedPath = null;
      emitUpdate();
      return Object.assign({ ok: true }, updateState);
    }
    updateState.state = 'available';
    emitUpdate();
    return Object.assign({ ok: true }, updateState);
  }

  const handlers = {
    async app_status() { return buildStatus(); },
    async updater_status() { return Object.assign({ ok: true }, updateState); },
    async updater_check() {
      try { return await checkForUpdate(); }
      catch (err) { updateState.state = 'error'; updateState.error = (err && err.message) || String(err); emitUpdate(); return Object.assign({ ok: false }, updateState); }
    },
    async updater_install() {
      try {
        if (updateState.state !== 'available' && updateState.state !== 'downloaded') await checkForUpdate();
        if (updateState.state === 'current') return Object.assign({ ok: false, error: 'Fleet is already up to date.' }, updateState);
        updateState.state = 'downloading'; updateState.error = null; emitUpdate();
        updateState.downloadedPath = await downloadUpdate(updateState);
        updateState.state = 'installing'; emitUpdate();
        const child = spawn(updateState.downloadedPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return Object.assign({ ok: true }, updateState);
      } catch (err) {
        updateState.state = 'error'; updateState.error = (err && err.message) || String(err); emitUpdate(); return Object.assign({ ok: false }, updateState);
      }
    },
    async roblox_detect() {
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      if (loc.found) guard.setPlayerPath(loc.playerPath);
      logger.info('Roblox detection: ' + (loc.found ? (loc.source + ' -> ' + loc.playerPath) : 'NOT FOUND'));
      return Object.assign({ ok: true }, loc);
    },
    async launch_quick(payload) { return doLaunch({ mode: 'client', count: payload.count, profileName: 'Quick launch' }); },
    async launch_accounts(payload) { return doLaunch({ accountIds: payload.accountIds, placeId: payload.placeId }); },
    async launch_join(payload) { return doLaunch({ accountIds: payload.accountIds, placeId: payload.placeId, gameInstanceId: payload.gameId || null }); },
    async launch_join_person(payload) {
      const accountId = String(payload.accountId || '');
      const targetUserId = asInt(payload.targetUserId);
      if (!accountId || !targetUserId) return { ok: false, error: 'Choose an account and player first.' };
      return doLaunch({ accountIds: [accountId], targetUserId });
    },
    async launch_join_person_multi(payload) {
      const targetUserId = asInt(payload.targetUserId);
      const accountIds = Array.from(new Set((Array.isArray(payload.accountIds) ? payload.accountIds : []).map(id => String(id || '')).filter(Boolean))).slice(0, 20);
      if (!targetUserId || !accountIds.length) return { ok: false, error: 'Choose at least one account and a player.' };
      return doLaunch({ accountIds, targetUserId });
    },
    async people_list(payload) { return people.listFriends(asInt(payload.page) || 0, asInt(payload.pageSize) || 9, !!payload.force); },
    async people_search(payload) { return people.search(payload.query, payload.cursor); },
    async people_profile(payload) { return people.profile(payload.userId); },
    async people_presence(payload) { return people.presence(payload.userIds); },
    async accounts_list() { return { ok: true, accounts: accounts.list() }; },
    async accounts_add(payload) { return accounts.add(payload || {}); },
    async accounts_add_cookie(payload) { return accounts.addFromCookie(String((payload && payload.cookie) || '')); },
    async accounts_remove(payload) { return accounts.remove(payload.id); },
    async accounts_refresh(payload) { return accounts.refresh(payload.id, payload.full); },
    async accounts_follow(payload) {
      const targetAccountId = String(payload.targetAccountId || '');
      const followerAccountIds = Array.from(new Set((Array.isArray(payload.followerAccountIds) ? payload.followerAccountIds : []).map(id => String(id || '')).filter(id => id && id !== targetAccountId))).slice(0, 20);
      if (!targetAccountId) return { ok: false, error: 'Choose an account to follow.' };
      if (!followerAccountIds.length) return { ok: false, error: 'Choose at least one other account to follow with.' };
      const context = await accounts.getFollowContext(targetAccountId);
      if (!context.ok) return { ok: false, error: context.reason };
      const result = await doLaunch({ accountIds: followerAccountIds, placeId: context.placeId, gameInstanceId: context.gameInstanceId });
      return Object.assign({}, result, { targetUsername: context.username, targetDisplayName: context.displayName, placeId: context.placeId });
    },
    async games_browse() { return games.browse(); },
    async games_search(payload) { return games.search(payload.query, payload.pageToken); },
    async games_servers(payload) { return games.servers(payload.placeId, payload.cursor); },
    async games_server_scan(payload) { return games.scanServers(payload.placeId, payload.pageLimit); },
    async instances_get() { return { ok: true, instances: monitor.snapshot(), summary: null }; },
    async instance_focus(payload) {
      const pid = asInt(payload.pid); if (!pid) return { ok: false, error: 'Invalid PID.' };
      const r = native.focusByPid(pid); return Object.assign({ ok: r.ok }, r);
    },
    async instance_kill(payload) {
      const pid = asInt(payload.pid); if (!pid) return { ok: false, error: 'Invalid PID.' };
      const r = await processes.kill(pid, true); monitor.forget(pid); monitor.poll(); return r;
    },
    async instance_restart(payload) {
      const pid = asInt(payload.pid); if (!pid) return { ok: false, error: 'Invalid PID.' };
      const managed = monitor.getManaged(pid);
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      if (!loc.found) return { ok: false, error: 'Roblox player not found for restart.' };
      guard.setPlayerPath(loc.playerPath); guard.start();
      const opts = { mode: (managed && managed.mode) || 'client', deeplink: (managed && managed.deeplink) || '' };
      const name = (managed && managed.profileName) || 'Restarted';
      await processes.kill(pid, true); monitor.forget(pid); await delay(700);
      const launch = launchIsolated(loc, opts, name); monitor.poll(); return Object.assign({ ok: launch.ok }, launch);
    },
    async instances_kill_all() { const r = await processes.killAllPlayers(); monitor.poll(); return r; },
    async instances_cleanup() { const r = await processes.cleanupAll(); monitor.poll(); return Object.assign({ ok: r.ok }, r); },
    async instances_arrange() {
      const pids = (monitor.snapshot() || []).map(i => i.pid);
      const r = native.tileWindows(pids); return Object.assign({ ok: r.ok }, r);
    },
    async history_get() { return { ok: true, history: store.getHistory() }; },
    async playtime_stats() { return playtime.stats(); },
    async playtime_clear() { return playtime.clear(); },
    async history_clear() { return { ok: true, history: store.clearHistory() }; },
    async settings_get() { return { ok: true, settings: store.getSettings() }; },
    async settings_save(payload) {
      const before = store.getSettings();
      const partial = Object.assign({}, payload.partial || {});
      if (typeof partial.robloxPath === 'string' && partial.robloxPath.trim()) {
        const pathStatus = roblox.pathStatus(partial.robloxPath);
        if (pathStatus.normalized) partial.robloxPath = pathStatus.normalized;
      }
      const settings = store.saveSettings(partial);
      if (settings.pollIntervalMs !== before.pollIntervalMs) monitor.setPollInterval(settings.pollIntervalMs);
      return { ok: true, settings };
    },
    async settings_reset() {
      const settings = store.resetSettings(); monitor.setPollInterval(settings.pollIntervalMs); return { ok: true, settings };
    },
    async settings_browse() {
      const picked = await pickFile();
      if (!picked) return { ok: false, canceled: true };
      const pathStatus = roblox.pathStatus(picked);
      return { ok: true, path: pathStatus.normalized || picked, valid: pathStatus.ok, reason: pathStatus.reason };
    },
    async logs_get(payload) { return { ok: true, entries: logger.recent(asInt(payload.limit) || 300) }; },
    async logs_clear() { logger.clear(); return { ok: true }; },
    async logs_open_folder() {
      const dir = logger.getLogDir(); if (!dir) return { ok: false, error: 'No log folder.' };
      await openPath(dir); return { ok: true, dir };
    },
    async diag_get() {
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      return {
        ok: true,
        diagnostics: {
          appVersion,
          shell: 'tauri',
          chrome: null,
          node: process.versions.node,
          v8: process.versions.v8,
          platform: process.platform,
          arch: process.arch,
          osType: os.type(),
          osRelease: os.release(),
          osHost: os.hostname(),
          totalMemGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
          cpu: (os.cpus()[0] || {}).model || 'unknown',
          userData,
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
    },
    async app_open_external(payload) {
      const url = String(payload.url || '');
      if (!/^https:\/\//i.test(url)) return { ok: false, error: 'Only https links are allowed.' };
      await openExternal(url); return { ok: true };
    },
    async app_open_user_data() { await openPath(userData); return { ok: true }; },
  };

  async function invoke(name, payload) {
    const fn = handlers[name];
    if (!fn) return { ok: false, error: 'Unknown command: ' + name };
    try {
      return await fn(payload || {});
    } catch (err) {
      logger.error('Tauri backend ' + name + ' failed', err && err.message);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  async function shutdown() {
    try { if (monitor) monitor.stop(); } catch (_) {}
    try { accounts.stopPolling(); } catch (_) {}
    try { playtime.flush(); } catch (_) {}
    try { guard.stop(); } catch (_) {}
    try { clones.cleanup(); } catch (_) {}
  }

  return { invoke, shutdown };
}

module.exports = { makeBackend };
