'use strict';

/**
 * guard.js — keeps multi-instance working.
 *
 * Primary mechanism: Fleet itself holds the two global Roblox singleton
 * names (ROBLOX_singletonEvent / ROBLOX_singletonMutex) as mutexes for its
 * whole lifetime (see native.acquireSingletonNames). Every client launched
 * while Fleet runs finds the names already present and starts as a
 * non-primary instance — no race, no sweeping while instances run.
 *
 * The sweep (closing the GLOBAL guard handles inside running clients) runs
 * only while a name is still owned by a client that was started BEFORE
 * Fleet; once the names are claimed, the guard goes fully idle. Each
 * instance's own per-path mutex is never touched — path isolation handles
 * those (see clones.js), and closing one would make the instance exit.
 */

const native = require('./native');
const processes = require('./processes');

const TICK_MS = 250;
const LAUNCH_WINDOW_MS = 30000;  // "aggressive" window after each launch
const AGGRESSIVE_MS = 250;        // sweep cadence right after a launch
const STEADY_MS = 1500;           // sweep cadence otherwise (paced: sweeps are rare now)

let timer = null;
let playerPath = null;
let lastLaunch = 0;
let lastHeavy = 0;
let busy = false;
let announced = false;
let totalClosed = 0;
let logger = { info() {}, warn() {}, error() {} };
let getPids = null; // optional injected source (the monitor) to avoid extra tasklist spawns

function configure(opts) {
  if (opts && opts.logger) logger = opts.logger;
  if (opts && opts.playerPath) playerPath = opts.playerPath;
  if (opts && typeof opts.getPids === 'function') getPids = opts.getPids;
}

function setPlayerPath(p) { playerPath = p; }
function noteLaunch() { lastLaunch = Date.now(); }

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Claim whichever global names are free (two cheap CreateMutex calls).
    // Once both are held, no client can create the objects at all, so there
    // is nothing left to do — the guard is idle for the rest of the session.
    const r = native.acquireSingletonNames();
    if (r.ok) {
      if (!announced) {
        announced = true;
        logger.info('Multi-instance guard active (singleton names held)');
      }
      return;
    }
    if (!native.isAvailable()) return; // FFI gone: nothing further is possible

    // At least one name is owned by a client started before Fleet. Close the
    // global guard handles inside the running clients so the kernel destroys
    // the objects; the next tick claims the freed name.
    const now = Date.now();
    const recentLaunch = now - lastLaunch < LAUNCH_WINDOW_MS;
    if (now - lastHeavy < (recentLaunch ? AGGRESSIVE_MS : STEADY_MS)) return;
    lastHeavy = now;

    let pids = [];
    if (getPids) {
      try { pids = getPids() || []; } catch (_) { pids = []; }
    }
    if (!pids.length) {
      try { pids = (await processes.list()).map(p => p.pid); } catch (_) { pids = []; }
    }
    if (!pids.length) return;

    const res = native.closeRobloxSingletonHandles(pids, 'global');
    if (res && res.closed) totalClosed += res.closed;
  } catch (err) {
    logger.warn('Guard tick failed', err && err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer || !native.isAvailable()) return;
  tick(); // claim the singleton names right away, not a full interval later
  timer = setInterval(tick, TICK_MS);
  logger.info('Multi-instance guard started');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function stats() {
  return {
    running: !!timer,
    totalClosed,
    squat: native.squatHeld() ? 'held' : 'pending',
    multiInstance: native.isAvailable() && native.squatHeld(),
  };
}

module.exports = { configure, setPlayerPath, noteLaunch, start, stop, stats };
