'use strict';

/**
 * accounts.js — Roblox account management.
 *
 * Adding an account opens a real Roblox login window; once the user signs in we
 * capture the session cookie (.ROBLOSECURITY) from that window's isolated
 * session, look up the profile + avatar + presence, and store the cookie
 * **encrypted at rest** via Electron's safeStorage (DPAPI on Windows). The
 * cookie never leaves the main process or reaches the renderer.
 *
 * Launching "as an account" mints a single-use authentication ticket from the
 * cookie and hands it to the Roblox client (the same mechanism the official
 * site uses when you press Play) so the client starts already signed in.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let baseDir = null;
let safeStorage = null;
let BrowserWindow = null;
let sessionApi = null;
let logger = { info() {}, warn() {}, error() {} };

function configure(opts) {
  baseDir = opts.baseDir;
  safeStorage = opts.safeStorage;
  BrowserWindow = opts.BrowserWindow;
  sessionApi = opts.session;
  if (opts.logger) logger = opts.logger;
}

function file() { return path.join(baseDir, 'accounts.json'); }

/* ----------------------------- Storage ----------------------------- */

function readRaw() {
  try {
    const p = file();
    if (!fs.existsSync(p)) return [];
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    logger.warn('accounts.json unreadable', err.message);
    return [];
  }
}

function writeRaw(list) {
  const p = file();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    logger.error('Failed to write accounts.json', err.message);
    return false;
  }
}

function encryptCookie(cookie) {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(cookie).toString('base64');
    }
  } catch (_) {}
  return 'b64:' + Buffer.from(cookie, 'utf8').toString('base64');
}

function decryptCookie(stored) {
  try {
    if (!stored) return null;
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
  } catch (err) {
    logger.warn('Cookie decrypt failed', err.message);
  }
  return null;
}

/** Strip secrets — only this shape is ever sent to the renderer. */
function sanitize(a) {
  return {
    id: a.id,
    userId: a.userId,
    username: a.username,
    displayName: a.displayName,
    avatar: a.avatar || null,
    presence: a.presence || 'Offline',
    presenceError: a.presenceError || null,
    sessionExpired: !!a.sessionExpired,
    game: a.game || null,            // { name, placeId, rootPlaceId, gameId } when in a game
    addedAt: a.addedAt,
  };
}

/** Turn a presence record into a compact "current game" object (or null). */
function gameFromPresence(p) {
  if (!p || p.status !== 'In game') return null;
  return {
    name: p.lastLocation || 'In an experience',
    placeId: p.placeId || null,
    rootPlaceId: p.rootPlaceId || null,
    gameId: p.gameId || null,
  };
}

function sameGame(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.name === b.name && String(a.placeId) === String(b.placeId);
}

function list() { return readRaw().map(sanitize); }

/* ----------------------------- Roblox API ----------------------------- */

function authHeaders(cookie, extra) {
  return Object.assign({
    'Cookie': '.ROBLOSECURITY=' + cookie,
    'User-Agent': 'Roblox/WinInet',
    'Referer': 'https://www.roblox.com/',
  }, extra || {});
}

async function getAuthenticatedUser(cookie) {
  try {
    const res = await fetch('https://users.roblox.com/v1/users/authenticated', { headers: authHeaders(cookie) });
    if (!res.ok) return null;
    return await res.json(); // { id, name, displayName }
  } catch (_) { return null; }
}

/** Retry getAuthenticatedUser a few times (the cookie can lag right after login). */
async function getAuthenticatedUserRetry(cookie, tries) {
  for (let i = 0; i < (tries || 3); i++) {
    const u = await getAuthenticatedUser(cookie);
    if (u && u.id) return u;
    await new Promise(r => setTimeout(r, 600));
  }
  return null;
}

async function getAvatar(userId) {
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    const j = await res.json();
    const url = j && j.data && j.data[0] && j.data[0].imageUrl;
    if (!url) return null;
    const img = await fetch(url);
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (_) { return null; }
}

