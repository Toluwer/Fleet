'use strict';

/**
 * roblox.js — locate the Roblox player executable.
 *
 * Detection order (first hit wins):
 *   1. A valid manual override path from settings.
 *   2. The `roblox-player` URL-protocol handler in the registry.
 *   3. A filesystem scan of the known install roots, newest version first.
 *
 * All candidates found are returned too, so the Diagnostics page can show the
 * user exactly where Roblox was (or wasn't) found.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLAYER_EXE = 'RobloxPlayerBeta.exe';

function validatePath(p) {
  try {
    if (!p || typeof p !== 'string') return false;
    if (!/robloxplayerbeta\.exe$/i.test(p)) return false;
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function versionFromPath(p) {
  try {
    const dir = path.basename(path.dirname(p));
    return /^version-/i.test(dir) ? dir : dir;
  } catch (_) {
    return 'unknown';
  }
}

function fromRegistry() {
  const keys = [
    'HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command',
    'HKLM\\Software\\Classes\\roblox-player\\shell\\open\\command',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8', timeout: 4000, windowsHide: true,
      });
      const m = out.match(/"([^"]*RobloxPlayerBeta\.exe)"/i);
      if (m && validatePath(m[1])) return m[1];
    } catch (_) { /* key may not exist */ }
  }
  return null;
}

function scanRoots() {
  const found = [];
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Roblox', 'Versions'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Roblox', 'Versions'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Roblox', 'Versions'),
  ].filter(Boolean);

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const exe = path.join(root, e.name, PLAYER_EXE);
        if (validatePath(exe)) {
          let mtime = 0;
          try { mtime = fs.statSync(exe).mtimeMs; } catch (_) {}
          found.push({ path: exe, mtime });
        }
      }
    } catch (_) { /* unreadable root */ }
  }
  // Newest first
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map(f => f.path);
}

/**
 * @returns {{found:boolean, playerPath:string|null, version:string|null,
 *            source:string, candidates:string[]}}
 */
function locate(settings) {
  settings = settings || {};
  const candidates = [];

  // 1. Manual override
  const override = (settings.robloxPath || '').trim();
  if (override) {
    if (validatePath(override)) {
      return { found: true, playerPath: override, version: versionFromPath(override), source: 'manual', candidates: [override] };
    }
    // Invalid override is reported but we still try to auto-detect if allowed
    candidates.push(override + '  (invalid override)');
    if (settings.autoDetect === false) {
      return { found: false, playerPath: null, version: null, source: 'manual', candidates };
    }
  }

  // 2. Registry protocol handler
  const reg = fromRegistry();
  if (reg) {
    candidates.push(reg);
    return { found: true, playerPath: reg, version: versionFromPath(reg), source: 'registry', candidates };
  }

  // 3. Filesystem scan
  const scanned = scanRoots();
  for (const s of scanned) candidates.push(s);
  if (scanned.length) {
    return { found: true, playerPath: scanned[0], version: versionFromPath(scanned[0]), source: 'filesystem', candidates };
  }

  return { found: false, playerPath: null, version: null, source: 'none', candidates };
}

module.exports = { locate, validatePath, versionFromPath, PLAYER_EXE };
