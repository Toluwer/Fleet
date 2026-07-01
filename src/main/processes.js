'use strict';

/**
 * processes.js — enumerate and terminate Roblox client processes.
 *
 * Enumeration uses `tasklist /V` (a native Windows tool) which returns PID,
 * memory, responding-status and the window title in a single fast call — no
 * long-lived helper processes, so nothing here can be orphaned.
 */

const { execFile } = require('child_process');
const native = require('./native');

const PLAYER_IMAGE = 'RobloxPlayerBeta.exe';
const CRASH_IMAGE = 'RobloxCrashHandler.exe';

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeout || 8000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

/** Parse one CSV line where every field is double-quoted. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function memToBytes(s) {
  // e.g. "1,234,567 K"
  const digits = String(s).replace(/[^\d]/g, '');
  if (!digits) return 0;
  return parseInt(digits, 10) * 1024;
}

/**
 * List running Roblox clients.
 *
 * Uses a FAST `tasklist` (no `/V`) for PID + memory — `/V` blocks for seconds
 * while clients are loading because it queries each window, and times out with
 * several clients (which made the list go blank). Window title + responding
 * status come from koffi (`GetWindowTextW` does not block on other processes).
 *
 * @returns {Promise<Array<{pid:number, memBytes:number, status:string, windowTitle:string}>>}
 */
async function list() {
  // Primary: spawn-free Toolhelp enumeration (immune to system load).
  let base = null;
  try { base = native.listProcesses(PLAYER_IMAGE); } catch (_) { base = null; }

  // Fallback: tasklist (only if FFI is unavailable).
  if (base === null) base = await tasklistList();
  if (!base || base.length === 0) return [];

  // Enrich with window title + responding status (fast, non-blocking).
  let info = new Map();
  try { info = native.windowInfoForPids(base.map(r => r.pid)); } catch (_) {}

  return base.map(r => {
    const wi = info.get(r.pid);
    return {
      pid: r.pid,
      memBytes: r.memBytes,
      status: wi && wi.responding === false ? 'not_responding' : 'running',
      windowTitle: wi ? (wi.title || '') : '',
    };
  });
}

/** tasklist-based fallback used only when the native FFI is unavailable. */
async function tasklistList() {
  const { err, stdout } = await run('tasklist',
    ['/FI', `IMAGENAME eq ${PLAYER_IMAGE}`, '/FO', 'CSV', '/NH'], 10000);
  if (err) return [];
  if (/No tasks are running/i.test(stdout)) return [];
  const base = [];
  for (const line of stdout.split(/\r?\n/).filter(l => l.trim().startsWith('"'))) {
    const f = parseCsvLine(line);
    if (f.length < 5 || !/robloxplayerbeta\.exe/i.test(f[0])) continue;
    const pid = parseInt(f[1], 10);
    if (!Number.isNaN(pid)) base.push({ pid, memBytes: memToBytes(f[4]) });
  }
  return base;
}

async function kill(pid, tree) {
  const args = ['/PID', String(pid), '/F'];
  if (tree) args.push('/T');
  const { err, stdout, stderr } = await run('taskkill', args, 6000);
  return { ok: !err, output: (stdout + stderr).trim() };
}

async function killImage(image) {
  const { err, stdout, stderr } = await run('taskkill', ['/IM', image, '/F'], 8000);
  const out = (stdout + stderr).trim();
  // taskkill returns non-zero when nothing matched; treat "not found" as success.
  const nothing = /not found|no running/i.test(out);
  return { ok: !err || nothing, output: out };
}

async function killAllPlayers() {
  return killImage(PLAYER_IMAGE);
}

/** Cleanup tool: kill all players AND leftover crash handlers. */
async function cleanupAll() {
  const players = await killImage(PLAYER_IMAGE);
  const crash = await killImage(CRASH_IMAGE);
  return {
    ok: players.ok && crash.ok,
    players: players.output,
    crash: crash.output,
  };
}

module.exports = { list, kill, killAllPlayers, cleanupAll, PLAYER_IMAGE, CRASH_IMAGE };