const PRESENCE_MAP = { 0: 'Offline', 1: 'Online', 2: 'In game', 3: 'In Studio', 4: 'Offline' };

/**
 * Real presence via the Roblox Presence API. Returns
 * { status, error?, placeId?, rootPlaceId?, gameId?, universeId? }. Handles the CSRF challenge and
 * rate-limits so status never silently fails (errors are surfaced).
 */
async function getPresence(userId, cookie) {
  const url = 'https://presence.roblox.com/v1/presence/users';
  const body = JSON.stringify({ userIds: [Number(userId)] });
  const send = (extra) => fetch(url, {
    method: 'POST',
    headers: authHeaders(cookie, Object.assign({ 'Content-Type': 'application/json' }, extra)),
    body,
  });
  try {
    let res = await send();
    if (res.status === 403) {
      const csrf = res.headers.get('x-csrf-token');
      if (csrf) res = await send({ 'X-CSRF-TOKEN': csrf });
    }
    if (res.status === 429) return { status: 'Unknown', error: 'Rate limited — try again shortly' };
    if (res.status === 401) return { status: 'Unknown', error: 'Session expired', expired: true };
    if (!res.ok) return { status: 'Unknown', error: 'HTTP ' + res.status };
    const j = await res.json();
    const p = j && j.userPresences && j.userPresences[0];
    if (!p) return { status: 'Offline' };
    return presenceFromRecord(p);
  } catch (err) {
    return { status: 'Unknown', error: (err && err.message) || 'network error' };
  }
}

/** Map one Roblox presence record into our shape. */
function presenceFromRecord(p) {
  // Roblox uses `userPresenceType` (the old `presenceType` was always undefined).
  const t = (p.userPresenceType != null ? p.userPresenceType : p.presenceType);
  return {
    status: PRESENCE_MAP[t] || 'Offline',
    lastLocation: p.lastLocation || null,
    placeId: p.placeId || null,
    rootPlaceId: p.rootPlaceId || null,
    gameId: p.gameId || null,
    universeId: p.universeId || null,
  };
}

/** Batch presence for many users in ONE request (used by People + diff polling). */
async function getPresenceBatch(userIds, cookie) {
  if (!userIds || !userIds.length) return new Map();
  const url = 'https://presence.roblox.com/v1/presence/users';
  const body = JSON.stringify({ userIds: userIds.map(Number) });
  const send = (extra) => fetch(url, {
    method: 'POST',
    headers: authHeaders(cookie, Object.assign({ 'Content-Type': 'application/json' }, extra)),
    body,
  });
  const out = new Map();
  try {
    let res = await send();
    if (res.status === 403) {
      const csrf = res.headers.get('x-csrf-token');
      if (csrf) res = await send({ 'X-CSRF-TOKEN': csrf });
    }
    if (!res.ok) return out;
    const j = await res.json();
    for (const p of (j.userPresences || [])) out.set(p.userId, presenceFromRecord(p));
  } catch (_) {}
  return out;
}

/** Mint a single-use authentication ticket for launching. */
async function getAuthTicket(cookie) {
  try {
    const url = 'https://auth.roblox.com/v1/authentication-ticket';
    // First call returns 403 + the CSRF token to use.
    let res = await fetch(url, { method: 'POST', headers: authHeaders(cookie, { 'Content-Type': 'application/json' }) });
    let csrf = res.headers.get('x-csrf-token');
    if (!csrf) return null;
    res = await fetch(url, { method: 'POST', headers: authHeaders(cookie, { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf }) });
    return res.headers.get('rbx-authentication-ticket') || null;
  } catch (_) { return null; }
}

function normalizePlaceId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^\d+$/.test(id) ? id : null;
}

function normalizeGameInstanceId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(id) ? id : null;
}

