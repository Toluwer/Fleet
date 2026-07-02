'use strict';

/**
 * playtime.js — playtime analytics from the presence stream.
 *
 * The account poller already learns, every ~12s, whether each account is in a
 * game and which one. observe() turns those observations into sessions
 * (start/end/duration per account per game) persisted in playtime.json, and
 * stats() aggregates them per game / per account for today, the last 7 days
 * and all time. Live (still-running) sessions are included in stats.
 *
 * Sessions shorter than 30s are discarded as presence blips. The file is
 * capped at the most recent 5000 sessions.
 */

const FILE = 'playtime.json';
let store = null;
let logger = { info() {}, warn() {}, error() {} };

// userId -> { placeId, name, username, start, lastSeen }
const active = new Map();

function configure(opts) {
  store = opts.store;
  if (opts.logger) logger = opts.logger;
}

function load() {
  try { const d = store.readJson(FILE, { sessions: [] }); return d && Array.isArray(d.sessions) ? d : { sessions: [] }; }
  catch (_) { return { sessions: [] }; }
}
function save(data) { try { store.writeJson(FILE, data); } catch (err) { logger.warn('Playtime save failed', err && err.message); } }

function endSession(userId, cur) {
  active.delete(userId);
  const ms = Math.max(0, (cur.lastSeen || Date.now()) - cur.start);
  if (ms < 30000) return; // presence blip, not a play session
  const data = load();
  data.sessions.push({
    userId, username: cur.username || String(userId),
    placeId: cur.placeId || null, game: cur.name,
    start: cur.start, end: cur.start + ms, ms,
  });
  if (data.sessions.length > 5000) data.sessions = data.sessions.slice(-5000);
  save(data);
}

/** Feed one poller observation. status is the presence label ('In game' etc). */
function observe(userId, username, status, game) {
  if (!userId) return;
  const now = Date.now();
  const inGame = status === 'In game' && game && game.name;
  const cur = active.get(userId);
  if (inGame) {
    if (cur && cur.name === game.name) { cur.lastSeen = now; return; }
    if (cur) endSession(userId, cur);
    active.set(userId, {
      placeId: game.placeId || game.rootPlaceId || null,
      name: game.name, username, start: now, lastSeen: now,
    });
  } else if (cur) {
    endSession(userId, cur);
  }
}

/** Close all open sessions (app quit). */
function flush() {
  for (const [id, cur] of Array.from(active.entries())) endSession(id, cur);
}

function fmtWindowSum(sessions, from) {
  let n = 0;
  for (const s of sessions) n += Math.max(0, s.end - Math.max(s.start, from));
  return n;
}

function stats() {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const day = dayStart.getTime();
  const week = now - 7 * 86400000;

  const live = Array.from(active.entries()).map(([userId, c]) => ({
    userId, username: c.username || String(userId), placeId: c.placeId,
    game: c.name, start: c.start, end: now, ms: now - c.start, live: true,
  }));
  const all = load().sessions.concat(live);

  const aggregate = (keyOf, labelOf) => {
    const m = new Map();
    for (const s of all) {
      const k = keyOf(s);
      if (!k) continue;
      const e = m.get(k) || { key: k, label: labelOf(s), todayMs: 0, weekMs: 0, totalMs: 0, sessions: 0, live: false, placeId: s.placeId || null };
      e.todayMs += Math.max(0, s.end - Math.max(s.start, day));
      e.weekMs += Math.max(0, s.end - Math.max(s.start, week));
      e.totalMs += s.ms;
      e.sessions += 1;
      if (s.live) e.live = true;
      if (s.placeId) e.placeId = s.placeId;
      m.set(k, e);
    }
    return Array.from(m.values()).sort((a, b) => b.totalMs - a.totalMs);
  };

  return {
    ok: true,
    tracking: active.size,
    totals: {
      todayMs: fmtWindowSum(all, day),
      weekMs: fmtWindowSum(all, week),
      totalMs: all.reduce((n, s) => n + s.ms, 0),
      sessions: all.length,
    },
    perGame: aggregate(s => s.game, s => s.game).slice(0, 40),
    perAccount: aggregate(s => s.userId, s => s.username),
    recent: all.slice(-12).reverse(),
  };
}

function clear() { save({ sessions: [] }); active.clear(); return { ok: true }; }

module.exports = { configure, observe, flush, stats, clear };
