'use strict';

/**
 * launcher.js — start Roblox client processes.
 *
 * Children are spawned detached and unref'd: Fleet does not keep a handle on
 * them, so closing Fleet never kills or orphans a running Roblox client.
 *
 * Two launch modes:
 *   - 'client'  : start the player executable directly (opens Roblox).
 *   - 'deeplink': hand a roblox:/roblox-player: URI (or http link) to the OS
 *                 protocol handler — a pass-through for advanced users who
 *                 already have a real launch URL.
 */

const fs = require('fs');
const { spawn } = require('child_process');

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

/**
 * @param {{playerPath:string, mode?:string, deeplink?:string}} opts
 * @returns {{ok:boolean, pid:number|null, reason?:string}}
 */
function launchInstance(opts) {
  const mode = opts && opts.mode === 'deeplink' ? 'deeplink' : 'client';

  if (mode === 'deeplink') {
    const link = (opts.deeplink || '').trim();
    if (!link) return { ok: false, pid: null, reason: 'Deep link is empty.' };

    try {
      if (/^roblox(-player)?:/i.test(link)) {
        if (!fileExists(opts.playerPath)) {
          return { ok: false, pid: null, reason: 'Roblox player not found.' };
        }
        const child = spawn(opts.playerPath, [link], { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true, pid: child.pid };
      }
      // http(s) — let the shell route it through the registered protocol
      const child = spawn('cmd', ['/c', 'start', '', link], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (err) {
      return { ok: false, pid: null, reason: err.message || String(err) };
    }
  }

  // client mode
  if (!fileExists(opts.playerPath)) {
    return { ok: false, pid: null, reason: 'Roblox player executable not found.' };
  }
  try {
    const child = spawn(opts.playerPath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, pid: null, reason: err.message || String(err) };
  }
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Launch several instances in sequence with a delay between each (gives each
 * client time to grab its slot before the next starts).
 */
async function launchMany(opts, count, delayMs, onEach) {
  const results = [];
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
  for (let i = 0; i < n; i++) {
    const r = launchInstance(opts);
    results.push(r);
    if (typeof onEach === 'function') {
      try { onEach(r, i, n); } catch (_) {}
    }
    if (i < n - 1) await delay(Math.max(0, delayMs || 0));
  }
  return results;
}

module.exports = { launchInstance, launchMany };