/** Build the protocol launch string for an authenticated client. */
function buildLaunchUrl(ticket, placeId, gameInstanceId) {
  const t = Date.now();
  if (placeId) {
    const pid = normalizePlaceId(placeId);
    if (!pid) return null;
    const gid = gameInstanceId ? normalizeGameInstanceId(gameInstanceId) : null;
    if (gameInstanceId && !gid) return null;
    const params = new URLSearchParams({
      request: gid ? 'RequestGameJob' : 'RequestGame',
      browserTrackerId: '0',
      placeId: pid,
      isPlayTogetherGame: 'false',
    });
    if (gid) params.set('gameId', gid);
    const pl = encodeURIComponent(`https://assetgame.roblox.com/game/PlaceLauncher.ashx?${params.toString()}`);
    return `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${t}+placelauncherurl:${pl}+browsertrackerid:0+robloxLocale:en_us+gameLocale:en_us+channel:`;
  }
  return `roblox-player:1+launchmode:app+gameinfo:${ticket}+launchtime:${t}+robloxLocale:en_us+gameLocale:en_us+channel:`;
}

/**
 * Build Roblox's official "follow user" launch request. Roblox evaluates the
 * selected account's join permission at launch time, so this also supports
 * non-friends whose privacy setting allows everyone to join.
 */
function buildFollowUserLaunchUrl(ticket, targetUserId) {
  const uid = Number(targetUserId);
  if (!ticket || !Number.isSafeInteger(uid) || uid <= 0) return null;
  const t = Date.now();
  const params = new URLSearchParams({
    request: 'RequestFollowUser',
    browserTrackerId: '0',
    userId: String(uid),
    isPlayTogetherGame: 'false',
  });
  const pl = encodeURIComponent(`https://assetgame.roblox.com/game/PlaceLauncher.ashx?${params.toString()}`);
  return `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${t}+placelauncherurl:${pl}+browsertrackerid:0+robloxLocale:en_us+gameLocale:en_us+channel:`;
}

/**
 * Returns a ready-to-launch deep link for the given account, or
 * { ok:false, reason }.  placeId is optional (joins that experience).
 */
async function getLaunchInfo(accountId, placeId, gameInstanceId) {
  const raw = readRaw().find(a => a.id === accountId);
  if (!raw) return { ok: false, reason: 'Account not found.' };
  const cookie = decryptCookie(raw.cookie);
  if (!cookie) return { ok: false, reason: 'Stored session could not be read.' };
  const ticket = await getAuthTicket(cookie);
  if (!ticket) return { ok: false, reason: 'Session expired — sign in again.' };
  const deeplink = buildLaunchUrl(ticket, placeId, gameInstanceId);
  if (!deeplink) return { ok: false, reason: 'The game or server identifier is invalid.' };
  return { ok: true, deeplink, username: raw.username };
}

/** Mint a ticket and let Roblox follow a user with this selected account. */
async function getPersonJoinLaunchInfo(accountId, targetUserId) {
  const raw = readRaw().find(a => a.id === accountId);
  if (!raw) return { ok: false, reason: 'Account not found.' };
  const cookie = decryptCookie(raw.cookie);
  if (!cookie) return { ok: false, reason: 'Stored session could not be read.' };
  const deeplink = buildFollowUserLaunchUrl(await getAuthTicket(cookie), targetUserId);
  if (!deeplink) return { ok: false, reason: 'Session expired or the player identifier is invalid.' };
  return { ok: true, deeplink, username: raw.username };
}

/** Resolve an account's current public game server immediately before following. */
async function getFollowContext(accountId) {
  const raw = readRaw().find(a => a.id === accountId);
  if (!raw) return { ok: false, reason: 'The account to follow was not found.' };
  const cookie = decryptCookie(raw.cookie);
  if (!cookie) return { ok: false, reason: 'The account session could not be read.' };

  const presence = await getPresence(raw.userId, cookie);
  if (presence.error) return { ok: false, reason: 'Could not check the account: ' + presence.error };
  if (presence.status !== 'In game') {
    return { ok: false, reason: `${raw.username} is not currently in a game.` };
  }

  const placeId = normalizePlaceId(presence.placeId);
  const gameInstanceId = normalizeGameInstanceId(presence.gameId);
  if (!placeId || !gameInstanceId) {
    return { ok: false, reason: `Roblox did not expose ${raw.username}'s server. The server may be private, reserved, or restricted by privacy settings.` };
  }

  return {
    ok: true,
    username: raw.username,
    displayName: raw.displayName || raw.username,
    placeId,
    gameInstanceId,
  };
}

