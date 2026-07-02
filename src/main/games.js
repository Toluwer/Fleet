'use strict';

/**
 * games.js — browse and search Roblox experiences via public APIs.
 *
 *   browse() : explore-api get-sorts  (popular, no auth, no query)
 *   search() : search-api omni-search (keyword + pageToken pagination)
 *
 * Both return normalized games carrying the **rootPlaceId** (used for joining —
 * never the universeId) plus name, live player count, votes and a thumbnail
 * URL (from the thumbnails API; the renderer loads it directly, CSP allows
 * *.rbxcdn.com). Errors are surfaced, not swallowed.
 */

const crypto = require('crypto');
const SERVER_FETCH_TIMEOUT_MS = 12000;

let logger = { info() {}, warn() {}, error() {} };
function configure(opts) { if (opts && opts.logger) logger = opts.logger; }

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

function normalize(c) {
  const place = c.rootPlaceId || c.placeId || null;
  return {
    universeId: c.universeId || null,
    placeId: place,
    name: c.name || 'Untitled',
    playerCount: c.playerCount != null ? c.playerCount : (c.playing != null ? c.playing : 0),
    upVotes: c.totalUpVotes != null ? c.totalUpVotes : null,
    downVotes: c.totalDownVotes != null ? c.totalDownVotes : null,
    creator: c.creatorName || (c.creator && c.creator.name) || '',
    thumbnail: null,
    categories: [],
  };
}

function dedupe(games) {
  const seen = new Set();
  const out = [];
  for (const g of games) {
    if (!g.universeId || !g.placeId || seen.has(g.universeId)) continue;
    seen.add(g.universeId);
    out.push(g);
  }
  return out;
}

