'use strict';

/**
 * clones.js — per-instance path isolation.
 *
 * Roblox guards single-instance with a mutex named after the client's full
 * exe path ("C:\...\RobloxPlayerBeta.exe" -> "C:_..._RobloxPlayerBeta.exe.mtx"),
 * and the current client resolves junctions to their real target before using
 * that path — so two clients launched through directory junctions still
 * compute the SAME guard name, detect each other, and the older client is
 * closed. Real isolation needs a genuinely distinct exe path.
 *
 * Each launch therefore gets its own slot folder containing:
 *   - every top-level FILE of the Roblox version folder as a HARD LINK
 *     (a second name for the same bytes: instant, zero disk cost, and the
 *     path really is the slot's path — nothing to resolve)
 *   - every top-level FOLDER re-pointed with a junction (content is shared
 *     read-only, and folder paths carry no guard)
 * A hard link that cannot be created (different volume, exotic filesystem)
 * falls back to a plain copy, which isolates just as well at the cost of disk.
 *
 * A slot is only ever reused once nothing runs from it anymore — decided by
 * the live client paths of the process monitor, never by blind deletion, so a
 * running client's files are untouchable.
 */

const fs = require('fs');
const path = require('path');

let root = null;
let logger = { info() {}, warn() {}, error() {} };
const slots = new Map(); // slotName -> { pid:number|null, at:number }

function configure(dir, log) {
  root = dir;
  if (log) logger = log;
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
}

/** True when something exists at `p` (junctions included, broken or not). */
function present(p) {
  try { fs.lstatSync(p); return true; } catch (_) { return false; }
}

/** Does any live client run from inside `dir`? Unknown paths count as yes. */
function slotInUse(dir, liveRows) {
  if (!Array.isArray(liveRows)) return true; // no data -> assume the worst
  if (liveRows.length === 0) return false;  // no clients at all -> free
  const base = String(dir).toLowerCase().replace(/[\\/]+$/, '') + path.sep.toLowerCase();
  for (const row of liveRows) {
    const exe = String((row && row.executablePath) || '').toLowerCase().replace(/[\\/]+$/, '');
    if (!exe) return true; // a client with an unknown path could be this slot
    if (exe.startsWith(base)) return true;
  }
  return false;
}

/** Remove a slot folder nobody runs from. Hard links are simply unlinked (the
 * shared file data lives on); junctions are removed as reparse points, never
 * followed. Returns true when the slot is gone (or never existed). */
function reclaimSlot(dir, liveRows) {
  if (!present(dir)) return true;
  if (slotInUse(dir, liveRows)) return false;
  // Second opinion: a running (or still-booting) client keeps its exe locked
  // against writes, so an exclusive-open probe catches clients the process
  // snapshot has not shown yet. Only when the exe opens do we dare touch the
  // rest of the slot — content junctions first would break a live client.
  const exe = path.join(dir, 'RobloxPlayerBeta.exe');
  if (present(exe)) {
    let fh = null;
    try {
      fh = fs.openSync(exe, 'r+');
    } catch (_) {
      return false; // locked: a client still runs from this slot
    }
    try { fs.closeSync(fh); } catch (_) {}
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Could not reclaim ' + dir + ': ' + (err && err.message));
    return false;
  }
  return !present(dir);
}

/** Fill a fresh slot folder from the Roblox version folder. */
function buildSlot(slotDir, versionDir) {
  fs.mkdirSync(slotDir, { recursive: true });
  let linked = 0;
  let copied = 0;
  let junctioned = 0;
  for (const entry of fs.readdirSync(versionDir, { withFileTypes: true })) {
    const src = path.join(versionDir, entry.name);
    const dst = path.join(slotDir, entry.name);
    if (entry.isDirectory()) {
      fs.symlinkSync(src, dst, 'junction');
      junctioned++;
    } else if (entry.isFile()) {
      try {
        fs.linkSync(src, dst);
        linked++;
      } catch (_) {
        fs.copyFileSync(src, dst);
        copied++;
      }
    }
  }
  return { linked, copied, junctioned };
}

/** True when a pid is gone (probe only; never signals anything). */
function pidGone(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; } catch (_) { return true; }
}

/**
 * Reserve a fresh, unused launch slot for `versionDir` and return the
 * RobloxPlayerBeta.exe path inside it.
 * @param {string} versionDir  the real Roblox version folder
 * @param {Array} [liveRows]  monitor snapshot rows ({executablePath}); a slot
 *        is reused only once no live client runs from it
 * @returns {{slot:string, exe:string}}
 */
function acquire(versionDir, liveRows) {
  if (!root) throw new Error('clones not configured');
  let i = 1;
  let slot;
  let link;
  while (true) {
    slot = 'instance-' + i;
    link = path.join(root, slot);
    // Reserved earlier this session, or still serving a running client:
    // skip. Anything else (stale leftovers included) is reclaimed.
    if (slots.has(slot) || !reclaimSlot(link, liveRows)) {
      i++;
      continue;
    }
    break;
  }
  const counts = buildSlot(link, versionDir);
  slots.set(slot, { pid: null, at: Date.now() });
  logger.info(
    'Prepared isolated launch path: ' + slot +
    ` (${counts.linked} linked, ${counts.copied} copied, ${counts.junctioned} shared folders)`);
  return { slot, exe: path.join(link, 'RobloxPlayerBeta.exe') };
}

function assign(slot, pid) {
  if (slots.has(slot)) slots.set(slot, { pid: pid || null, at: Date.now() });
}

function activeCount() { return slots.size; }

/**
 * Shutdown sweep. Only slots whose launched client has exited are removed —
 * detached clients outlive Fleet, and deleting their files mid-session breaks
 * them. Slots we cannot prove dead are left for a future acquire() to reclaim
 * once the process monitor confirms nothing runs from them.
 */
function cleanup() {
  if (!root) return;
  for (const [slot, info] of Array.from(slots.entries())) {
    if (pidGone(info && info.pid)) reclaimSlot(path.join(root, slot), []);
    // Keep the bookkeeping either way: a live client still owns that slot.
    slots.delete(slot);
  }
}

module.exports = { configure, acquire, assign, activeCount, cleanup };