/**
 * Resolve another Roblox user's exact live server as seen by one selected
 * Fleet account. Presence visibility is relationship/privacy dependent, so
 * this must happen after the user chooses the account they want to join with.
 */
async function getPersonJoinContext(accountId, targetUserId) {
  const raw = readRaw().find(a => a.id === accountId);
  if (!raw) return { ok: false, reason: 'The selected account was not found.' };
  const cookie = decryptCookie(raw.cookie);
  if (!cookie) return { ok: false, reason: 'The selected account session could not be read.' };
  const targetId = Number(targetUserId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return { ok: false, reason: 'The player identifier is invalid.' };

  const presence = await getPresence(targetId, cookie);
  if (presence.error) return { ok: false, reason: 'Could not check that player: ' + presence.error };
  if (presence.status !== 'In game') return { ok: false, reason: 'That player is no longer in a game.' };

  const placeId = normalizePlaceId(presence.placeId);
  const gameInstanceId = normalizeGameInstanceId(presence.gameId);
  if (!placeId || !gameInstanceId) {
    return { ok: false, reason: 'That player is in a private, reserved, or privacy-restricted server for this account.' };
  }
  return { ok: true, placeId, gameInstanceId, accountId: raw.id, username: raw.username };
}

/* ----------------------------- Add / manage ----------------------------- */

/** Open a Roblox login window and resolve with the captured cookie (or null). */
// A clean desktop-Chrome user agent. Roblox's login page renders BLANK for
// user agents containing "Electron"/the app name (bot detection), which is the
// classic "Add account is white and never loads" bug — so spoof Chrome on both
// the session and the webContents before navigating.
const LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function captureLogin() {
  return new Promise((resolve) => {
    const partition = 'fleet-add-' + Date.now();
    const ses = sessionApi.fromPartition(partition);
    try { ses.setUserAgent(LOGIN_UA); } catch (_) {}
    const win = new BrowserWindow({
      width: 520, height: 720, title: 'Sign in to Roblox', autoHideMenuBar: true,
      backgroundColor: '#ffffff', show: false,
      icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    let done = false;
    let timer = null;
    const finish = (cookie) => {
      if (done) return; done = true;
      if (timer) clearInterval(timer);
      try { if (!win.isDestroyed()) win.close(); } catch (_) {}
      resolve(cookie);
    };
    win.on('closed', () => { if (!done) { done = true; if (timer) clearInterval(timer); resolve(null); } });
    win.once('ready-to-show', () => { try { win.show(); } catch (_) {} });

    // Strip UA-Client-Hints/UA header that still leak "Electron" on some builds.
    try {
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        details.requestHeaders['User-Agent'] = LOGIN_UA;
        delete details.requestHeaders['sec-ch-ua'];
        delete details.requestHeaders['Sec-CH-UA'];
        cb({ requestHeaders: details.requestHeaders });
      });
    } catch (_) {}

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      // -3 is an aborted sub-resource (normal on SPA nav); ignore those.
      if (code === -3) return;
      logger.warn('Login page load failed', code + ' ' + desc + ' ' + url);
      try {
        if (!win.isDestroyed()) win.loadURL('data:text/html,' + encodeURIComponent(
          '<body style="font:15px Segoe UI;margin:40px;color:#0e0f12">Could not reach the Roblox sign-in page.<br><br>'
          + 'Check your internet connection and close this window, then try <b>Add account</b> again.</body>'));
      } catch (_) {}
    });

    win.loadURL('https://www.roblox.com/login', { userAgent: LOGIN_UA }).catch((err) => {
      logger.warn('Login loadURL rejected', err && err.message);
    });

    timer = setInterval(async () => {
      try {
        const cookies = await ses.cookies.get({ name: '.ROBLOSECURITY' });
        const c = cookies.find(x => x.value && x.value.length > 100);
        if (c) {
          const user = await getAuthenticatedUser(c.value);
          if (user && user.id) finish(c.value);
        }
      } catch (_) {}
    }, 1200);
  });
}

