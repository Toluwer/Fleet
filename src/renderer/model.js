'use strict';

/* Pure renderer helpers. The browser receives `window.FleetModel`; Node gets
   module.exports so the same parsing and validation logic is exercised by the
   headless self-test. */
(function exposeFleetModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FleetModel = api;
})(typeof window !== 'undefined' ? window : null, function createFleetModel() {
  const SERVER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
  const THEMES = new Set(['system', 'light', 'dark']);

  function decodedCandidates(value) {
    const candidates = [String(value == null ? '' : value).trim()];
    for (let i = 0; i < 2; i++) {
      try {
        const decoded = decodeURIComponent(candidates[candidates.length - 1]);
        if (!decoded || decoded === candidates[candidates.length - 1]) break;
        candidates.push(decoded);
      } catch (_) { break; }
    }
    return candidates;
  }

  /** Parse a bare place ID, Roblox game URL, protocol link, or exact-server
      deep link. Share-code-only URLs remain invalid because they contain no
      trustworthy place ID until Roblox resolves them. */
  function parseRobloxTarget(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { placeId: '', gameId: '', invalid: false };
    if (/^\d+$/.test(raw)) return { placeId: raw, gameId: '', invalid: false };

    const text = decodedCandidates(raw).join('\n');
    const place = text.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d+)/i)
      || text.match(/(?:^|[?&+\s])placeId=(\d+)/i)
      || text.match(/PlaceLauncher\.ashx[^\n]*?[?&]placeId=(\d+)/i);
    const namedServer = text.match(/(?:^|[?&+\s])(?:gameInstanceId|jobId|gameId)=([A-Za-z0-9-]{8,128})/i);
    const uuidServer = text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    const gameId = namedServer ? namedServer[1] : (uuidServer ? uuidServer[1] : '');
    const placeId = place ? place[1] : '';
    return { placeId, gameId: SERVER_ID_RE.test(gameId) ? gameId : '', invalid: !placeId };
  }

  function normalizeThemePreference(value) {
    const theme = String(value || '').toLowerCase();
    return THEMES.has(theme) ? theme : 'system';
  }

  function normalizeSessions(value) {
    const input = Array.isArray(value) ? value : [];
    const usedIds = new Set();
    const sessions = [];
    for (let index = 0; index < input.length; index++) {
      const item = input[index];
      if (!item || typeof item !== 'object' || !Array.isArray(item.accountIds)) continue;
      const accountIds = Array.from(new Set(item.accountIds
        .map(id => String(id == null ? '' : id).trim())
        .filter(Boolean))).slice(0, 20);
      if (!accountIds.length) continue;

      let id = String(item.id || `session-${index + 1}`).trim().slice(0, 80) || `session-${index + 1}`;
      while (usedIds.has(id)) id += '-copy';
      usedIds.add(id);

      const rawPlaceId = String(item.placeId == null ? '' : item.placeId).trim();
      const placeId = /^\d+$/.test(rawPlaceId) ? rawPlaceId : '';
      const rawGameId = String(item.gameId == null ? '' : item.gameId).trim();
      const gameId = placeId && SERVER_ID_RE.test(rawGameId) ? rawGameId : '';
      const name = String(item.name || '').trim().slice(0, 40) || `Session ${sessions.length + 1}`;
      sessions.push({ id, name, accountIds, placeId, gameId, arrange: item.arrange === true, keepAlive: item.keepAlive === true });
    }
    return sessions.slice(0, 100);
  }

  return { parseRobloxTarget, normalizeThemePreference, normalizeSessions };
});
