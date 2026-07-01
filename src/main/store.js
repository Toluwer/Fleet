'use strict';

/**
 * store.js — JSON persistence for settings, profiles and launch history.
 *
 * Files live under the app's userData directory:
 *   settings.json, profiles.json, history.json
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can never corrupt
 * an existing file. Reads are tolerant: a missing or malformed file falls back
 * to sensible defaults rather than throwing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = Object.freeze({
  robloxPath: '',            // manual override; empty = auto-detect
  autoDetect: true,
  pollIntervalMs: 2000,      // process monitor refresh
  launchDelayMs: 5000,       // delay between instances so each boots first
  confirmCleanup: true,      // confirm before "End all"
  warnInstanceCount: 6,      // soft warning threshold
  historyLimit: 200,
});

let baseDir = null;
let logger = { info() {}, warn() {}, error() {} };

function configure(dir, log) {
  baseDir = dir;
  if (log) logger = log;
  try { fs.mkdirSync(baseDir, { recursive: true }); } catch (_) {}
}

function fileFor(name) { return path.join(baseDir, name); }

function readJson(name, fallback) {
  try {
    const p = fileFor(name);
    if (!fs.existsSync(p)) return clone(fallback);
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return clone(fallback);
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Could not read ' + name + ', using defaults', err.message);
    // Back up the corrupt file so the user can inspect it
    try { fs.renameSync(fileFor(name), fileFor(name + '.corrupt')); } catch (_) {}
    return clone(fallback);
  }
}

function writeJson(name, data) {
  const p = fileFor(name);
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    logger.error('Failed to write ' + name, err.message);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* ----------------------------- Settings ----------------------------- */

function getSettings() {
  const s = readJson('settings.json', DEFAULT_SETTINGS);
  return normalizeSettings(s);
}

function normalizeSettings(input) {
  const s = Object.assign({}, DEFAULT_SETTINGS, input || {});
  s.robloxPath = typeof s.robloxPath === 'string' ? s.robloxPath : '';
  s.autoDetect = !!s.autoDetect;
  s.confirmCleanup = !!s.confirmCleanup;
  s.pollIntervalMs = clampInt(s.pollIntervalMs, 750, 10000, DEFAULT_SETTINGS.pollIntervalMs);
  s.launchDelayMs = clampInt(s.launchDelayMs, 0, 20000, DEFAULT_SETTINGS.launchDelayMs);
  s.warnInstanceCount = clampInt(s.warnInstanceCount, 1, 100, DEFAULT_SETTINGS.warnInstanceCount);
  s.historyLimit = clampInt(s.historyLimit, 10, 2000, DEFAULT_SETTINGS.historyLimit);
  return s;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function saveSettings(partial) {
  const merged = normalizeSettings(Object.assign({}, getSettings(), partial || {}));
  writeJson('settings.json', merged);
  return merged;
}

function resetSettings() {
  writeJson('settings.json', clone(DEFAULT_SETTINGS));
  return clone(DEFAULT_SETTINGS);
}

/* ----------------------------- Profiles ----------------------------- */

function getProfiles() {
  const list = readJson('profiles.json', []);
  if (!Array.isArray(list)) return [];
  return list.map(normalizeProfile).filter(Boolean);
}

function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const mode = p.launchMode === 'deeplink' ? 'deeplink' : 'client';
  return {
    id: p.id || newId(),
    name: String(p.name || 'Untitled').slice(0, 80),
    launchMode: mode,
    deeplink: mode === 'deeplink' ? String(p.deeplink || '') : '',
    count: clampInt(p.count, 1, 20, 1),
    notes: String(p.notes || '').slice(0, 500),
    createdAt: p.createdAt || new Date().toISOString(),
  };
}

/** Validate a profile coming from the UI. Returns { ok, errors, value }. */
function validateProfile(p) {
  const errors = [];
  const name = (p && typeof p.name === 'string') ? p.name.trim() : '';
  if (!name) errors.push('Name is required.');
  if (name.length > 80) errors.push('Name must be 80 characters or fewer.');
  const mode = p && p.launchMode === 'deeplink' ? 'deeplink' : 'client';
  let deeplink = '';
  if (mode === 'deeplink') {
    deeplink = (p && typeof p.deeplink === 'string') ? p.deeplink.trim() : '';
    if (!deeplink) {
      errors.push('A deep link is required for deep-link profiles.');
    } else if (!/^roblox(-player)?:/i.test(deeplink) && !/^https?:\/\//i.test(deeplink)) {
      errors.push('Deep link must start with roblox:, roblox-player: or http(s)://');
    }
  }
  const count = clampInt(p && p.count, 1, 20, 1);
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0
      ? normalizeProfile({ id: p.id, name, launchMode: mode, deeplink, count, notes: p.notes, createdAt: p.createdAt })
      : null,
  };
}

function saveProfile(p) {
  const result = validateProfile(p);
  if (!result.ok) return { ok: false, errors: result.errors };
  const list = getProfiles();
  const idx = list.findIndex(x => x.id === result.value.id);
  if (idx >= 0) list[idx] = result.value;
  else list.push(result.value);
  writeJson('profiles.json', list);
  return { ok: true, profile: result.value, profiles: list };
}

function deleteProfile(id) {
  const list = getProfiles().filter(p => p.id !== id);
  writeJson('profiles.json', list);
  return list;
}

/* ----------------------------- History ----------------------------- */

function getHistory() {
  const list = readJson('history.json', []);
  return Array.isArray(list) ? list : [];
}

function addHistory(entry) {
  const list = getHistory();
  const settings = getSettings();
  list.unshift({
    time: new Date().toISOString(),
    profileName: entry.profileName || 'Quick launch',
    mode: entry.mode || 'client',
    result: entry.result || 'launched',
    pid: entry.pid || null,
    message: entry.message || '',
  });
  while (list.length > settings.historyLimit) list.pop();
  writeJson('history.json', list);
  return list;
}

function clearHistory() {
  writeJson('history.json', []);
  return [];
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  DEFAULT_SETTINGS,
  configure,
  getSettings, saveSettings, resetSettings, normalizeSettings,
  getProfiles, saveProfile, deleteProfile, validateProfile,
  getHistory, addHistory, clearHistory,
  newId,
};