async function add() {
  if (!BrowserWindow || !sessionApi) return { ok: false, error: 'Login window unavailable.' };
  try {
    const cookie = await captureLogin();
    if (!cookie) return { ok: false, canceled: true };

    const user = await getAuthenticatedUserRetry(cookie, 4);
    if (!user || !user.id) {
      return { ok: false, error: 'Signed in, but Roblox did not return the account. Please try Add account again.' };
    }

    const list0 = readRaw();
    const existing = list0.find(a => a.userId === user.id);

    // Avatar + presence are best-effort — a transient API hiccup must not fail the add.
    let avatar = null, pres = { status: 'Offline' };
    try { avatar = await getAvatar(user.id); } catch (_) {}
    try { pres = await getPresence(user.id, cookie); } catch (_) {}

    const account = {
      id: existing ? existing.id : crypto.randomBytes(8).toString('hex'),
      userId: user.id,
      username: user.name,
      displayName: user.displayName || user.name,
      cookie: encryptCookie(cookie),
      avatar: avatar || (existing && existing.avatar) || null,
      presence: pres.status,
      presenceError: pres.error || null,
      sessionExpired: false,
      game: gameFromPresence(pres),
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    };

    const next = existing ? list0.map(a => (a.userId === user.id ? account : a)) : list0.concat(account);
    writeRaw(next);
    logger.info('Account ' + (existing ? 'updated' : 'added') + ': ' + account.username + ' (' + account.userId + ')');
    return { ok: true, account: sanitize(account), updated: !!existing };
  } catch (err) {
    logger.error('Add account failed', err && err.message);
    return { ok: false, error: 'Sign-in failed: ' + ((err && err.message) || 'unknown error') + '. Please try again.' };
  }
}

function remove(id) {
  writeRaw(readRaw().filter(a => a.id !== id));
  logger.info('Account removed: ' + id);
  return { ok: true, accounts: list() };
}

/**
 * Refresh accounts. Presence is always re-fetched (cheap); avatar/name only
 * when missing or when `full` is set — so periodic presence polling is light.
 */
async function refresh(id, full) {
  const raw = readRaw();
  const targets = id ? raw.filter(a => a.id === id) : raw;
  for (const a of targets) {
    const cookie = decryptCookie(a.cookie);
    if (!cookie) { a.presence = 'Unknown'; a.presenceError = 'No stored session'; continue; }
    if (full || !a.username) {
      const user = await getAuthenticatedUser(cookie);
      if (user && user.id) { a.username = user.name; a.displayName = user.displayName || user.name; }
    }
    if (full || !a.avatar) {
      const avatar = await getAvatar(a.userId);
      if (avatar) a.avatar = avatar;
    }
    const pres = await getPresence(a.userId, cookie);
    a.presence = pres.status;
    a.presenceError = pres.error || null;
    a.sessionExpired = !!pres.expired;
    a.game = gameFromPresence(pres);
  }
  writeRaw(raw);
  return { ok: true, accounts: list() };
}

/* ----------------------------- Presence poller ----------------------------- */
// Polls each account with its OWN cookie (the only way to reliably see its own
// game + detect session expiry), diffs against the stored value, and only
// notifies for accounts whose status/game actually changed. One small request
// per account per tick; nothing is re-rendered unless something changed.

let pollTimer = null;
let pollBusy = false;

