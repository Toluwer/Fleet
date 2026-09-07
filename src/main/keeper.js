'use strict';

/**
 * keeper.js — the watchdog that keeps armed accounts in their game.
 *
 * The old keep-alive lived in the renderer and watched Roblox presence every
 * 12 seconds. This one lives in the main process and uses two signals:
 *
 *   - process liveness: every monitor poll (2 s) we see whether the client we
 *     launched for an account is still alive, so a dead pid is caught in
 *     seconds instead of on the next presence sweep.
 *   - presence: the 12 s account poll tells us an account is in a game even
 *     when Fleet has no pid for it (Fleet restarted while its detached clients
 *     kept running, so the pid map is empty).
 *
 * Rejoins mint a fresh auth ticket — replaying the old deep link would fail
 * anyway because tickets expire minutes after issue. Each retry waits longer
 * (10 s doubling, capped at 5 min) and gives up after N straight tries that
 * never settle; five clean minutes up resets the counter. Manual kills ("End",
 * "End all", "Restart") disarm or blind the account first so the watchdog
 * never fights the user.
 *
 * Armed records persist to keeper.json. After a Fleet restart they come back
 * paused: they only wake once the account is seen in game (or its client
 * reappears), so reopening Fleet never relaunches a client the user closed on
 * purpose.
 */

const EventEmitter = require('events');

const PERSIST_KEY = 'keeper.json';
const MAX_RECORDS = 20;

const BOOT_GRACE_MS = 20000;     // a just-spawned pid may miss one tasklist sweep
const WAITING_GRACE_MS = 90000;  // armed, client never appeared -> failed launch
const PRESENCE_GRACE_MS = 45000; // in-game presence gone this long -> died
const STABLE_MS = 300000;        // five clean minutes resets the retry counter
const BACKOFF_CAP_MS = 300000;   // rejoin delay never exceeds 5 minutes
const RESTART_BLIND_MS = 20000;  // death detection paused around a manual restart

function baseDelayMs(settings) {
  const sec = Math.max(0, Math.min(300, Number(settings && settings.autoRejoinDelaySec) || 0));
  // 0 stays 0 (tests drive the state machine with instant timers); real
  // settings come through the store, which clamps to at least 3 seconds.
  return sec * 1000;
}
function maxAttempts(settings) {
  return Math.max(1, Math.min(20, Number(settings && settings.autoRejoinMaxAttempts) || 5));
}
function hungThresholdMs(settings) {
  const sec = Number(settings && settings.autoRestartHungSec) || 0;
  return sec > 0 ? Math.min(120, sec) * 1000 : 0;
}

