'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const downloader = require('./download');
const selfupdate = require('./selfupdate');

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
const signup = require('./signup');
const games = require('./games');
const playtime = require('./playtime');
const { InstanceKeeper } = require('./keeper');
const { ProcessMonitor } = require('./monitor');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
function asInt(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }

function makeBackend(ctx) {
  const { appVersion, userData, emit, openPath, openExternal, pickFile, safeStorage } = ctx;

  logger.configure(userData);
  store.configure(userData, logger);

  // The self-update applier writes a result file before relaunching us;
  // read it once (then delete it) so the UI can say what happened instead
  // of the update failing silently after the window closed.
  const updateResultPath = path.join(userData, 'update-result.json');
  let lastUpdateResult = null;
  try {
    lastUpdateResult = selfupdate.readResultFile(updateResultPath);
  } catch (err) {
    logger.warn('Could not read the update result file', err && err.message);
  }
  if (lastUpdateResult) {
    logger.info(`Update result: ${lastUpdateResult.ok ? 'ok' : 'FAILED'}${lastUpdateResult.to ? ' -> v' + lastUpdateResult.to : ''}${lastUpdateResult.error ? ' (' + lastUpdateResult.error + ')' : ''}`);
  }

  try { native.init(); } catch (err) { logger.warn('Native initialization failed', err && err.message); }
  clones.configure(path.join(userData, 'clones'), logger);
  accounts.configure({
    baseDir: userData,
    safeStorage,
    logger,
  });
  playtime.configure({ store, logger });
  signup.configure({ logger });
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
  monitor.on('update', (payload) => { emit('instances:update', payload); keeper.onInstances(payload.instances); });
  monitor.start();

  // Watchdog: armed accounts get a client relaunched into their game when it
  // dies (crash, kick, disconnect). Fresh ticket every rejoin, backoff, and
  // manual kills always win. See keeper.js.
  const keeper = new InstanceKeeper({
    logger,
    store,
    settingsProvider: () => store.getSettings(),
    killInstance: async (pid) => {
      const r = await processes.kill(pid, true);
      monitor.forget(pid);
      return r;
    },
    launchAccount: async (accountId, placeId, gameInstanceId) => {
      const li = await accounts.getLaunchInfo(accountId, (placeId || '').toString() || null, gameInstanceId || null);
      if (!li.ok) return { ok: false, reason: li.reason || 'Could not mint a launch ticket.' };
      const loc = roblox.locate(store.getSettings());
      if (!loc.found) return { ok: false, reason: 'Roblox player not found.' };
      guard.setPlayerPath(loc.playerPath); guard.start();
      const r = launchIsolated(loc, { mode: 'deeplink', deeplink: li.deeplink }, li.username, accountId);
      monitor.poll();
      return r.ok ? { ok: true, pid: r.pid } : { ok: false, reason: r.reason || 'Launch failed.' };
    },
    launchFollow: async (accountId, targetUserId) => {
      const li = await accounts.getPersonJoinLaunchInfo(accountId, targetUserId);
      if (!li.ok) return { ok: false, reason: li.reason || 'Could not mint a launch ticket.' };
      const loc = roblox.locate(store.getSettings());
      if (!loc.found) return { ok: false, reason: 'Roblox player not found.' };
      guard.setPlayerPath(loc.playerPath); guard.start();
      const r = launchIsolated(loc, { mode: 'deeplink', deeplink: li.deeplink }, li.username, accountId);
      monitor.poll();
      return r.ok ? { ok: true, pid: r.pid } : { ok: false, reason: r.reason || 'Launch failed.' };
    },
  });
  keeper.on('change', (status) => emit('keeper:status', status));
  keeper.on('rejoin', (record) => emit('keeper:rejoin', {
    accountId: record.accountId, username: record.username, name: record.name,
    attempts: record.attempts, delayMs: record.delayMs || 0, reason: record.lastReason || '',
  }));
  keeper.on('gaveup', (record) => emit('keeper:gaveup', {
    accountId: record.accountId, username: record.username, name: record.name,
    attempts: record.attempts, reason: record.lastReason || '',
  }));
  keeper.restore();

  logger.onEntry((entry) => emit('log:entry', entry));
  accounts.startPolling({
    intervalMs: 12000,
    onUpdate: (acc) => emit('account:update', acc),
    onExpired: (acc) => emit('account:expired', acc),
    onObserve: (userId, username, status, game) => { playtime.observe(userId, username, status, game); keeper.onPresence(userId, status); },
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
      watchdog: keeper.status().summary,
      lastUpdateResult: lastUpdateResult || null,
      settings,
    };
  }

  function launchIsolated(loc, opts, profileName, accountId) {
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
      monitor.markManaged(r.pid, { profileName, mode: opts.mode, deeplink: opts.deeplink, playerPath: loc.playerPath, exePath: exe, accountId: accountId || '' });
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
          results.push(launchIsolated(loc, { mode: 'deeplink', deeplink: li.deeplink }, li.username, accountIds[i]));
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

  /** Turn account ids into watchdog records the keeper can arm. */
  function armRecords(rows) {
    const known = new Map(accounts.list().map(a => [a.id, a]));
    const list = [];
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, 20)) {
      const accountId = String((row && row.accountId) || '').trim();
      const acc = known.get(accountId);
      if (accountId && acc) {
        list.push({
          accountId,
          userId: acc.userId,
          username: acc.username,
          placeId: String((row && row.placeId) || ''),
          gameInstanceId: String((row && row.gameInstanceId) || ''),
          targetUserId: Number(row && row.targetUserId) || null,
          name: String((row && row.name) || ''),
        });
      }
    }
    if (!list.length) return { ok: false, error: 'No matching accounts to watch.' };
    return keeper.armMany(list);
  }

  /** Fill the emptiest servers with the given accounts.
   *
   * Scans the place's server list, then packs accounts in: "same server"
   * keeps the whole crew together when one server fits them all, "spread"
   * fills the emptiest server first and spills into the next. Each account
   * gets its own freshly minted ticket into its assigned server, spaced like
   * any other multi-launch. Optionally arms the watchdog per account so the
   * whole setup self-heals. */
  async function autoFill({ accountIds, placeId, spread, keepAlive, name }) {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    if (!loc.found) {
      return { ok: false, error: 'Roblox is not installed or could not be found. Open Settings to set the path manually.' };
    }
    const scan = await games.scanServers(placeId, 8);
    if (!scan.ok) return { ok: false, error: scan.error || 'Server scan failed.' };

    const freeSlots = s => Math.max(0, Number(s.maxPlayers) - Number(s.playing));
    const servers = (scan.servers || []).slice().sort((a, b) =>
      freeSlots(b) - freeSlots(a) || (a.ping == null ? 999999 : a.ping) - (b.ping == null ? 999999 : b.ping));
    if (!servers.length) return { ok: false, error: 'No joinable servers found right now.' };

    const assignment = [];
    if (!spread) {
      const together = servers.find(s => freeSlots(s) >= accountIds.length);
      if (together) for (const id of accountIds) assignment.push({ accountId: id, serverId: together.id });
    }
    if (!assignment.length) {
      let i = 0;
      for (const s of servers) {
        const take = Math.min(freeSlots(s), accountIds.length - i);
        for (let k = 0; k < take; k++) assignment.push({ accountId: accountIds[i + k], serverId: s.id });
        i += take;
        if (i >= accountIds.length) break;
      }
      for (; assignment.length < accountIds.length; ) {
        assignment.push({ accountId: accountIds[assignment.length], serverId: null, reason: 'every scanned server is full' });
      }
    }

    const byAccount = new Map(accounts.list().map(a => [a.id, a]));
    const results = [];
    for (let idx = 0; idx < assignment.length; idx++) {
      const a = assignment[idx];
      const acc = byAccount.get(a.accountId);
      if (!a.serverId) {
        results.push({ accountId: a.accountId, username: acc ? acc.username : '', ok: false, reason: a.reason });
        continue;
      }
      const li = await accounts.getLaunchInfo(a.accountId, placeId, a.serverId);
      if (!li.ok) {
        results.push({ accountId: a.accountId, username: acc ? acc.username : '', serverId: a.serverId, ok: false, reason: li.reason });
        store.addHistory({ profileName: acc ? acc.username : 'Auto-fill', mode: 'account', result: 'failed', message: li.reason });
      } else {
        const r = launchIsolated(loc, { mode: 'deeplink', deeplink: li.deeplink }, li.username, a.accountId);
        results.push({ accountId: a.accountId, username: li.username, serverId: a.serverId, ok: r.ok, pid: r.pid, reason: r.reason });
      }
      monitor.poll();
      if (idx < assignment.length - 1) await delay(settings.launchDelayMs);
    }

    const launched = results.filter(r => r.ok);
    const usedServers = new Set(launched.map(r => r.serverId));
    logger.info(`Auto-fill: ${launched.length} of ${results.length} launched into ${usedServers.size} server(s)`);
    if (keepAlive && launched.length) {
      armRecords(launched.map(r => ({ accountId: r.accountId, placeId, gameInstanceId: r.serverId, name: name || 'the game' })));
    }
    return {
      ok: launched.length > 0,
      launched: launched.length,
      failed: results.length - launched.length,
      servers: usedServers.size,
      scan: scan.scan || null,
      results,
    };
  }

  const updateState = {
    state: 'idle',
    currentVersion: appVersion,
    latestVersion: null,
    url: null,
    path: null,
    sha512: null,
    size: null,
    portableUrl: null,
    portableSha512: null,
    portableSize: null,
    downloadedPath: null,
    error: null,
    checkedAt: null,
    received: null,
    total: null,
    percent: null,
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

  const FEED_URL = 'https://github.com/Toluwer/Fleet/releases/latest/download/latest.yml';

  async function fetchFeed() {
    try {
      const res = await downloader.getToBuffer(FEED_URL, { retries: 2 });
      return res.body.toString('utf8');
    } catch (httpsErr) {
      // Some networks behave differently per stack; the small file also works
      // through the platform fetch, so try it before giving up.
      const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'Fleet-Updater' } });
      if (!res.ok) {
        throw new Error(`Update feed unavailable (HTTP ${res.status}) — caused by: ${downloader.describeError(httpsErr)}`);
      }
      return res.text();
    }
  }

  /** Stream-hash a file without loading it into memory. */
  function hashFile(file, algo) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algo || 'sha512');
      const stream = fs.createReadStream(file);
      stream.on('data', (c) => hash.update(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('base64')));
    });
  }

  /** Downloads the update package to `updatesDir`, verifying the digest the
   * feed signed BEFORE anything is extracted or run. A mismatched download is
   * retried once from scratch, then reported as a real error. */
  async function downloadUpdatePackage(url, target, expectedSize, expectedSha512) {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const part = target + '.part';

    updateState.received = null;
    updateState.total = null;
    updateState.percent = null;
    let lastEmit = 0;
    const onProgress = (p) => {
      updateState.received = p.received;
      updateState.total = p.total;
      updateState.percent = p.percent;
      const now = Date.now();
      if (now - lastEmit >= 300 || p.percent === 100) { lastEmit = now; emitUpdate(); }
    };

    // Resilient download: streams to disk, resumes interrupted partials via
    // Range, retries transient failures, honors HTTPS_PROXY, and cannot be
    // killed by a whole-body timeout the way the old fetch path was.
    try {
      await downloader.downloadToFile(url, part, { onProgress });
    } catch (err) {
      updateState.received = null;
      updateState.total = null;
      updateState.percent = null;
      throw new Error(`${err && err.message ? err.message : String(err)}. The download can also be finished in your browser from the releases page.`);
    }

    // A corrupt partial can resume "successfully" (sizes add up) and only
    // fail verification, so a failed check retries once from scratch.
    let verified = false;
    for (let verifyAttempt = 0; verifyAttempt < 2 && !verified; verifyAttempt++) {
      try {
        if (verifyAttempt > 0) {
          try { fs.unlinkSync(part); } catch (_) { /* already gone */ }
          await downloader.downloadToFile(url, part, { onProgress });
        }
        const size = fs.statSync(part).size;
        if (expectedSize && size !== Number(expectedSize)) {
          throw new Error(`Downloaded update size did not match the release feed (${size} vs ${expectedSize} bytes).`);
        }
        const expected = normalizeDigest(expectedSha512);
        if (!expected) throw new Error('The update feed did not publish a checksum, so the download cannot be verified.');
        const actual = await hashFile(part);
        if (normalizeDigest(actual) !== expected) {
          throw new Error('Downloaded update failed checksum verification and was discarded.');
        }
        verified = true;
        fs.renameSync(part, target);
      } catch (err) {
        if (verifyAttempt > 0) {
          try { fs.unlinkSync(part); } catch (_) { /* already gone */ }
          throw err;
        }
        logger.warn('Update verification failed, retrying from scratch:', err && err.message);
      }
    }
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
    updateState.received = null;
    updateState.total = null;
    updateState.percent = null;
    emitUpdate();
    const latest = readLatestYml(await fetchFeed());
    updateState.checkedAt = new Date().toISOString();
    updateState.latestVersion = latest.version || null;
    updateState.url = latest.url || latest.path || 'FleetInstaller.exe';
    updateState.path = latest.path || 'FleetInstaller.exe';
    updateState.sha512 = latest.sha512 || null;
    updateState.size = latest.size || null;
    updateState.portableUrl = latest.portableUrl || latest.portablePath || null;
    updateState.portableSha512 = latest.portableSha512 || null;
    updateState.portableSize = latest.portableSize || null;
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

  /** Runs the whole update flow and reports every step via updater:status.
   *  The update is applied entirely in place: download the portable package,
   *  verify its digest, unpack it, and swap it over the install folder WHILE
   *  FLEET IS STILL OPEN (locked files are renamed aside, like VS Code does
   *  it). Only after the files on disk are verifiably the new version does
   *  the state move to 'restarting' — the renderer then triggers the
   *  updater_restart command, which launches the new Fleet.exe and closes
   *  this one. No helper process exists between "armed" and "applied", so
   *  security software can no longer orphan the update, and a failure at
   *  any step is an error the still-alive UI can show. */
  async function installUpdate() {
    try {
      if (updateState.state !== 'available' && updateState.state !== 'restarting') {
        await checkForUpdate();
        if (updateState.state !== 'available') return; // current / nothing to do
      }
      if (!updateState.portableUrl || !updateState.portableSha512) {
        throw new Error('This release does not publish a package the built-in updater can install. Use "Download in browser" from the releases page instead.');
      }

      const asset = updateState.portableUrl;
      const url = /^https?:\/\//i.test(asset)
        ? asset
        : `https://github.com/Toluwer/Fleet/releases/latest/download/${asset}`;
      const updatesDir = path.join(userData, 'updates');
      // Sweep any leftovers from an earlier run. The retired "*.fleet-old"
      // files from the swap live in the INSTALL folder and are swept by the
      // new version at startup; this only clears the download stage.
      try { fs.rmSync(updatesDir, { recursive: true, force: true }); } catch (_) { /* nothing to sweep */ }
      const zipPath = path.join(updatesDir, 'FleetUpdate.zip');

      updateState.state = 'downloading';
      updateState.error = null;
      emitUpdate();
      await downloadUpdatePackage(url, zipPath, updateState.portableSize, updateState.portableSha512);
      updateState.downloadedPath = zipPath;

      updateState.state = 'staging';
      updateState.received = null;
      updateState.total = null;
      updateState.percent = null;
      emitUpdate();

      const stageDir = path.join(updatesDir, 'staged');
      const staged = selfupdate.stageZip(zipPath, stageDir);
      if (!staged.ok) throw new Error(staged.error);

      const install = selfupdate.resolveInstallDir(process.execPath);
      if (!install.ok) throw new Error(install.error);

      // The in-place swap: copies every new file over the install folder
      // while Fleet keeps running; in-use files are renamed aside and
      // cleaned up by the next start.
      updateState.state = 'applying';
      emitUpdate();
      const applied = selfupdate.applyUpdate({
        installDir: install.dir,
        stageDir,
        resultPath: updateResultPath,
        version: updateState.latestVersion,
      });
      if (!applied.ok) throw new Error(applied.error);
      logger.info(`Update applied in place: v${updateState.latestVersion} now on disk in ${install.dir} (${applied.copied} files, ${applied.retired.length} swapped while running)`);

      // The files on disk are the new version; the restart (renderer calls
      // updater_restart -> new Fleet.exe --takeover=<pid> + window close)
      // just switches which binary is running.
      updateState.state = 'restarting';
      emitUpdate();
    } catch (err) {
      updateState.state = 'error';
      updateState.error = (err && err.message) || String(err);
      updateState.received = null;
      updateState.total = null;
      updateState.percent = null;
      emitUpdate();
    }
  }

  const handlers = {
    async app_status() { return buildStatus(); },
    async updater_status() { return Object.assign({ ok: true }, updateState); },
    async updater_check() {
      try { return await checkForUpdate(); }
      catch (err) { updateState.state = 'error'; updateState.error = (err && err.message) || String(err); emitUpdate(); return Object.assign({ ok: false }, updateState); }
    },
    async updater_install() {
      if (updateState.state === 'downloading' || updateState.state === 'staging' || updateState.state === 'applying' || updateState.state === 'restarting') {
        return Object.assign({ ok: false, error: 'An update is already in progress.' }, updateState);
      }
      // Fire and forget: the download can take minutes, so the IPC call must
      // not hold the renderer's API timeout hostage. Progress and completion
      // arrive through updater:status events instead.
      installUpdate();
      return Object.assign({ ok: true }, updateState);
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
    async launch_auto_fill(payload) {
      const accountIds = Array.from(new Set((Array.isArray(payload.accountIds) ? payload.accountIds : []).map(id => String(id || '')).filter(Boolean))).slice(0, 20);
      const placeId = String(payload.placeId || '').trim();
      if (!accountIds.length) return { ok: false, error: 'Choose at least one account.' };
      if (!/^\d+$/.test(placeId)) return { ok: false, error: 'A valid place id is required.' };
      return autoFill({
        accountIds,
        placeId,
        spread: payload.spread !== false,
        keepAlive: !!payload.keepAlive,
        name: String(payload.name || 'the game').slice(0, 80),
      });
    },
    async keeper_arm(payload) { return armRecords(payload.records); },
    async keeper_disarm(payload) {
      const r = keeper.disarm(payload.accountId, 'stopped by user');
      return r.ok ? { ok: true } : { ok: false, error: 'That account is not being watched.' };
    },
    async keeper_disarm_all() { return keeper.disarmAll('stopped by user'); },
    async keeper_status() { return keeper.status(); },
    async people_list(payload) { return people.listFriends(asInt(payload.page) || 0, asInt(payload.pageSize) || 9, !!payload.force); },
    async people_search(payload) { return people.search(payload.query, payload.cursor); },
    async people_profile(payload) { return people.profile(payload.userId); },
    async people_presence(payload) { return people.presence(payload.userIds); },
    async accounts_list() { return { ok: true, accounts: accounts.list() }; },
    async accounts_add(payload) { return accounts.add(payload || {}); },
    async accounts_add_cookie(payload) { return accounts.addFromCookie(String((payload && payload.cookie) || '')); },
    async signup_check_username(payload) {
      return signup.checkUsername(String((payload && payload.username) || ''), String((payload && payload.birthday) || ''));
    },
    async signup_suggest_usernames(payload) {
      return signup.suggestUsernames(String((payload && payload.username) || ''), String((payload && payload.birthday) || ''));
    },
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
      keeper.onManualKill(pid);   // a client the user ends must stay ended
      const r = await processes.kill(pid, true); monitor.forget(pid); monitor.poll(); return r;
    },
    async instance_restart(payload) {
      const pid = asInt(payload.pid); if (!pid) return { ok: false, error: 'Invalid PID.' };
      const managed = monitor.getManaged(pid);
      keeper.onManualRestart(pid);   // the restart path relaunches on its own
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      if (!loc.found) return { ok: false, error: 'Roblox player not found for restart.' };
      guard.setPlayerPath(loc.playerPath); guard.start();
      const opts = { mode: (managed && managed.mode) || 'client', deeplink: (managed && managed.deeplink) || '' };
      const name = (managed && managed.profileName) || 'Restarted';
      const accountId = (managed && managed.accountId) || '';
      await processes.kill(pid, true); monitor.forget(pid); await delay(700);
      const launch = launchIsolated(loc, opts, name, accountId); monitor.poll(); return Object.assign({ ok: launch.ok }, launch);
    },
    async instances_kill_all() { keeper.onManualKillAll(); const r = await processes.killAllPlayers(); monitor.poll(); return r; },
    async instances_cleanup() { keeper.onManualKillAll(); const r = await processes.cleanupAll(); monitor.poll(); return Object.assign({ ok: r.ok }, r); },
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
    try { keeper.stop(); } catch (_) {}
    try { clones.cleanup(); } catch (_) {}
  }

  return { invoke, shutdown };
}

module.exports = { makeBackend };