function startPolling(opts) {
  opts = opts || {};
  const interval = opts.intervalMs || 12000;
  const onUpdate = opts.onUpdate || function () {};
  const onExpired = opts.onExpired || function () {};
  stopPolling();
  const tick = async () => {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const raw = readRaw();
      let changed = false;
      for (const a of raw) {
        const cookie = decryptCookie(a.cookie);
        if (!cookie) {
          if (a.presence !== 'Unknown') { a.presence = 'Unknown'; a.presenceError = 'No stored session'; changed = true; onUpdate(sanitize(a)); }
          continue;
        }
        const pres = await getPresence(a.userId, cookie);
        if (pres.expired) {
          const firstNotice = !a.sessionExpired;
          if (firstNotice || a.presence !== 'Offline' || a.presenceError !== 'Session expired' || a.game) {
            a.presence = 'Offline';
            a.presenceError = 'Session expired';
            a.sessionExpired = true;
            a.game = null;
            changed = true;
          }
          if (firstNotice) {
            logger.warn('Session expired for ' + a.username + ' (' + a.userId + ')');
            onExpired(sanitize(a));
          }
          continue;
        }
        if (pres.error) continue; // transient (rate-limit/network) — keep last good value
        const game = gameFromPresence(pres);
        if (a.presence !== pres.status || !sameGame(a.game, game) || a.presenceError || a.sessionExpired) {
          a.presence = pres.status;
          a.presenceError = null;
          a.sessionExpired = false;
          a.game = game;
          changed = true;
          onUpdate(sanitize(a));
        }
      }
      if (changed) writeRaw(raw);
    } catch (err) {
      logger.warn('Presence poll failed', err && err.message);
    } finally {
      pollBusy = false;
    }
  };
  pollTimer = setInterval(tick, interval);
  setTimeout(tick, 800); // first pass shortly after start
  logger.info('Presence poller started (' + interval + 'ms)');
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ----------------------------- People (friends) ----------------------------- */

const FRIENDS_TTL = 5 * 60 * 1000;
let friendsCache = { list: [], at: 0 };
const bioCache = new Map();

function firstValidCookie() {
  for (const a of readRaw()) {
    const c = decryptCookie(a.cookie);
    if (c) return c;
  }
  return null;
}

async function fetchFriends(userId) {
  try {
    const res = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends`);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.data || []).map(u => ({ userId: u.id, username: u.name, displayName: u.displayName || u.name }));
  } catch (_) { return []; }
}

/** Aggregate, dedupe the friends of every signed-in account. */
async function loadFriends(force) {
  if (!force && friendsCache.list.length && Date.now() - friendsCache.at < FRIENDS_TTL) return friendsCache.list;
  const accounts = readRaw();
  const own = new Set(accounts.map(a => a.userId));
  const seen = new Map();
  for (const a of accounts) {
    const friends = await fetchFriends(a.userId);
    for (const f of friends) {
      if (own.has(f.userId) || seen.has(f.userId)) continue;
      seen.set(f.userId, f);
    }
  }
  friendsCache = { list: Array.from(seen.values()).sort((a, b) => a.displayName.localeCompare(b.displayName)), at: Date.now() };
  return friendsCache.list;
}

async function getAvatarUrls(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=150x150&format=Png&isCircular=false`);
    const j = await res.json();
    for (const d of (j.data || [])) if (d.imageUrl) map.set(d.targetId, d.imageUrl);
  } catch (_) {}
  return map;
}

// users/{id} returns name + displayName + description in one call (the friends
// list no longer includes names), so this fills all three.
async function getUserInfo(userId) {
  if (bioCache.has(userId)) return bioCache.get(userId);
  let info = { name: '', displayName: '', bio: '' };
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (res.ok) {
      const j = await res.json();
      info = { name: j.name || '', displayName: j.displayName || j.name || '', bio: (j.description || '').trim() };
    }
  } catch (_) {}
  bioCache.set(userId, info);
  return info;
}

