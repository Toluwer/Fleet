'use strict';

/**
 * guard.js — keeps the *shared* Roblox single-instance objects
 * (ROBLOX_singletonEvent / ROBLOX_singletonMutex) cleared so multiple clients
 * stay alive.
 *
 * It deliberately closes ONLY the global guards (scope 'global'); each
 * instance's own per-path mutex is left untouched (path isolation handles
 * those — see clones.js). Closing a running instance's per-path mutex would
 * make it exit a few seconds later.
 *
 * The loop is cheap when idle: a fast existence check gates the heavier handle
 * sweep, and the guard only does work when there are multiple clients or a
 * launch happened recently.
 */

const native = require('./native');
const processes = require('./processes');

const TICK_MS = 250;
const LAUNCH_WINDOW_MS = 30000;  // "aggressive" window after each launch
const AGGRESSIVE_MS = 250;        // heavy-work cadence right after a launch
const STEADY_MS = 1500;           // heavy-work cadence in steady state

let timer = null;
let playerPath = null;
let lastLaunch = 0;
let lastHeavy = 0;
let pidCache = [];
let pidStamp = 0;
let busy = false;
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
    const now = Date.now();
    const recentLaunch = now - lastLaunch < LAUNCH_WINDOW_MS;

    // Heavy work (handle enumeration) is paced: fast right after a launch,
    // slow in steady state to keep idle CPU low.
    const dueHeavy = now - lastHeavy >= (recentLaunch ? AGGRESSIVE_MS : STEADY_MS);
    if (!dueHeavy) return;

    if (getPids) {
      // Reuse the monitor's snapshot — no extra process spawn.
      try { pidCache = getPids() || []; } catch (_) { pidCache = []; }
    } else {
      const refreshEvery = recentLaunch ? 800 : 2000;
      if (now - pidStamp > refreshEvery) {
        try { pidCache = (await processes.list()).map(p => p.pid); } catch (_) {}
        pidStamp = Date.now();
      }
    }

    const active = pidCache.length >= 2 || recentLaunch;
    if (!active) return;
    lastHeavy = Date.now();

    if (!native.blockerExists(playerPath, 'global')) return;
    const r = native.closeRobloxSingletonHandles(pidCache, 'global');
    if (r && r.closed) totalClosed += r.closed;
  } catch (err) {
    logger.warn('Guard tick failed', err && err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer || !native.isAvailable()) return;
  timer = setInterval(tick, TICK_MS);
  logger.info('Multi-instance guard started');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function stats() { return { running: !!timer, totalClosed }; }

module.exports = { configure, setPlayerPath, noteLaunch, start, stop, stats };
