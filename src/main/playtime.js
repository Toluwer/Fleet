'use strict';

/**
 * Crash-safe playtime analytics from the account presence stream.
 *
 * Completed sessions and live checkpoints share one atomic JSON document.
 * A restart finalizes each checkpoint through its last confirmed observation,
 * then removes it in the same write. This preserves force-quit data without
 * counting offline time or duplicating a recovered session.
 */

const FILE = 'playtime.json';
const VERSION = 2;
const MIN_SESSION_MS = 30000;
const MAX_SESSIONS = 5000;
const CHECKPOINT_DELAY_MS = 75;
const FRESH_OBSERVATION_MS = 45000;

let store = null;
let logger = { info() {}, warn() {}, error() {} };
let now = () => Date.now();
let checkpointTimer = null;

// String(userId) -> { userId, placeId, name, username, start, lastSeen }
const active = new Map();

function emptyDocument() { return { version: VERSION, sessions: [], active: {} }; }

function normalizeDocument(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    version: VERSION,
    sessions: Array.isArray(input.sessions) ? input.sessions.filter(validSession).slice(-MAX_SESSIONS) : [],
    active: input.active && typeof input.active === 'object' && !Array.isArray(input.active) ? input.active : {},
  };
}

function validSession(session) {
  return !!session && Number.isFinite(Number(session.start)) && Number.isFinite(Number(session.end))
    && Number(session.end) >= Number(session.start) && Number(session.ms) >= 0;
}

function configure(opts) {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = null;
  active.clear();
  store = opts.store;
  if (opts.logger) logger = opts.logger;
  now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  recoverCheckpoints();
}

function load() {
  try { return normalizeDocument(store.readJson(FILE, emptyDocument())); }
  catch (_) { return emptyDocument(); }
}

function save(data) {
  try {
    if (store.writeJson(FILE, normalizeDocument(data)) === false) throw new Error('Atomic write was not completed.');
    return true;
  } catch (err) {
    logger.warn('Playtime save failed', err && err.message);
    return false;
  }
}

function activeObject() {
  const out = {};
  for (const [id, session] of active) out[id] = Object.assign({}, session);
  return out;
}

function appendCompleted(data, cur, end, recovered) {
  const start = Number(cur.start) || 0;
  const safeEnd = Math.max(start, Number(end) || start);
  const ms = safeEnd - start;
  if (ms < MIN_SESSION_MS) return false;
  data.sessions.push({
    userId: cur.userId,
    username: cur.username || String(cur.userId),
    placeId: cur.placeId || null,
    game: cur.name,
    start,
    end: safeEnd,
    ms,
    ...(recovered ? { recovered: true } : {}),
  });
  if (data.sessions.length > MAX_SESSIONS) data.sessions = data.sessions.slice(-MAX_SESSIONS);
  return true;
}

function recoverCheckpoints() {
  const data = load();
  const checkpoints = Object.values(data.active || {});
  if (!checkpoints.length) return;
  let recovered = 0;
  for (const cur of checkpoints) {
    if (!cur || !cur.name) continue;
    const end = Math.min(now(), Number(cur.lastSeen) || Number(cur.start) || 0);
    if (appendCompleted(data, cur, end, true)) recovered++;
  }
  data.active = {};
  save(data);
  if (recovered) logger.info(`Recovered ${recovered} playtime session${recovered === 1 ? '' : 's'} after an interrupted exit.`);
}

function checkpointNow() {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = null;
  const data = load();
  data.active = activeObject();
  save(data);
}

function scheduleCheckpoint() {
  if (checkpointTimer) return;
  checkpointTimer = setTimeout(checkpointNow, CHECKPOINT_DELAY_MS);
  if (checkpointTimer.unref) checkpointTimer.unref();
}

function endSession(userId, cur, endAt) {
  active.delete(String(userId));
  const data = load();
  appendCompleted(data, cur, Number(endAt) || now(), false);
  data.active = activeObject();
  save(data);
}

/** Feed one poller observation. status is the presence label ('In game' etc). */
function observe(userId, username, status, game) {
  if (!userId) return;
  const id = String(userId);
  const at = now();
  const inGame = status === 'In game' && game && game.name;
  const cur = active.get(id);
  if (inGame) {
    const placeId = game.placeId || game.rootPlaceId || null;
    if (cur && cur.name === game.name && String(cur.placeId || '') === String(placeId || '')) {
      cur.lastSeen = at;
      cur.username = username || cur.username;
      scheduleCheckpoint();
      return;
    }
    if (cur) endSession(id, cur, at);
    active.set(id, { userId, placeId, name: game.name, username, start: at, lastSeen: at });
    scheduleCheckpoint();
  } else if (cur) {
    endSession(id, cur, at);
  }
}

/** Close every open session in one atomic transaction during a normal quit. */
function flush() {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = null;
  const data = load();
  const at = now();
  for (const cur of active.values()) {
    const lastSeen = Number(cur.lastSeen) || Number(cur.start) || at;
    const end = at - lastSeen <= FRESH_OBSERVATION_MS ? at : lastSeen;
    appendCompleted(data, cur, end, false);
  }
  active.clear();
  data.active = {};
  save(data);
}

