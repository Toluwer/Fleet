'use strict';

/**
 * monitor.js — live tracking of Roblox client processes.
 *
 * Polls processes.list() on an interval and emits an enriched snapshot:
 *   - which instances Fleet launched ("fleet") vs. found running ("external")
 *   - start time (exact for Fleet-launched, first-seen for external)
 *   - memory, responding status and window title
 *
 * State maps are pruned every poll so PIDs that have exited can never
 * accumulate (no memory growth over a long session).
 */

const EventEmitter = require('events');
const path = require('path');
const processes = require('./processes');

function normalizedPath(value) {
  if (!value) return '';
  try { return path.win32.normalize(String(value)).replace(/[\\/]+$/, '').toLowerCase(); }
  catch (_) { return ''; }
}

function matchesManagedPath(row, managed) {
  if (!row.verifiedPath || !row.executablePath || !managed) return false;
  const actual = normalizedPath(row.executablePath);
  const pathMatches = [managed.exePath, managed.playerPath].some(expected => normalizedPath(expected) === actual);
  if (!pathMatches) return false;
  if (managed.processIdentity && row.processIdentity && managed.processIdentity !== row.processIdentity) return false;
  if (!managed.processIdentity && row.processIdentity) managed.processIdentity = row.processIdentity;
  return true;
}

class ProcessMonitor extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.intervalMs = opts.intervalMs || 2000;
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.processProvider = opts.processProvider || processes;
    this.managed = new Map();   // pid -> { profileName, mode, deeplink, playerPath, launchedAt }
    this.firstSeen = new Map(); // pid -> ISO string
    this.externalCandidates = new Map(); // pid -> { identity, count, firstSeen }
    this.timer = null;
    this.lastSnapshot = [];
    this._busy = false;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setPollInterval(ms) {
    this.intervalMs = Math.max(750, ms | 0);
    if (this.timer) { this.stop(); this.start(); }
  }

  markManaged(pid, info) {
    if (!pid) return;
    this.managed.set(pid, Object.assign({ launchedAt: new Date().toISOString() }, info || {}));
  }

  getManaged(pid) { return this.managed.get(pid); }

  forget(pid) { this.managed.delete(pid); this.firstSeen.delete(pid); this.externalCandidates.delete(pid); }

  async poll() {
    if (this._busy) return;
    this._busy = true;
    try {
      const rows = await this.processProvider.list();
      const now = new Date().toISOString();
      const livePids = new Set();
      const candidatePids = new Set();

      const instances = [];
      for (const r of rows) {
        const m = this.managed.get(r.pid);
        const managedMatch = matchesManagedPath(r, m);
        if (!managedMatch) {
          if ((!r.verifiedPath && !r.windowVerified) || (!r.trustedInstall && !r.windowVerified)) continue;
          candidatePids.add(r.pid);
          const identity = `${r.pid}|${normalizedPath(r.executablePath)}|${r.processIdentity || 'window'}`;
          const prior = this.externalCandidates.get(r.pid);
          const candidate = prior && prior.identity === identity
            ? { identity, count: prior.count + 1, firstSeen: prior.firstSeen }
            : { identity, count: 1, firstSeen: now };
          this.externalCandidates.set(r.pid, candidate);
          if (candidate.count < 2) continue;
          if (!this.firstSeen.has(r.pid)) this.firstSeen.set(r.pid, candidate.firstSeen);
        } else {
          this.externalCandidates.delete(r.pid);
        }
        livePids.add(r.pid);
        const startedAt = managedMatch ? m.launchedAt : this.firstSeen.get(r.pid);
        instances.push({
          pid: r.pid,
          memBytes: r.memBytes,
          status: r.status,
          windowTitle: r.windowTitle,
          executablePath: r.executablePath,
          source: managedMatch ? 'fleet' : 'external',
          profileName: managedMatch ? (m.profileName || '') : '',
          startedAt,
          startedExact: managedMatch,
        });
      }

      // Prune state for PIDs that have exited. Managed PIDs get a grace period:
      // a just-launched client may not appear in `tasklist` for a few hundred ms,
      // and we must not drop its "launched by Fleet" tag in that window.
      const nowMs = Date.now();
      for (const pid of Array.from(this.managed.keys())) {
        if (livePids.has(pid)) continue;
        const m = this.managed.get(pid);
        const age = m && m.launchedAt ? nowMs - new Date(m.launchedAt).getTime() : Infinity;
        if (age > 15000) this.managed.delete(pid);
      }
      for (const pid of Array.from(this.firstSeen.keys())) {
        if (!livePids.has(pid)) this.firstSeen.delete(pid);
      }
      for (const pid of Array.from(this.externalCandidates.keys())) {
        if (!candidatePids.has(pid)) this.externalCandidates.delete(pid);
      }

      instances.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

      const summary = {
        total: instances.length,
        fleet: instances.filter(i => i.source === 'fleet').length,
        external: instances.filter(i => i.source === 'external').length,
        notResponding: instances.filter(i => i.status === 'not_responding').length,
        totalMemBytes: instances.reduce((s, i) => s + (i.memBytes || 0), 0),
      };

      this.lastSnapshot = instances;
      this.emit('update', { instances, summary });
    } catch (err) {
      this.logger.error('Process poll failed', err.message);
    } finally {
      this._busy = false;
    }
  }

  snapshot() { return this.lastSnapshot; }
}

module.exports = { ProcessMonitor };