/** Paginated public profiles (friends of your accounts). */
async function people(page, pageSize) {
  if (!readRaw().length) return { ok: false, error: 'Add an account to discover people.' };
  const size = Math.max(1, Math.min(24, pageSize || 9));
  const p = Math.max(0, page || 0);
  let all;
  try { all = await loadFriends(false); } catch (err) { return { ok: false, error: (err && err.message) || 'Could not load people.' }; }
  const total = all.length;
  const slice = all.slice(p * size, p * size + size);
  const ids = slice.map(u => u.userId);

  const cookie = firstValidCookie();
  const [avatars, presence] = await Promise.all([
    getAvatarUrls(ids),
    cookie ? getPresenceBatch(ids, cookie) : Promise.resolve(new Map()),
  ]);
  const infos = await Promise.all(ids.map(getUserInfo));

  const peopleOut = slice.map((u, i) => {
    const pres = presence.get(u.userId) || { status: 'Offline' };
    const info = infos[i] || {};
    const game = gameFromPresence(pres);
    return {
      userId: u.userId,
      username: info.name || u.username || String(u.userId),
      displayName: info.displayName || u.displayName || info.name || String(u.userId),
      avatar: avatars.get(u.userId) || null,
      bio: info.bio || '',
      presence: pres.status || 'Offline',
      game,
      canJoin: pres.status === 'In game' && !!pres.placeId,
      placeId: pres.placeId || null,
      gameId: pres.gameId || null,
    };
  });

  return {
    ok: true, people: peopleOut, page: p, pageSize: size, total,
    hasPrev: p > 0, hasNext: (p + 1) * size < total,
  };
}

/**
 * Authenticated presence for arbitrary users. Game details (placeId/gameId) are
 * only returned to a signed-in caller who can see the target (i.e. a friend), so
 * we try every saved account's session and merge, keeping whichever record
 * exposes the most (a visible game beats a bare Online/Offline). This is what
 * makes "Join" appear for a friend of ANY account, not just the first.
 * Returns Map(userId -> { status, lastLocation, placeId, rootPlaceId, gameId, universeId }).
 */
async function presenceForIds(userIds, opts) {
  const ids = (userIds || []).map(Number).filter(Boolean);
  const merged = new Map();
  if (!ids.length) return merged;
  let cookies = [...new Set(readRaw().map(a => decryptCookie(a.cookie)).filter(Boolean))];
  // `firstOnly` (used for search lists of strangers) skips the multi-session
  // merge — their game is never visible to us anyway, so one call gives status.
  if (opts && opts.firstOnly) cookies = cookies.slice(0, 1);
  for (const cookie of cookies) {
    const m = await getPresenceBatch(ids, cookie);
    for (const [uid, rec] of m) {
      const prev = merged.get(uid);
      const better = !prev
        || (!prev.placeId && rec.placeId)                          // this session can see the game
        || (prev.status === 'Offline' && rec.status !== 'Offline'); // a friend sees them online
      if (better) merged.set(uid, rec);
    }
    // Stop early once every requested user has a visible game.
    if (ids.every(id => { const r = merged.get(id); return r && r.placeId; })) break;
  }
  return merged;
}

/**
 * Authenticated GET returning HTTP metadata. Roblox's user-search endpoint is
 * heavily rate-limited (and returns empty results) for anonymous callers, but
 * generous for a signed-in session — so People search should always go through
 * a stored account cookie when one exists.
 * @returns {{ok, status, data, authenticated, retryAfterMs, error}}
 */
async function authedGet(url) {
  const cookie = firstValidCookie();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const headers = cookie ? authHeaders(cookie) : { 'User-Agent': 'Roblox/WinInet' };
    const res = await fetch(url, { headers, signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    return {
      ok: res.ok, status: res.status, data, authenticated: !!cookie,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null,
      error: res.ok ? null : ('HTTP ' + res.status),
    };
  } catch (err) {
    return { ok: false, status: 0, data: null, authenticated: !!cookie, retryAfterMs: null, error: (err && err.message) || 'Network error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  configure, list, add, remove, refresh,
  getLaunchInfo, getFollowContext, getPersonJoinContext, getPersonJoinLaunchInfo,
  startPolling, stopPolling,
  people, loadFriends, presenceForIds, authedGet, hasSession: () => !!firstValidCookie(),
  // exposed for tests
  getAvatar, getAuthenticatedUser, getPresence, getPresenceBatch, buildLaunchUrl, buildFollowUserLaunchUrl,
};
