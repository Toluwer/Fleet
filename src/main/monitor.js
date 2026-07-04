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
const processes = require('./processes');

class ProcessMonitor extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.intervalMs = opts.intervalMs || 2000;
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.managed = new Map();   // pid -> { profileName, mode, deeplink, playerPath, launchedAt }
    this.firstSeen = new Map(); // pid -> ISO string
    this.timer = null;
    this.lastSnapshot = [];
    this._busy = false;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setInterval(ms) {
    this.intervalMs = Math.max(750, ms | 0);
    if (this.timer) { this.stop(); this.start(); }
  }

  markManaged(pid, info) {
    if (!pid) return;
    this.managed.set(pid, Object.assign({ launchedAt: new Date().toISOString() }, info || {}));
  }

  getManaged(pid) { return this.managed.get(pid); }

  forget(pid) { this.managed.delete(pid); this.firstSeen.delete(pid); }

  async poll() {
    if (this._busy) return;
    this._busy = true;
    try {
      const rows = await processes.list();
      const now = new Date().toISOString();
      const livePids = new Set();

      const instances = rows.map(r => {
        livePids.add(r.pid);
        const m = this.managed.get(r.pid);
        if (!m && !this.firstSeen.has(r.pid)) this.firstSeen.set(r.pid, now);
        const startedAt = m ? m.launchedAt : this.firstSeen.get(r.pid);
        return {
          pid: r.pid,
          memBytes: r.memBytes,
          status: r.status,
          windowTitle: r.windowTitle,
          source: m ? 'fleet' : 'external',
          profileName: m ? (m.profileName || '') : '',
          startedAt,
          startedExact: !!m,
        };
      });

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