class InstanceKeeper extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.now = opts.now || (() => Date.now());
    this.store = opts.store || null;                 // { readJson, writeJson }; null in tests
    this.settingsProvider = opts.settingsProvider || (() => ({}));
    this.launchAccount = opts.launchAccount || null; // (accountId, placeId, gameInstanceId) -> { ok, pid, reason }
    this.launchFollow = opts.launchFollow || null;   // (accountId, targetUserId) -> { ok, pid, reason }
    this.killInstance = opts.killInstance || null;    // (pid) -> promise; used for stuck clients
    this.records = new Map();  // accountId -> record
    this.timers = new Map();   // accountId -> countdown handle
    this.busy = new Set();     // accounts with a rejoin in flight
    this.on('change', () => this.persist());
  }

  /* ------------------------------ arming ------------------------------ */

  arm(input) {
    const accountId = String((input && input.accountId) || '').trim();
    if (!accountId) return { ok: false, error: 'No account to watch.' };
    if (!this.records.has(accountId) && this.records.size >= MAX_RECORDS) {
      return { ok: false, error: `Watchdog limit reached (${MAX_RECORDS} accounts).` };
    }
    const prev = this.records.get(accountId) || {};
    const record = {
      accountId,
      userId: Number(input.userId) || prev.userId || null,
      username: String(input.username || prev.username || '').slice(0, 40),
      placeId: String(input.placeId || prev.placeId || '').trim(),
      gameInstanceId: String(input.gameInstanceId || prev.gameInstanceId || '').trim(),
      targetUserId: Number(input.targetUserId) || prev.targetUserId || null,
      name: String(input.name || prev.name || 'the game').slice(0, 80),
      state: 'waiting',           // waiting -> running -> rejoining -> (waiting | gaveup)
      pid: Number(input.pid) || null,
      launchedAt: Number(input.pid) ? this.now() : 0,
      upAt: 0,
      everUp: false,
      attempts: 0,
      hungMs: 0,
      lastUpAt: this.now(),
      armedAt: this.now(),
      nextAt: 0,
      lastReason: '',
      blindUntil: 0,
      paused: !!input.paused,     // restored from disk: adopt, never relaunch
    };
    this.records.set(accountId, record);
    this.clearTimer(accountId);
    this.logger.info(`Watchdog armed for ${record.username || accountId}` +
      (record.placeId ? ` (${record.placeId}${record.gameInstanceId ? ', exact server' : ''})` : ''));
    this.emit('change', this.status());
    return { ok: true };
  }

  armMany(list) {
    let armed = 0;
    for (const item of (Array.isArray(list) ? list : [])) {
      if (this.arm(item).ok) armed += 1;
    }
    return { ok: armed > 0, armed };
  }

  disarm(accountId, reason) {
    const key = String(accountId || '');
    const record = this.records.get(key);
    if (!record) return { ok: false };
    this.clearTimer(key);
    this.records.delete(key);
    this.logger.info(`Watchdog disarmed for ${record.username || key}${reason ? ' — ' + reason : ''}`);
    this.emit('change', this.status());
    return { ok: true };
  }

  disarmAll(reason) {
    const count = this.records.size;
    if (!count) return { ok: true, disarmed: 0 };
    for (const accountId of Array.from(this.records.keys())) this.clearTimer(accountId);
    this.records.clear();
    this.logger.info('Watchdog disarmed for all accounts' + (reason ? ' — ' + reason : ''));
    this.emit('change', this.status());
    return { ok: true, disarmed: count };
  }

  /* --------------------------- live signals --------------------------- */

  /** Process snapshot from the monitor (fleet rows carry accountId). */
  onInstances(instances) {
    if (!this.records.size) return;
    const byAccount = new Map();
    for (const row of (instances || [])) {
      if (row && row.source === 'fleet' && row.accountId) byAccount.set(row.accountId, row);
    }
    const now = this.now();
    const settings = this.settingsProvider();
    const hungMs = hungThresholdMs(settings);
    const pollMs = Math.max(750, Number(settings && settings.pollIntervalMs) || 2000);

    for (const record of Array.from(this.records.values())) {
      const row = byAccount.get(record.accountId);

      if (row) {
        // A live client for this account: it is up right now.
        record.pid = row.pid;
        record.hungMs = row.status === 'not_responding' ? record.hungMs + pollMs : 0;
        if (record.state !== 'running') {
          record.everUp = true;
          record.paused = false;
          record.upAt = now;
          record.state = 'running';
          record.nextAt = 0;
          this.logger.info(`Watchdog: ${record.username} is up (pid ${row.pid})`);
          this.emit('change', this.status());
        }
        if (hungMs && record.hungMs >= hungMs && !this.busy.has(record.accountId)) {
          record.lastReason = 'not responding';
          if (record.pid != null && this.killInstance) {
            try {
              const killed = this.killInstance(record.pid);
              if (killed && killed.then) killed.catch(() => {});
            } catch (_) { /* the rejoin replaces it either way */ }
            record.pid = null;   // the stuck client is on its way out; stop watching it
          }
          this.deathDetected(record, 'stopped responding');
          continue;
        }
        // A client that stays up five minutes earns a clean slate.
        if (record.attempts > 0 && record.upAt && now - record.upAt >= STABLE_MS) {
          this.logger.info(`Watchdog: ${record.username} stable — retry counter reset`);
          record.attempts = 0;
          record.lastReason = '';
          this.emit('change', this.status());
        }
        continue;
      }

      // No row. If we just launched it, the pid may simply be too new for
      // tasklist; give it a boot grace before crying death.
      const booting = record.pid != null && record.state === 'waiting'
        && record.launchedAt && now - record.launchedAt < BOOT_GRACE_MS;
      if (booting) continue;

      if (record.pid != null && (record.state === 'running' || record.state === 'waiting')) {
        record.pid = null;
        if (record.paused) { this.disarm(record.accountId, 'client closed'); continue; }
        this.deathDetected(record, 'closed');
        continue;
      }

      // Armed from the UI right after launch, or a rejoin that spawned: if
      // the client never shows up at all, count it as a failed launch.
      if (record.state === 'waiting' && record.pid == null && !record.paused
        && now - record.armedAt > WAITING_GRACE_MS) {
        this.deathDetected(record, 'never started');
      }
    }
  }

  /** Presence sweep from the accounts poller ('In game' when playing). */
  onPresence(userId, status) {
    if (!this.records.size || userId == null) return;
    const record = Array.from(this.records.values()).find(r => r.userId === Number(userId));
    if (!record) return;
    const now = this.now();
    if (status === 'In game') {
      record.lastUpAt = now;
      record.everUp = true;
      record.paused = false;
      // Presence may upgrade a waiting watch to running (the client runs but
      // carries no pid of ours, e.g. after a Fleet restart). It must never
      // cancel a countdown that a dead pid already started.
      if (record.state === 'waiting' && record.pid == null) {
        record.state = 'running';
        record.upAt = record.upAt || now;
        this.emit('change', this.status());
      }
      return;
    }
    if (record.state === 'running' && record.pid == null) {
      // Running purely on presence: no pid, no in-game status — the client
      // left. Give presence lag its grace before rejoining.
      if (now - record.lastUpAt > PRESENCE_GRACE_MS) {
        if (record.paused) { this.disarm(record.accountId, 'client closed'); return; }
        this.deathDetected(record, 'left the game');
      }
    }
  }

  /* --------------------------- user actions --------------------------- */

  /** "End" on a row: stop watching that account so we don't undo the kill. */
  onManualKill(pid) {
    const record = Array.from(this.records.values()).find(r => r.pid === pid);
    if (!record) return null;
    this.disarm(record.accountId, 'ended by user');
    return record;
  }

  /** "End all" / "Cleanup": forget every watch. */
  onManualKillAll() { this.disarmAll('ended by user'); }

  /** "Restart" relaunches on its own; ignore the kill/spawn gap. */
  onManualRestart(pid) {
    const record = Array.from(this.records.values()).find(r => r.pid === pid);
    if (record) record.blindUntil = this.now() + RESTART_BLIND_MS;
    return record || null;
  }

  /* ---------------------------- internals ---------------------------- */

  deathDetected(record, reason) {
    if (record.blindUntil && this.now() < record.blindUntil) return;
    const settings = this.settingsProvider();
    const max = maxAttempts(settings);
    if (record.attempts >= max) {
      record.state = 'gaveup';
      record.nextAt = 0;
      record.lastReason = reason;
      this.clearTimer(record.accountId);
      this.logger.warn(`Watchdog gave up on ${record.username} after ${record.attempts} tries (${reason})`);
      this.emit('gaveup', record);
      this.emit('change', this.status());
      return;
    }
    record.attempts += 1;
    record.state = 'rejoining';
    record.lastReason = reason;
    const delay = Math.min(baseDelayMs(settings) * Math.pow(2, record.attempts - 1), BACKOFF_CAP_MS);
    record.nextAt = this.now() + delay;
    this.schedule(record, delay);
    this.logger.info(
      `Watchdog: ${record.username} ${reason} — rejoining in ${Math.round(delay / 1000)}s (try ${record.attempts}/${max})`);
    this.emit('rejoin', Object.assign({}, record, { delayMs: delay }));
    this.emit('change', this.status());
  }

  schedule(record, delayMs) {
    this.clearTimer(record.accountId);
    const timer = setTimeout(() => {
      this.timers.delete(record.accountId);
      this.rejoin(record, 'timer');
    }, Math.max(0, delayMs));
    if (timer.unref) timer.unref();
    this.timers.set(record.accountId, timer);
  }

  clearTimer(accountId) {
    const timer = this.timers.get(accountId);
    if (timer) { clearTimeout(timer); this.timers.delete(accountId); }
  }

  async rejoin(record, cause) {
    if (!this.records.has(record.accountId) || this.busy.has(record.accountId)) return;
    this.busy.add(record.accountId);
    try {
      const settings = this.settingsProvider();
      const max = maxAttempts(settings);
      let r = null;
      if (record.targetUserId && this.launchFollow) {
        r = await this.launchFollow(record.accountId, record.targetUserId);
      } else if (this.launchAccount) {
        r = await this.launchAccount(record.accountId, record.placeId, record.gameInstanceId);
      }
      if (r && r.ok && r.pid) {
        record.pid = r.pid;
        record.launchedAt = this.now();
        record.state = 'waiting';     // flips to running when the pid shows up
        record.armedAt = this.now();
        record.everUp = false;
        this.logger.info(`Watchdog relaunched ${record.username || record.accountId} (pid ${r.pid})`);
      } else {
        const reason = (r && r.reason) || 'launch failed';
        record.lastReason = reason;
        if (record.attempts >= max) {
          record.state = 'gaveup';
          record.nextAt = 0;
          this.clearTimer(record.accountId);
          this.logger.warn(`Watchdog gave up on ${record.username || record.accountId}: ${reason}`);
          this.emit('gaveup', record);
        } else {
          record.attempts += 1;
          const delay = Math.min(baseDelayMs(settings) * Math.pow(2, record.attempts - 1), BACKOFF_CAP_MS);
          record.state = 'rejoining';
          record.nextAt = this.now() + delay;
          this.schedule(record, delay);
          this.logger.warn(
            `Watchdog rejoin failed for ${record.username || record.accountId} (${reason}) — retry in ${Math.round(delay / 1000)}s`);
          this.emit('rejoin', Object.assign({}, record, { delayMs: delay }));
        }
      }
      this.emit('change', this.status());
    } catch (err) {
      this.logger.error('Watchdog rejoin error', err && err.message);
    } finally {
      this.busy.delete(record.accountId);
    }
  }

  /* ------------------------------ status ------------------------------ */

  status() {
    const records = Array.from(this.records.values()).map(r => ({
      accountId: r.accountId,
      userId: r.userId,
      username: r.username,
      name: r.name,
      placeId: r.placeId,
      gameInstanceId: r.gameInstanceId,
      targetUserId: r.targetUserId,
      state: r.state,
      paused: !!r.paused,
      pid: r.pid,
      attempts: r.attempts,
      nextAt: r.state === 'rejoining' ? r.nextAt : 0,
      lastReason: r.lastReason || '',
    }));
    return {
      ok: true,
      records,
      summary: {
        armed: records.length,
        running: records.filter(r => r.state === 'running').length,
        rejoining: records.filter(r => r.state === 'rejoining').length,
        gaveUp: records.filter(r => r.state === 'gaveup').length,
      },
    };
  }

  /* --------------------------- persistence --------------------------- */

  persist() {
    if (!this.store || !this.store.writeJson) return;
    const rows = Array.from(this.records.values())
      .filter(r => r.state !== 'gaveup')
      .map(r => ({
        accountId: r.accountId, userId: r.userId, username: r.username,
        placeId: r.placeId, gameInstanceId: r.gameInstanceId, targetUserId: r.targetUserId,
        name: r.name, armedAt: r.armedAt,
      }));
    try { this.store.writeJson(PERSIST_KEY, { records: rows }); } catch (err) {
      this.logger.warn('Could not save watchdog state', err && err.message);
    }
  }

  restore() {
    if (!this.store || !this.store.readJson) return { ok: true, restored: 0 };
    let data = null;
    try { data = this.store.readJson(PERSIST_KEY, { records: [] }); } catch (_) { data = { records: [] }; }
    const rows = Array.isArray(data && data.records) ? data.records : [];
    let restored = 0;
    for (const row of rows.slice(0, MAX_RECORDS)) {
      if (!row || !row.accountId) continue;
      if (this.arm(Object.assign({}, row, { paused: true })).ok) restored += 1;
    }
    if (restored) this.logger.info(`Watchdog restored ${restored} armed account(s)`);
    return { ok: true, restored };
  }

  stop() {
    for (const accountId of Array.from(this.timers.keys())) this.clearTimer(accountId);
    this.records.clear();
  }
}

module.exports = { InstanceKeeper, PERSIST_KEY };