function fmtWindowSum(sessions, from) {
  let total = 0;
  for (const session of sessions) total += Math.max(0, session.end - Math.max(session.start, from));
  return total;
}

/** Overlap of one session with a [from, to) window, clamped at zero. */
function overlapMs(session, from, to) {
  return Math.max(0, Math.min(session.end, to) - Math.max(session.start, from));
}

/**
 * Per-day playtime for the last `days` calendar days (local time, oldest
 * first): [{ start, ms }]. Sessions spanning midnight are split correctly.
 */
function dailyTotals(sessions, days, at) {
  const base = new Date(at);
  base.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(base);
    start.setDate(base.getDate() - i);
    const from = start.getTime();
    const to = from + 86400000;
    let ms = 0;
    for (const session of sessions) ms += overlapMs(session, from, to);
    out.push({ start: from, ms });
  }
  return out;
}

/**
 * Which hours of the day the playing happens (local time): 24 buckets of
 * played milliseconds. Long sessions are attributed hour-slice by hour-slice
 * so an all-nighter lands in every bucket it actually touched.
 */
function hourHistogram(sessions) {
  const buckets = new Array(24).fill(0);
  for (const session of sessions) {
    let cursor = Number(session.start) || 0;
    const end = Number(session.end) || cursor;
    while (cursor < end) {
      const boundary = Math.floor(cursor / 3600000) * 3600000 + 3600000;
      const segEnd = Math.min(end, boundary);
      buckets[new Date(cursor).getHours()] += segEnd - cursor;
      cursor = segEnd;
    }
  }
  return buckets;
}

function stats() {
  const at = now();
  const dayStart = new Date(at); dayStart.setHours(0, 0, 0, 0);
  const day = dayStart.getTime();
  const week = at - 7 * 86400000;
  const live = Array.from(active.values()).map(cur => ({
    userId: cur.userId,
    username: cur.username || String(cur.userId),
    placeId: cur.placeId,
    game: cur.name,
    start: cur.start,
    end: at,
    ms: Math.max(0, at - cur.start),
    live: true,
  }));
  const all = load().sessions.concat(live);

  const aggregate = (keyOf, labelOf) => {
    const rows = new Map();
    for (const session of all) {
      const key = keyOf(session);
      if (!key) continue;
      const row = rows.get(key) || { key, label: labelOf(session), todayMs: 0, weekMs: 0, totalMs: 0, sessions: 0, live: false, placeId: session.placeId || null };
      row.todayMs += Math.max(0, session.end - Math.max(session.start, day));
      row.weekMs += Math.max(0, session.end - Math.max(session.start, week));
      row.totalMs += session.ms;
      row.sessions += 1;
      if (session.live) row.live = true;
      if (session.placeId) row.placeId = session.placeId;
      rows.set(key, row);
    }
    return Array.from(rows.values()).sort((a, b) => b.totalMs - a.totalMs);
  };

  // Advanced slice: 14-day trend, hour-of-day habits, session-quality facts.
  const daily = dailyTotals(all, 14, at);
  let longest = null;
  for (const session of all) if (!longest || session.ms > longest.ms) longest = session;
  const hours = hourHistogram(all);
  let peakHour = -1;
  for (let h = 0; h < 24; h++) if (hours[h] > (peakHour < 0 ? -1 : hours[peakHour])) peakHour = h;
  let busiestDay = null;
  for (const d of daily) if (!busiestDay || d.ms > busiestDay.ms) busiestDay = d;
  const insights = {
    avgMs: all.length ? all.reduce((sum, session) => sum + session.ms, 0) / all.length : 0,
    longestMs: longest ? longest.ms : 0,
    longestGame: longest ? (longest.game || '') : '',
    longestUser: longest ? (longest.username || '') : '',
    peakHour: peakHour >= 0 && hours[peakHour] > 0 ? peakHour : null,
    peakHourMs: peakHour >= 0 ? hours[peakHour] : 0,
    busiestDayStart: busiestDay && busiestDay.ms > 0 ? busiestDay.start : null,
    busiestDayMs: busiestDay ? busiestDay.ms : 0,
  };

  return {
    ok: true,
    tracking: active.size,
    totals: {
      todayMs: fmtWindowSum(all, day),
      weekMs: fmtWindowSum(all, week),
      totalMs: all.reduce((sum, session) => sum + session.ms, 0),
      sessions: all.length,
    },
    daily,
    insights,
    perGame: aggregate(session => session.game, session => session.game).slice(0, 40),
    perAccount: aggregate(session => session.userId, session => session.username),
    recent: all.slice(-12).reverse(),
  };
}

function clear() {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = null;
  active.clear();
  save(emptyDocument());
  return { ok: true };
}

module.exports = { configure, observe, flush, stats, clear, checkpointNow, dailyTotals, hourHistogram };
