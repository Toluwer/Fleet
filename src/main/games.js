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
    let games = [];
    for (const sort of (j.sorts || [])) {
      // The game list lives under a per-sort key; find the array of game objects.
      const arr = Object.keys(sort).map(k => sort[k]).find(v => Array.isArray(v) && v[0] && (v[0].universeId || v[0].rootPlaceId));
      if (arr) for (const g of arr) games.push(normalize(g));
    }
    games = dedupe(games).sort((a, b) => (b.playerCount || 0) - (a.playerCount || 0)).slice(0, 60);
    await withThumbnails(games);
    logger.info('Games browse: ' + games.length + ' experiences');
    return { ok: true, games, nextPageToken: null };
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

/** Public server list for a place (join a specific server). */
async function servers(placeId, cursor) {
  const pid = String(placeId == null ? '' : placeId).trim();
  if (!/^\d+$/.test(pid)) return { ok: false, error: 'Invalid place id.' };
  try {
    const u = new URL(`https://games.roblox.com/v1/games/${pid}/servers/Public`);
    u.searchParams.set('sortOrder', 'Desc');
    u.searchParams.set('excludeFullGames', 'false');
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u.toString());
    if (r.status === 429) return { ok: false, error: 'Roblox is rate-limiting — try again shortly.' };
    if (!r.ok) return { ok: false, error: 'Servers unavailable (HTTP ' + r.status + ').' };
    const j = await r.json();
    const list = (j.data || []).map(s => ({
      id: s.id,
      playing: s.playing || 0,
      maxPlayers: s.maxPlayers || 0,
      fps: s.fps != null ? Math.round(s.fps) : null,
      ping: s.ping != null ? s.ping : null,
    }));
    return { ok: true, servers: list, nextPageCursor: j.nextPageCursor || null };
  } catch (err) {
    logger.warn('Server list failed', err && err.message);
    return { ok: false, error: (err && err.message) || 'Network error.' };
  }
}

module.exports = { configure, browse, search, servers };
