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

function expandEnvVars(value) {
  return String(value || '').replace(/%([^%]+)%/g, (_, name) => process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()] || `%${name}%`);
}

function normalizePlayerPath(value) {
  try {
    if (!value || typeof value !== 'string') return '';
    let raw = expandEnvVars(value).trim();
    if (!raw) return '';
    raw = raw.replace(/^file:\/+/i, '');
    // Accept either separator regardless of the platform this runs on, so
    // quoted registry strings, env-var paths and POSIX paths all resolve.
    raw = raw.replace(/[\\/]+/g, path.sep);

    const quoted = raw.match(/"([^"]*RobloxPlayerBeta\.exe)"/i);
    if (quoted) raw = quoted[1];
    else {
      const exeIndex = raw.toLowerCase().indexOf('robloxplayerbeta.exe');
      if (exeIndex >= 0) raw = raw.slice(0, exeIndex + PLAYER_EXE.length);
    }

    raw = raw.trim().replace(/^["']|["']$/g, '').trim();
    while (/[\\/]$/.test(raw)) raw = raw.slice(0, -1);

    if (fs.existsSync(raw)) {
      const stat = fs.statSync(raw);
      if (stat.isDirectory()) {
        const direct = path.join(raw, PLAYER_EXE);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
      }
      if (stat.isFile() && path.basename(raw).toLowerCase() === PLAYER_EXE.toLowerCase()) return raw;
    }

    if (path.basename(raw).toLowerCase() === PLAYER_EXE.toLowerCase()) return raw;
    return '';
  } catch (_) {
    return '';
  }
}

function validatePath(p) {
  try {
    const normalized = normalizePlayerPath(p);
    return !!normalized && fs.existsSync(normalized) && fs.statSync(normalized).isFile();
  } catch (_) {
    return false;
  }
}

function pathStatus(p) {
  const normalized = normalizePlayerPath(p);
  if (!String(p || '').trim()) return { ok: false, normalized: '', reason: 'Path is empty.' };
  if (!normalized) return { ok: false, normalized: '', reason: 'Choose RobloxPlayerBeta.exe or its containing version folder.' };
  try {
    if (!fs.existsSync(normalized)) return { ok: false, normalized, reason: 'File does not exist.' };
    if (!fs.statSync(normalized).isFile()) return { ok: false, normalized, reason: 'Path is not a file.' };
    return { ok: true, normalized, reason: '' };
  } catch (err) {
    return { ok: false, normalized, reason: (err && err.message) || 'Could not read path.' };
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
      const normalized = normalizePlayerPath(out);
      if (validatePath(normalized)) return normalized;
    } catch (_) { /* key may not exist */ }
  }
  return null;
}

function scanRoots() {
  const found = [];
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Roblox', 'Versions'),
    process.env.ProgramData && path.join(process.env.ProgramData, 'Roblox', 'Versions'),
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
  const override = normalizePlayerPath(settings.robloxPath || '');
  if (override) {
    if (validatePath(override)) {
      return { found: true, playerPath: override, version: versionFromPath(override), source: 'manual', candidates: [override] };
    }
    // Invalid override is reported but we still try to auto-detect if allowed
    candidates.push(override + '  (invalid override: ' + pathStatus(override).reason + ')');
    if (settings.autoDetect === false) {
      return { found: false, playerPath: null, version: null, source: 'manual', candidates };
    }
  } else if ((settings.robloxPath || '').trim()) {
    const status = pathStatus(settings.robloxPath);
    candidates.push((settings.robloxPath || '').trim() + '  (invalid override: ' + status.reason + ')');
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

module.exports = { locate, validatePath, pathStatus, normalizePlayerPath, versionFromPath, PLAYER_EXE };
