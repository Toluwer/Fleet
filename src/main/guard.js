'use strict';

/**
 * guard.js — keeps multi-instance working.
 *
 * Primary mechanism: Fleet itself OWNS the two global Roblox singleton
 * names (ROBLOX_singletonEvent / ROBLOX_singletonMutex) for its whole
 * lifetime (see native.acquireSingletonNames). A client that finds a name
 * present but owned by someone else runs as a non-primary instance, so
 * every launch coexists — no handoff, no window getting replaced.
 *
 * Second mechanism, timed to match how the client actually starts: a few
 * seconds after boot each client opens handles to the global guard names.
 * Those handles are what let a client receive singleton handoffs, so the
 * guard closes them per client — once the client's own startup handshake
 * is done (3s) and once more for slow machines (8s). Only the GLOBAL
 * names are ever touched; a running instance's per-path mutex is never
 * closed (that would make it exit).
 *
 * The contested sweep covers the one remaining case: Roblox was started
 * BEFORE Fleet, so the running client owns a name. Its global guard
 * handles are swept so it can no longer be handed off to, and ownership
 * falls to Fleet the moment that client exits.
 */

const native = require('./native');
const processes = require('./processes');

const TICK_MS = 250;
const STRIP_AT_MS = 3000;   // past the client's singleton handshake
const STRIP_AGAIN_MS = 8000; // second pass for slow boots
const CONTESTED_MS = 1500;  // sweep cadence while a pre-Fleet client owns a name

let timer = null;
let playerPath = null;
let lastHeavy = 0;
let busy = false;
let announced = false;
let totalClosed = 0;
let logger = { info() {}, warn() {}, error() {} };
let getPids = null; // optional injected source (the monitor) to avoid extra tasklist spawns
const seenPids = new Map(); // pid -> { at, passes }

function configure(opts) {
  if (opts && opts.logger) logger = opts.logger;
  if (opts && opts.playerPath) playerPath = opts.playerPath;
  if (opts && typeof opts.getPids === 'function') getPids = opts.getPids;
}

function setPlayerPath(p) { playerPath = p; }
function noteLaunch() { tick().catch(() => {}); } // watch for the new pid right away

async function currentPids() {
  // The injected monitor source is authoritative (and updates within a
  // couple of seconds of any client appearing); only without it do we
  // enumerate processes ourselves.
  if (getPids) {
    try { return getPids() || []; } catch (_) { return []; }
  }
  try { return (await processes.list()).map(p => p.pid); } catch (_) { return []; }
}

/** Close the global guard handles the given clients hold open (one pass). */
function stripClients(pids) {
  try {
    const res = native.closeRobloxSingletonHandles(pids, 'global');
    if (res && res.closed) {
      totalClosed += res.closed;
      logger.info(`Multi-instance: cleared ${res.closed} singleton handle(s) in ${pids.length} client(s)`);
    }
  } catch (_) { /* best effort */ }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // 1. Own the names (two cheap CreateMutex + wait calls). Once both are
    //    owned no client can become the primary, which is the fix itself.
    const r = native.acquireSingletonNames();

    // 2. Timed strip: watch for clients we have not seen yet and clear
    //    their global guard handles right after their startup handshake.
    const pids = await currentPids();
    const now = Date.now();
    const live = new Set(pids);
    for (const pid of Array.from(seenPids.keys())) {
      if (!live.has(pid)) seenPids.delete(pid); // exited: stop tracking
    }
    const due = [];
    for (const pid of pids) {
      let entry = seenPids.get(pid);
      if (!entry) {
        entry = { at: now, passes: 0 };
        seenPids.set(pid, entry);
      }
      const age = now - entry.at;
      if (entry.passes === 0 && age >= STRIP_AT_MS) {
        entry.passes = 1;
        due.push(pid);
      } else if (entry.passes === 1 && age >= STRIP_AGAIN_MS) {
        entry.passes = 2;
        due.push(pid);
      }
    }
    if (due.length) stripClients(due); // one handle walk for the whole batch

    if (r.ok) {
      if (!announced) {
        announced = true;
        logger.info('Multi-instance guard active (singleton names owned)');
      }
      return;
    }
    if (!native.isAvailable()) return; // FFI gone: nothing further is possible

    // 3. Contested: a client started before Fleet still owns a name. Sweep
    //    its global guard handles so it cannot be handed off to either;
    //    ownership falls to Fleet when that client exits.
    if (now - lastHeavy < CONTESTED_MS) return;
    lastHeavy = now;
    if (!pids.length) return;
    const res = native.closeRobloxSingletonHandles(pids, 'global');
    if (res && res.closed) {
      totalClosed += res.closed;
      logger.info(`Multi-instance: swept ${res.closed} singleton handle(s) from a client that predates Fleet`);
    }
  } catch (err) {
    logger.warn('Guard tick failed', err && err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer || !native.isAvailable()) return;
  tick(); // own the singleton names right away, not a full interval later
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
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