async function fetchThumbnails(universeIds) {
  const map = new Map();
  for (let i = 0; i < universeIds.length; i += 100) {
    const batch = universeIds.slice(i, i + 100);
    try {
      const r = await fetch(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${batch.join(',')}&size=768x432&format=Png&countPerUniverse=1&defaults=true`);
      if (!r.ok) continue;
      const j = await r.json();
      for (const d of (j.data || [])) {
        const t = d.thumbnails && d.thumbnails[0];
        if (t && t.imageUrl) map.set(d.universeId, t.imageUrl);
      }
    } catch (_) { /* thumbnails are best-effort */ }
  }
  return map;
}

async function withThumbnails(games) {
  const ids = games.map(g => g.universeId).filter(Boolean);
  const thumbs = await fetchThumbnails(ids);
  for (const g of games) g.thumbnail = thumbs.get(g.universeId) || null;
  return games;
}

/** Popular experiences (no query). */
async function browse() {
  try {
    const r = await fetch(`https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${uuid()}`, { headers: { Accept: 'application/json' } });
    if (r.status === 429) return { ok: false, error: 'Roblox is rate-limiting — try again shortly.' };
    if (!r.ok) return { ok: false, error: 'Discovery unavailable (HTTP ' + r.status + ').' };
    const j = await r.json();
    // Keep each game's originating sort(s) so the UI can offer a category filter.
    const byId = new Map();  // universeId -> normalized game (with categories[])
    const categories = [];   // ordered category display names that carried games
    for (const sort of (j.sorts || [])) {
      if (sort.contentType && sort.contentType !== 'Games') continue;
      const label = (sort.sortDisplayName || '').trim();
      // The game list lives under a per-sort key; find the array of game objects.
      const arr = Object.keys(sort).map(k => sort[k]).find(v => Array.isArray(v) && v[0] && (v[0].universeId || v[0].rootPlaceId));
      if (!arr || !arr.length) continue;
      if (label && !categories.includes(label)) categories.push(label);
      for (const raw of arr) {
        const g = normalize(raw);
        if (!g.universeId || !g.placeId) continue;
        const existing = byId.get(g.universeId);
        if (existing) { if (label && !existing.categories.includes(label)) existing.categories.push(label); }
        else { g.categories = label ? [label] : []; byId.set(g.universeId, g); }
      }
    }
    const games = Array.from(byId.values()).sort((a, b) => (b.playerCount || 0) - (a.playerCount || 0)).slice(0, 120);
    await withThumbnails(games);
    logger.info('Games browse: ' + games.length + ' experiences, ' + categories.length + ' categories');
    return { ok: true, games, categories, nextPageToken: null };
  } catch (err) {
    logger.warn('Games browse failed', err && err.message);
    return { ok: false, error: (err && err.message) || 'Network error.' };
  }
}

/** Keyword search with pagination (omni-search nextPageToken). */
async function search(query, pageToken) {
  const q = (query || '').trim();
  if (!q) return browse();
  try {
    const u = new URL('https://apis.roblox.com/search-api/omni-search');
    u.searchParams.set('searchQuery', q);
    u.searchParams.set('sessionId', uuid());
    u.searchParams.set('pageType', 'Games');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u.toString());
    if (r.status === 429) return { ok: false, error: 'Roblox is rate-limiting — try again shortly.' };
    if (!r.ok) return { ok: false, error: 'Search unavailable (HTTP ' + r.status + ').' };
    const j = await r.json();
    let games = (j.searchResults || [])
      .flatMap(s => s.contents || [])
      .filter(c => c.universeId && c.rootPlaceId)
      .map(normalize);
    games = dedupe(games);
    await withThumbnails(games);
    return { ok: true, games, nextPageToken: j.nextPageToken || null };
  } catch (err) {
    logger.warn('Games search failed', err && err.message);
    return { ok: false, error: (err && err.message) || 'Network error.' };
  }
}

async function serversPage(pid, sortOrder, cursor, excludeFullGames) {
  const u = new URL(`https://games.roblox.com/v1/games/${pid}/servers/Public`);
  u.searchParams.set('sortOrder', sortOrder === 'Desc' ? 'Desc' : 'Asc');
  u.searchParams.set('excludeFullGames', excludeFullGames ? 'true' : 'false');
  u.searchParams.set('limit', '100');
  if (cursor) u.searchParams.set('cursor', cursor);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' }, signal: controller.signal });
    const j = r.ok ? await r.json() : null;
    return {
      status: r.status,
      rateLimited: r.status === 429,
      data: (j && j.data) || [],
      nextPageCursor: (j && j.nextPageCursor) || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizedServer(s) {
  if (!s || !s.id) return null;
  const playing = Math.max(0, Number(s.playing) || 0);
  const maxPlayers = Math.max(0, Number(s.maxPlayers) || 0);
  if (maxPlayers <= playing) return null;
  return {
    id: String(s.id), playing, maxPlayers,
    fps: s.fps != null && Number.isFinite(Number(s.fps)) ? Math.round(Number(s.fps)) : null,
    ping: s.ping != null && Number.isFinite(Number(s.ping)) ? Math.round(Number(s.ping)) : null,
  };
}

function mergeServers(target, rows) {
  for (const row of (rows || [])) {
    const server = normalizedServer(row);
    if (server && !target.has(server.id)) target.set(server.id, server);
  }
}

async function scanServers(placeId, pageLimit) {
  const pid = String(placeId == null ? '' : placeId).trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: 'Invalid place id.' };
  const limit = Math.max(1, Math.min(12, Number(pageLimit) || 6));
  const byId = new Map();
  let cursor = null;
  let pagesScanned = 0;
  let examined = 0;
  let rateLimited = false;
  let complete = false;
  let strategy = 'joinable-first';

  try {
    for (let page = 0; page < limit; page += 1) {
      const result = await serversPage(pid, 'Desc', cursor, true);
      pagesScanned += 1;
      examined += result.data.length;
      rateLimited = rateLimited || result.rateLimited;
      mergeServers(byId, result.data);
      cursor = result.nextPageCursor;
      if (!cursor || result.rateLimited || result.status >= 400) { complete = !cursor; break; }
    }

    // Roblox sometimes returns no data for excludeFullGames. Walk past full
    // descending pages so busy-but-open servers still surface.
    if (!byId.size && !rateLimited) {
      strategy = 'full-page-fallback';
      cursor = null;
      complete = false;
      for (let page = 0; page < limit; page += 1) {
        const result = await serversPage(pid, 'Desc', cursor, false);
        pagesScanned += 1;
        examined += result.data.length;
        rateLimited = rateLimited || result.rateLimited;
        mergeServers(byId, result.data);
        cursor = result.nextPageCursor;
        if (!cursor || result.rateLimited || result.status >= 400) { complete = !cursor; break; }
      }
    }

    return {
      ok: true,
      servers: Array.from(byId.values()).slice(0, 300),
      scan: { pagesScanned, examined, rateLimited, complete, strategy },
    };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    logger.warn('Deep server scan failed', timedOut ? 'timeout' : err && err.message);
    return { ok: false, error: timedOut ? 'Server scan timed out. Try again.' : ((err && err.message) || 'Network error.') };
  }
}

/**
 * Public server list for a place, filtered to **joinable** servers (has a free
 * slot). We merge one Ascending page (emptiest-first — guarantees open servers
 * and carries ping; also returns data for games where Descending returns none)
 * with one Descending page (fullest-first — surfaces busy-but-open servers), so
 * the pool spans wide-open to nearly-full. On "load more" we page only through
 * the Ascending order (progressively fuller servers).
 */
async function servers(placeId, cursor) {
  const pid = String(placeId == null ? '' : placeId).trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: 'Invalid place id.' };
  try {
    const [asc, busy] = await Promise.all([
      serversPage(pid, 'Asc', cursor, false),
      cursor ? Promise.resolve(null) : scanServers(pid, 2),
    ]);
    if (asc.rateLimited) return { ok: false, error: 'Roblox is rate-limiting — try again shortly.' };
    const byId = new Map();
    mergeServers(byId, asc.data);
    let scan = null;
    if (busy && busy.ok) {
      mergeServers(byId, busy.servers);
      scan = busy.scan;
    }
    const list = Array.from(byId.values());
    if (!list.length && asc.status && asc.status >= 400) return { ok: false, error: 'Servers unavailable (HTTP ' + asc.status + ').' };
    return { ok: true, servers: list, nextPageCursor: asc.nextPageCursor, scan };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'Server list timed out. Try again.' };
    logger.warn('Server list failed', err && err.message);
    return { ok: false, error: (err && err.message) || 'Network error.' };
  }
}

module.exports = { configure, browse, search, servers, scanServers, normalizedServer };
