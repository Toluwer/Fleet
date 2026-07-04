'use strict';

/**
 * clones.js — per-instance path isolation via directory junctions.
 *
 * Current Roblox guards single-instance with a mutex named after the client's
 * full exe path. Two clients launched from the *same* path collide. By
 * launching each instance through its own directory **junction** that points at
 * the real Roblox version folder, every instance gets a distinct exe path — and
 * therefore a distinct per-path mutex — with no file copying (a junction is a
 * reparse point, created instantly and sharing the original files).
 *
 * Safety: junctions only ever live under our clones root, and removal uses a
 * plain `rmdir` (never `/s`) which deletes the junction link without touching
 * the target's contents.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let root = null;
let logger = { info() {}, warn() {}, error() {} };
const slots = new Map(); // slotName -> { pid:number|null, at:number }
const REUSE_GRACE_MS = 20000; // don't reclaim a slot until its PID is gone for this long

function configure(dir, log) {
  root = dir;
  if (log) logger = log;
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
}

function makeJunction(link, target) {
  // Recreate so the junction always points at the current version folder.
  try { execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore', windowsHide: true });
}

function removeJunction(link) {
  // Only ever remove links inside our root, and never with /s.
  if (!root || !link.startsWith(root)) return;
  try { execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
}

/**
 * Reserve a fresh, unused junction pointing at `versionDir` and return the
 * RobloxPlayerBeta.exe path inside it.
 * @param {string} versionDir  the real Roblox version folder
 * @param {number[]} livePids  PIDs currently running, used to free dead slots
 * @returns {{slot:string, exe:string}}
 */
function acquire(versionDir, livePids) {
  if (!root) throw new Error('clones not configured');
  const live = new Set(livePids || []);
  const now = Date.now();
  // Reclaim a slot only once its PID has been gone long enough that a stale
  // snapshot can't cause us to reuse a still-booting instance's path.
  for (const [slot, info] of Array.from(slots.entries())) {
    if (info && info.pid && !live.has(info.pid) && (now - info.at) > REUSE_GRACE_MS) {
      slots.delete(slot);
    }
  }
  let i = 1;
  let slot;
  while (true) {
    slot = 'instance-' + i;
    if (!slots.has(slot)) break;
    i++;
  }
  const link = path.join(root, slot);
  makeJunction(link, versionDir);
  slots.set(slot, { pid: null, at: now }); // reserved (pending) — never reused
  logger.info('Prepared isolated launch path: ' + slot);
  return { slot, exe: path.join(link, 'RobloxPlayerBeta.exe') };
}

function assign(slot, pid) {
  if (slots.has(slot)) slots.set(slot, { pid: pid || null, at: Date.now() });
}

function activeCount() { return slots.size; }

/** Remove every junction we created (called on shutdown). */
function cleanup() {
  if (!root) return;
  try {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('instance-')) removeJunction(path.join(root, name));
    }
  } catch (_) {}
  slots.clear();
}

module.exports = { configure, acquire, assign, activeCount, cleanup };
