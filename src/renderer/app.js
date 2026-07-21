'use strict';

/* Fleet renderer - pure UI. All OS/auth work happens in the main process and is
   reached only through the Tauri-backed `window.fleet` bridge. */

const api = window.fleet;
const { parseRobloxTarget, normalizeThemePreference, normalizeSessions } = window.FleetModel;
const SERVER_PEOPLE_REFRESH_MS = 2000;

/* ----------------------------- Theme ----------------------------- */
const THEME_KEY = 'fleet-theme';
function themePref() {
  try { return normalizeThemePreference(localStorage.getItem(THEME_KEY)); }
  catch (_) { return 'system'; }
}
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function setThemePref(pref) {
  try { localStorage.setItem(THEME_KEY, normalizeThemePreference(pref)); } catch (_) { /* use current theme */ }
  applyTheme();
}
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
if (systemTheme.addEventListener) systemTheme.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });
applyTheme();

function initWindowChrome() {
  const windowApi = api && api.ui && api.ui.window;
  const drag = document.getElementById('titlebar-drag');
  if (!windowApi || !drag) return;
  const syncMaximized = async () => {
    const maximized = await windowApi.isMaximized();
    document.body.classList.toggle('window-maximized', maximized);
    document.documentElement.classList.toggle('window-maximized', maximized);
    const button = document.querySelector('[data-window-action="maximize"]');
    if (button) {
      button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
      button.title = maximized ? 'Restore' : 'Maximize';
    }
  };
  drag.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.detail === 2) windowApi.toggleMaximize().then(syncMaximized);
    else windowApi.startDragging();
  });
  document.querySelector('.window-controls').addEventListener('click', (event) => {
    const button = event.target.closest('[data-window-action]');
    if (!button) return;
    const action = button.dataset.windowAction;
    if (action === 'minimize') windowApi.minimize();
    else if (action === 'maximize') windowApi.toggleMaximize().then(syncMaximized);
    else if (action === 'close') windowApi.close();
  });
  windowApi.onResized(syncMaximized);
  syncMaximized();
}
initWindowChrome();

const state = {
  view: 'instances',
  status: null,
  updater: null,
  instances: [],
  summary: null,
  accounts: [],
  selected: new Set(),     // selected account ids (shared across views)
  launchMode: 'account',   // 'account' | 'plain'
  placeId: '',
  history: [],
  diag: null,
  logs: [],
  logFilter: 'all',
  addingAccount: false,
  followTargetId: null,
  followSelected: new Set(),
  following: false,
  personJoin: null,
  sessionDraft: null,
  games: {
    list: [], query: '', nextPageToken: null, loading: false, error: null, loaded: false,
    sort: 'players', hideEmpty: false, categories: [], category: 'All',
  },
  people: {
    tab: 'people',
    route: 'home', returnRoute: 'home',
    filter: 'all', sort: 'status',
    list: [], page: 0, pageSize: 9, total: 0, hasNext: false, hasPrev: false, loading: false, error: null, loaded: false,
    search: {
      query: '', list: [], nextPageCursor: null, loading: false, error: null,
      searched: false, requestId: 0, notice: null, source: null, cached: false, retryable: false,
    },
    server: {
      list: [], total: 0, loading: false, error: null, loaded: false, updatedAt: null, note: null,
      search: {
        query: '', list: [], loading: false, error: null, searched: false, requestId: 0,
      },
    },
    detail: { userId: null, profile: null, loading: false, error: null },
  },
  accountsRefreshedAt: 0,
};

/* ----------------------------- DOM helpers ----------------------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const content = $('#content');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeAttr(value) { return esc(value); }
function dataKeyToProp(attr) {
  return String(attr || '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
function findAllByData(root, attr, value) {
  const scope = root || document;
  const prop = dataKeyToProp(attr);
  const expected = String(value == null ? '' : value);
  return Array.from(scope.querySelectorAll(`[data-${attr}]`)).filter(el => el.dataset[prop] === expected);
}
function findByData(root, attr, value) {
  return findAllByData(root, attr, value)[0] || null;
}
function icon(id) { return `<svg class="ico"><use href="#i-${id}"/></svg>`; }
function fmtBytes(b) {
  if (!b) return '0 MB';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
}
function relTime(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '-';
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); s = s % 60;
  if (m < 60) return m + 'm ' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/* ----------------------------- Toasts ----------------------------- */
function toast(message, type) {
  const wrap = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + (type === 'bad' ? 'bad' : type === 'good' ? 'good' : '');
  const ic = type === 'bad' ? 'alert-circle' : type === 'good' ? 'check-circle' : 'box';
  t.innerHTML = `<svg class="t-ico"><use href="#i-${ic}"/></svg><span>${esc(message)}</span>`;
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .25s, transform .25s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 260); }, 3400);
}

/* ----------------------------- Modal ----------------------------- */
function openModal(htmlStr, className) {
  const modal = $('#modal');
  modal.className = 'modal' + (className ? ' ' + className : '');
  modal.innerHTML = htmlStr;
  $('#modal-back').classList.add('open');
}
function closeModal() {
  if (state.servers && state.servers.refreshTimer) clearInterval(state.servers.refreshTimer);
  $('#modal-back').classList.remove('open');
  $('#modal').className = 'modal';
  $('#modal').innerHTML = '';
}
let confirmResolver = null;
function confirmDialog({ title, body, confirmText, danger }) {
  return new Promise((resolve) => {
    openModal(`
      <div class="m-head"><h3>${esc(title)}</h3></div>
      <div class="m-body"><p style="margin:0;color:var(--ink-2)">${esc(body)}</p></div>
      <div class="m-foot">
        <button class="btn" data-action="confirm-no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-action="confirm-yes">${esc(confirmText || 'Confirm')}</button>
      </div>`);
    confirmResolver = resolve;
  });
}

function closeFollowDialog() {
  state.followTargetId = null;
  state.followSelected = new Set();
  state.following = false;
  closeModal();
}

function renderFollowDialog() {
  const target = state.accounts.find(a => a.id === state.followTargetId);
  if (!target) { closeFollowDialog(); return; }
  const followers = state.accounts.filter(a => a.id !== target.id);
  const chips = followers.map(a => `
    <button class="chip ${state.followSelected.has(a.id) ? 'on' : ''}" data-action="toggle-follow-account" data-id="${a.id}" ${state.following ? 'disabled' : ''}>
      ${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : icon('users')}<span>${esc(a.displayName || a.username)}</span>
    </button>`).join('');
  const count = state.followSelected.size;
  openModal(`
    <div class="m-head"><h3>Follow ${esc(target.displayName || target.username)}</h3></div>
    <div class="m-body">
      <p style="margin:0 0 14px;color:var(--ink-2)">Choose the other accounts that should join this account's exact Roblox server.</p>
      <div class="chips">${chips || '<span class="hint">Add another account first.</span>'}</div>
      <p class="hint" style="margin:14px 0 0">Fleet checks the target's live server again when you click Follow.</p>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel" ${state.following ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="follow-confirm" ${!count || state.following ? 'disabled' : ''}>
        ${state.following ? '<span class="spinner"></span> Joining-' : `${icon('users-group')} Follow with ${count || ''}`}
      </button>
    </div>`);
}

function openFollowDialog(targetId) {
  const followers = new Set(state.accounts.filter(a => a.id !== targetId).map(a => a.id));
  state.followTargetId = targetId;
  state.followSelected = new Set(Array.from(state.selected).filter(id => followers.has(id)));
  state.following = false;
  renderFollowDialog();
}

function closePersonJoinDialog() {
  state.personJoin = null;
  closeModal();
}

function renderPersonJoinDialog() {
  const join = state.personJoin;
  if (!join) return;
  const choices = state.accounts.map(account => {
    const selected = join.selectedIds.has(account.id);
    return `<button class="join-account-choice ${selected ? 'on' : ''}" data-action="select-join-account" data-id="${esc(account.id)}" ${join.joining ? 'disabled' : ''}>
      ${account.avatar ? `<img src="${esc(account.avatar)}" alt="">` : `<span class="join-account-avatar">${icon('users-group')}</span>`}
      <span class="join-account-name"><strong>${esc(account.displayName || account.username)}</strong><small>@${esc(account.username)}</small></span>
      <span class="presence ${presenceClass(account.presence)}"><span class="pd"></span>${esc(account.presence || 'Offline')}</span>
      <span class="join-account-check">${selected ? icon('check') : ''}</span>
    </button>`;
  }).join('');
  const n = join.selectedIds.size;
  openModal(`
    <div class="m-head"><h3>Join ${esc(join.name || 'player')}</h3><p>Pick one or more accounts - Fleet joins each into their exact server.</p></div>
    <div class="m-body">
      <div class="join-account-list">${choices}</div>
      <p class="hint" style="margin:13px 0 0">Fleet checks the live server with your selected account when you click Join. Private or privacy-restricted servers can still block the join.</p>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel" ${join.joining ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="person-join-confirm" ${!n || join.joining ? 'disabled' : ''}>
        ${join.joining ? '<span class="spinner"></span> Joining-' : `${icon('play')} Join${n ? ` with ${n} account${n === 1 ? '' : 's'}` : ''}`}
      </button>
    </div>`);
}

function openPersonJoinDialog(userId, placeId, gameId, name) {
  if (!userId) { toast('That person is not in a joinable game', 'bad'); return; }
  if (!state.accounts.length) { toast('Add an account to join', 'bad'); setView('accounts'); return; }
  const preselect = Array.from(state.selected).filter(id => state.accounts.some(a => a.id === id));
  const initial = preselect.length ? preselect : (state.accounts.length === 1 ? [state.accounts[0].id] : []);
  state.personJoin = {
    userId: String(userId),
    placeId: placeId ? String(placeId) : null,
    gameId: gameId || null,
    name: name || 'player',
    selectedIds: new Set(initial),
    joining: false,
  };
  renderPersonJoinDialog();
}

/* ----------------------------- Context menu ----------------------------- */
const ctxmenu = $('#ctxmenu');
function showContextMenu(x, y, items) {
  ctxmenu.innerHTML = items.map(it => it.sep ? '<div class="sep"></div>'
    : `<button data-ctx="${it.id}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  ctxmenu.style.display = 'block';
  const w = ctxmenu.offsetWidth, h = ctxmenu.offsetHeight;
  ctxmenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  ctxmenu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  ctxmenu._items = items;
}
function hideContextMenu() { ctxmenu.style.display = 'none'; ctxmenu._items = null; }
document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
ctxmenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ctx]');
  if (!btn || !ctxmenu._items) return;
  const item = ctxmenu._items.find(i => i.id === btn.dataset.ctx);
  hideContextMenu();
  if (item && item.onClick) item.onClick();
});

/* ----------------------------- Tooltips ----------------------------- */
/* JS-driven so tips never clip at the viewport edge (the old pure-CSS
   translateX(-50%) ::after overflowed near the right/top of the window). */
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
let tipTarget = null;

function positionTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.toggle('wide', target.hasAttribute('data-tip-wide'));
  tipEl.classList.add('show');
  const M = 8; // viewport margin
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let top = r.top - th - M;
  const below = top < M;
  if (below) top = r.bottom + M;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(M, Math.min(left, window.innerWidth - tw - M));
  top = Math.max(M, Math.min(top, window.innerHeight - th - M));
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
  tipEl.classList.toggle('below', below);
}
function hideTip() { tipTarget = null; tipEl.classList.remove('show'); }
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t === tipTarget) return;
  if (!t) { hideTip(); return; }
  tipTarget = t;
  positionTip(t);
});
document.addEventListener('mouseout', (e) => {
  if (!tipTarget) return;
  const to = e.relatedTarget;
  if (!to || !tipTarget.contains(to)) hideTip();
});
document.addEventListener('mousedown', hideTip);
window.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

/* ----------------------------- Safe API ----------------------------- */
async function call(fn, fallback, timeoutMs) {
  let timer = null;
  try {
    if (!api) throw new Error('Fleet bridge unavailable (run inside the Fleet app).');
    const work = Promise.resolve().then(fn);
    const limit = timeoutMs === undefined ? 15000 : Number(timeoutMs);
    // Interactive operations such as account sign-in resolve when their own
    // window closes. A non-positive timeout lets that user-driven flow finish
    // without showing a false "did not respond" error after 15 seconds.
    if (!(limit > 0)) return await work;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fleet did not respond in time. Check Diagnostics and retry.')), limit);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ----------------------------- Router ----------------------------- */
const views = {};
let renderedView = null;
function setView(name) {
  state.view = name;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  (views[name] || views.instances)();
  renderedView = name;
  if (name === 'people') setTimeout(refreshVisiblePeoplePresence, 0);
}
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) {
    if (b.dataset.view === state.view && renderedView === state.view && b.dataset.view !== 'people') return;
    if (b.dataset.view === 'people') state.people.route = state.people.tab === 'server' ? 'server' : 'home';
    setView(b.dataset.view);
  }
});
function mount(html, options) {
  const animate = !options || options.animate !== false;
  content.innerHTML = `<div class="view${animate ? ' view-enter' : ''}">${html}</div>`;
}

/* ----------------------------- Instances view ----------------------------- */

/* ----------------------------- Favorites & Recents ----------------------------- */
/* Starred games and the last games joined, persisted locally so they survive
   restarts and searches. Stored as full game objects (name/thumbnail/votes)
   so the grid renders them even when they're not in the current browse list. */
const FAV_KEY = 'fleet-fav-games';
const RECENT_KEY = 'fleet-recent-games';
function loadGameStore(key) {
  try { const l = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(l) ? l : []; }
  catch (_) { return []; }
}
function favGames() { return loadGameStore(FAV_KEY); }
function recentGames() { return loadGameStore(RECENT_KEY); }
function isFav(gm) { return favGames().some(g => String(g.placeId) === String(gm.placeId)); }
function toggleFav(gm) {
  const list = favGames();
  const idx = list.findIndex(g => String(g.placeId) === String(gm.placeId));
  if (idx >= 0) list.splice(idx, 1); else list.unshift(gm);
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 60)));
  return idx < 0;
}
function recordRecentGame(gm) {
  if (!gm || !gm.placeId) return;
  const list = recentGames().filter(g => String(g.placeId) !== String(gm.placeId));
  list.unshift(Object.assign({}, gm, { joinedAt: Date.now() }));
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}
function gameByPlaceId(placeId) {
  return state.games.list.find(g => String(g.placeId) === String(placeId))
    || favGames().find(g => String(g.placeId) === String(placeId))
    || recentGames().find(g => String(g.placeId) === String(placeId))
    || null;
}

/* ----------------------------- Clipboard quick-join ----------------------------- */
/* If a Roblox game link is sitting on the clipboard when Instances is opened
   or refocused, offer it - one click drops it into the launch box. Local only. */
let lastClipboardOffer = '';
async function checkClipboardForGameLink() {
  if (state.view !== 'instances' || !api.ui || !api.ui.clipboard) return;
  const r = await call(() => api.ui.clipboard(), { ok: false, text: '' });
  const text = (r && r.text || '').trim();
  if (!text || text === lastClipboardOffer) return;
  const target = parseRobloxTarget(text);
  if (!target.placeId) return;
  lastClipboardOffer = text;
  const box = $('#clip-offer');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `${icon('copy')} <span>Roblox link on your clipboard - place <b>${esc(target.placeId)}</b>${target.gameId ? ' (specific server)' : ''}</span>
    <button class="btn sm primary" data-action="clip-use" data-text="${esc(text)}">Use it</button>
    <button class="btn sm ghost" data-action="clip-dismiss">Dismiss</button>`;
}
window.addEventListener('focus', () => { setTimeout(checkClipboardForGameLink, 150); });

/* ----------------------------- Sessions ----------------------------- */
/* A session = a saved multi-launch setup (accounts + target + arrange).
   One click reproduces the whole thing. Stored locally, survives restarts. */
const SESSIONS_KEY = 'fleet-sessions';
function loadSessions() {
  try { return normalizeSessions(JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')); }
  catch (_) { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(normalizeSessions(list))); return true; }
  catch (_) { return false; }
}

function sessionRows() {
  const sessions = loadSessions();
  if (!sessions.length) return '<div class="hint">No sessions yet - set up a launch above, then save it here.</div>';
  return sessions.map(s => {
    const known = s.accountIds.filter(id => state.accounts.some(a => a.id === id));
    const target = s.gameId ? 'specific server' : (s.placeId ? `place ${s.placeId}` : 'Roblox home');
    const missing = known.length < s.accountIds.length ? ` - ${s.accountIds.length - known.length} account(s) missing` : '';
    return `<div class="setting">
      <div><div class="s-label">${esc(s.name)}</div>
      <div class="s-desc">${known.length} account${known.length === 1 ? '' : 's'} - ${esc(target)}${s.arrange ? ' - auto-arrange' : ''}${s.keepAlive ? ' - keep-alive' : ''}${esc(missing)}</div></div>
      <div class="s-control inline">
        <button class="btn sm primary" data-action="session-launch" data-id="${esc(s.id)}" ${known.length ? '' : 'disabled'}>${icon('play')} Launch</button>
        <button class="btn sm icon" data-action="session-delete" data-id="${esc(s.id)}" data-tip="Delete this session">${icon('x')}</button>
      </div></div>`;
  }).join('');
}

views.instances = function () {
  const s = state.status || {};
  let detection;
  if (s.robloxFound) {
    detection = `<div class="banner good"><svg class="b-ico"><use href="#i-check-circle"/></svg>
      <div class="b-text"><b>Roblox detected</b><span>${esc(s.version || '')} - found via ${esc(s.source || '')}</span></div></div>`;
  } else {
    detection = `<div class="banner bad"><svg class="b-ico"><use href="#i-alert-circle"/></svg>
      <div class="b-text"><b>Roblox not found</b><span>Install the regular desktop Roblox from roblox.com. The Microsoft Store version and custom launchers (Bloxstrap) aren't detected - or point Settings at your RobloxPlayerBeta.exe manually.</span></div>
      <div class="b-actions"><button class="btn sm" data-action="goto-settings">Open Settings</button></div></div>`;
  }
  let lockBanner = '';
  if (s.ffiAvailable === false) {
    lockBanner = `<div class="banner warn" style="margin-top:12px"><svg class="b-ico"><use href="#i-alert-tri"/></svg>
      <div class="b-text"><b>Multi-instance is unavailable</b><span>The native helper could not load${s.ffiError ? ': ' + esc(s.ffiError) : ''}. You can still launch a single client.</span></div></div>`;
  }

  const hasAccounts = state.accounts.length > 0;
  const mode = hasAccounts ? state.launchMode : 'plain';

  const accountChips = state.accounts.map(a => `
    <button class="chip ${state.selected.has(a.id) ? 'on' : ''}" data-action="toggle-account" data-id="${a.id}">
      ${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : icon('users')}<span>${esc(a.displayName || a.username)}</span>
    </button>`).join('');

  const accountPanel = `
    <div id="lp-account" style="${mode === 'account' ? '' : 'display:none'}">
      <div class="hint" style="margin:2px 0 12px">Select one or more accounts - Fleet opens a signed-in client for each.</div>
      <div class="chips">${hasAccounts ? accountChips : '<span class="hint">No accounts yet.</span>'}</div>
      <div class="inline" style="margin-top:16px">
        <input id="lp-place" type="text" placeholder="Place ID or game link (optional)" value="${esc(state.placeId)}" style="max-width:320px" data-tip="Paste a place ID, a roblox.com game URL, or a share link with a server ID" />
        <label class="inline" style="gap:7px;cursor:pointer;font-size:12.5px;color:var(--ink-2);white-space:nowrap" data-tip="If a client crashes or disconnects, Fleet puts that account straight back into the game"><input type="checkbox" id="lp-keepalive"> Keep alive</label>
        <div class="spacer" style="flex:1"></div>
        <button class="btn primary lg" data-action="launch-accounts" ${s.robloxFound ? '' : 'disabled'}>${icon('play')} <span id="lp-count-label">Launch ${state.selected.size || ''}</span></button>
      </div>
    </div>`;

  const plainPanel = `
    <div id="lp-plain" style="${mode === 'plain' ? '' : 'display:none'}">
      <div class="hint" style="margin:2px 0 12px">Opens signed-out clients. Each starts a real, separate Roblox client.</div>
      <div class="inline">
        <div class="stepper" data-tip="How many clients to open">
          <button data-action="step" data-dir="-1" data-target="launch-count">-</button>
          <input id="launch-count" type="number" min="1" max="10" value="1" />
          <button data-action="step" data-dir="1" data-target="launch-count">+</button>
        </div>
        <div class="spacer" style="flex:1"></div>
        <button class="btn primary lg" data-action="launch-quick" ${s.robloxFound ? '' : 'disabled'}>${icon('play')} Launch</button>
      </div>
    </div>`;

  const modeToggle = hasAccounts ? `
    <div class="segmented" id="launch-mode">
      <button data-action="launch-mode" data-mode="account" class="${mode === 'account' ? 'on' : ''}">With account</button>
      <button data-action="launch-mode" data-mode="plain" class="${mode === 'plain' ? 'on' : ''}">Signed out</button>
    </div>` : '';

  mount(`
    <div class="page-head">
      <h1>Instances</h1>
      <p>Launch Roblox and watch every client live. Fleet isolates each one, so you can run several at once - signed in to different accounts or signed out.</p>
    </div>
    ${detection}
    ${lockBanner}
    <div id="clip-offer" class="clip-offer" hidden></div>
    <div class="card pad" style="margin-top:14px">
      <div class="row-split" style="margin-bottom:16px">
        <div style="font-weight:600;font-size:15px">Launch Roblox</div>
        ${modeToggle}
      </div>
      ${accountPanel}
      ${plainPanel}
    </div>

    <div class="card pad" style="margin-top:14px">
      <div class="row-split" style="margin-bottom:6px">
        <div style="font-weight:600;font-size:15px">Sessions</div>
        <button class="btn sm" data-action="session-save" ${hasAccounts ? '' : 'disabled'} data-tip="Save the current account selection and game as a one-click setup">${icon('plus')} Save current setup</button>
      </div>
      <div class="hint" style="margin-bottom:10px">One click relaunches an entire setup - accounts, game, even window arrangement.</div>
      <div id="sessions-list">${sessionRows()}</div>
    </div>

    <div class="row-split" style="margin:26px 2px 12px">
      <div class="section-title" style="margin:0">Running clients</div>
      <span id="keepalive-chip" class="keepalive-chip" hidden></span>
      <div class="inline">
        <button class="btn sm" data-action="refresh-instances" data-tip="Refresh now">${icon('refresh')} Refresh</button>
        <button class="btn sm" data-action="arrange" data-tip="Tile all Roblox windows into a grid">${icon('grid')} Arrange</button>
        <button class="btn sm" data-action="end-all" data-tip="End every Roblox client">${icon('x')} End all</button>
        <button class="btn sm" data-action="cleanup" data-tip="End clients and clear leftover crash handlers">${icon('broom')} Cleanup</button>
      </div>
    </div>
    <div class="card" id="summary-card" style="display:none"><div class="summary" id="summary"></div></div>
    <div id="ilist" class="ilist" style="margin-top:14px"></div>
  `);
  renderInstanceList();
  renderKeepAliveChip();
  setTimeout(checkClipboardForGameLink, 200);
};

function renderInstanceList() {
  const list = $('#ilist');
  if (!list) return;
  const items = state.instances || [];
  renderInstanceSummary(items);
  patchInstanceList(list, items);
}

function renderInstanceSummary(items) {
  const sCard = $('#summary-card');
  if (!sCard) return;
  const sum = state.summary;
  if (sum && items.length) {
    sCard.style.display = '';
    const summary = $('#summary');
    const key = [sum.total, sum.fleet, sum.external, sum.notResponding, sum.totalMemBytes].join('|');
    if (summary.dataset.summaryKey !== key) summary.innerHTML = `
      <div class="stat"><span class="v">${sum.total}</span><span class="k">Total</span></div>
      <div class="stat"><span class="v">${sum.fleet}</span><span class="k">Launched by Fleet</span></div>
      <div class="stat"><span class="v">${sum.external}</span><span class="k">External</span></div>
      <div class="stat"><span class="v">${sum.notResponding}</span><span class="k">Not responding</span></div>
      <div class="stat"><span class="v">${fmtBytes(sum.totalMemBytes)}</span><span class="k">Total memory</span></div>`;
    summary.dataset.summaryKey = key;
  } else {
    sCard.style.display = 'none';
  }
}

function instanceRowHtml(i, isNew) {
  const pid = Number(i.pid) || 0;
  const tag = i.source === 'fleet'
    ? `<span class="tag fleet">${i.profileName ? esc(i.profileName) : 'Fleet'}</span>`
    : `<span class="tag external">External</span>`;
  const title = i.windowTitle ? esc(i.windowTitle) : '<span style="color:var(--ink-3)">Loading-</span>';
  const started = (i.startedExact ? '' : '~') + relTime(i.startedAt);
  const signature = encodeURIComponent(JSON.stringify([i.status, i.windowTitle, i.source, i.profileName, i.memBytes, i.startedAt, !!i.startedExact]));
  return `<div class="irow${isNew ? ' row-enter' : ''}" data-pid="${pid}" data-signature="${signature}" data-row>
    <span class="dot ${esc(i.status || 'running')}" data-tip="${i.status === 'not_responding' ? 'Not responding' : 'Running'}"></span>
    <span class="pid">${pid}</span>
    <span><div class="title">${title}</div><div style="margin-top:4px">${tag}</div></span>
    <span class="mem">${fmtBytes(i.memBytes)}</span>
    <span class="when" data-tip="${i.startedExact ? 'Launched by Fleet' : 'First seen by Fleet'}">${started}</span>
    <span class="actions">
      <button class="btn icon sm" data-action="focus" data-pid="${pid}" data-tip="Bring window to front">${icon('focus')}</button>
      <button class="btn icon sm" data-action="restart" data-pid="${pid}" data-tip="Restart this client">${icon('rotate')}</button>
      <button class="btn icon sm danger" data-action="end" data-pid="${pid}" data-tip="End this client">${icon('x')}</button>
    </span>
  </div>`;
}

function patchInstanceList(list, items) {
  if (!items.length) {
    if (list.dataset.mode !== 'empty') {
      list.dataset.mode = 'empty';
      list.innerHTML = `<div class="card"><div class="empty"><div class="e-ico">${icon('box')}</div>
        <h3>No Roblox clients running</h3><p>Use <b>Launch</b> above to open one.</p></div></div>`;
    }
    return;
  }

  if (list.dataset.mode !== 'rows') {
    list.dataset.mode = 'rows';
    list.innerHTML = `<div class="head"><span></span><span>PID</span><span>Window / source</span><span>Memory</span><span class="when">Started</span><span></span></div><div data-instance-rows></div>`;
  }

  const rowsRoot = list.querySelector('[data-instance-rows]') || list;
  const existing = new Map(Array.from(rowsRoot.querySelectorAll('.irow[data-pid]')).map(row => [row.dataset.pid, row]));
  const live = new Set();

  for (const item of items) {
    const key = String(item.pid);
    live.add(key);
    const current = existing.get(key);
    if (current) {
      const signature = encodeURIComponent(JSON.stringify([item.status, item.windowTitle, item.source, item.profileName, item.memBytes, item.startedAt, !!item.startedExact]));
      if (current.dataset.signature !== signature) current.outerHTML = instanceRowHtml(item, false);
      else {
        const when = current.querySelector('.when');
        if (when) when.textContent = (item.startedExact ? '' : '~') + relTime(item.startedAt);
      }
    } else {
      rowsRoot.insertAdjacentHTML('beforeend', instanceRowHtml(item, true));
    }
  }

  for (const [key, row] of existing) {
    if (!live.has(key)) row.remove();
  }

  for (const item of items) {
    const row = findByData(rowsRoot, 'pid', item.pid);
    if (row) rowsRoot.appendChild(row);
  }
}

function refreshInstanceElapsedTimes() {
  if (state.view !== 'instances' || document.hidden) return;
  const root = $('#ilist');
  if (!root) return;
  for (const item of state.instances || []) {
    const row = findByData(root, 'pid', item.pid);
    const when = row && row.querySelector('.when');
    if (when) when.textContent = (item.startedExact ? '' : '~') + relTime(item.startedAt);
  }
}


function updateAccountsLaunchButton() {
  const root = document.querySelector('[data-account-launch-actions]');
  if (!root) return;
  const count = state.selected.size;
  const existing = root.querySelector('[data-account-launch-selected]');
  if (!count) { if (existing) existing.remove(); return; }
  const html = `${icon('play')} Launch ${count} selected`;
  if (existing) { existing.innerHTML = html; return; }
  root.insertAdjacentHTML('afterbegin', `<button class="btn primary sm" data-action="launch-selected" data-account-launch-selected>${html}</button>`);
}
function updateLaunchCount() {
  const lbl = $('#lp-count-label');
  if (lbl) lbl.textContent = 'Launch ' + (state.selected.size || '');
}

/* ----------------------------- Accounts view ----------------------------- */
views.accounts = function () {
  const list = state.accounts || [];
  const selectedCount = state.selected.size;

  const cards = list.length ? `<div class="acct-grid" data-account-grid>` + list.map(a => renderAccountCard(a)).join('') + `</div>`
    : `<div class="card"><div class="empty"><div class="e-ico">${icon('users')}</div>
        <h3>No accounts yet</h3><p>Add a Roblox account to launch clients already signed in.</p></div></div>`;

  mount(`
    <div class="page-head">
      <h1>Accounts</h1>
      <p>Sign in to your Roblox accounts once, then launch any of them - alone or several at a time. Sessions are stored encrypted on this PC and never leave it.</p>
    </div>
    <div class="row-split" style="margin-bottom:16px">
      <div class="section-title" style="margin:0">Your accounts${(() => { const t = list.reduce((n, x) => n + (x.robux || 0), 0); return list.some(x => x.robux != null) ? ` <span class="robux-total" data-tip="Total Robux across all accounts">${icon('box')} ${fmtNum(t)}</span>` : ''; })()}</div>
      <div class="inline" data-account-launch-actions>
        ${list.length ? `<button class="btn sm" data-action="refresh-accounts" data-tip="Refresh all">${icon('refresh')} Refresh all</button>` : ''}
        ${selectedCount ? `<button class="btn primary sm" data-action="launch-selected" data-account-launch-selected>${icon('play')} Launch ${selectedCount} selected</button>` : ''}
        <button class="btn primary sm" data-action="add-account" ${state.addingAccount ? 'disabled' : ''}>
          ${state.addingAccount ? '<span class="spinner"></span>' : icon('user-plus')} ${state.addingAccount ? 'Waiting for sign-in-' : 'Add account'}
        </button>
      </div>
    </div>
    ${cards}
  `);
};

function renderAccountCard(a) {
  const allAccounts = state.accounts || [];
  const presRaw = a.presence || 'Offline';
  const pl = presRaw.toLowerCase();
  const presClass = presenceClass(presRaw);
  const presTip = a.presenceError ? ` data-tip="${esc(a.presenceError)}"` : '';
  const expired = !!a.sessionExpired || a.presenceError === 'Session expired';
  const canFollow = !expired && pl === 'in game' && allAccounts.length > 1;
  const followTip = allAccounts.length < 2 ? 'Add another account to use Follow'
    : (canFollow ? 'Choose other accounts to join this exact server' : 'This account must be in a game');
  const id = safeAttr(a.id);
  return `
    <div class="acct ${state.selected.has(a.id) ? 'selected' : ''}" data-id="${id}">
      <div class="top">
        ${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : `<div class="avatar"></div>`}
        <div class="who">
          <div class="dname">${esc(a.displayName || a.username)}</div>
          <div class="uname">@${esc(a.username)}</div>
        </div>
        <div class="check" data-action="toggle-account" data-id="${id}" data-tip="Select for launch">${icon('check')}</div>
      </div>
      <div class="row-split">
        <span class="presence ${presClass}"${presTip} data-acct-presence="${id}"><span class="pd"></span>${esc(presRaw)}</span>
        <span class="robux-chip" data-acct-robux="${id}"${a.robux == null ? ' hidden' : ''} data-tip="Robux balance${a.premium ? ' - Premium member' : ''}">${a.premium ? '<b class="prem">P</b>' : ''}${icon('box')} ${a.robux == null ? '' : fmtNum(a.robux)}</span>
      </div>
      <div class="acct-game" data-acct-game="${id}"${a.game ? '' : ' hidden'}>${a.game ? icon('compass') + ' ' + esc(a.game.name) : ''}</div>
      <div class="acct-actions">
        ${expired
          ? `<button class="btn primary sm" data-action="reauth-account" data-id="${id}">${icon('user-plus')} Sign in again</button>`
          : `<button class="btn primary sm" data-action="launch-account" data-id="${id}">${icon('play')} Launch</button>`}
        <button class="btn sm" data-action="follow-account" data-id="${id}" data-tip="${esc(followTip)}" ${canFollow ? '' : 'disabled'}>${icon('users-group')} Follow</button>
        <button class="btn sm icon" data-action="refresh-account" data-id="${id}" data-tip="Refresh status">${icon('refresh')}</button>
        <button class="btn sm icon danger" data-action="remove-account" data-id="${id}" data-tip="Remove account">${icon('trash')}</button>
      </div>
    </div>`;
}

function presenceClass(presRaw) {
  const pl = (presRaw || 'Offline').toLowerCase();
  if (pl === 'online') return 'online';
  if (pl.includes('game') || pl.includes('studio')) return 'ingame';
  if (pl === 'unknown') return 'unknown';
  return '';
}

/**
 * Real-time per-card update: the main process pushes only accounts whose
 * status/game changed. Patch just that card in place - no full re-render,
 * no timer, no extra network from the renderer.
 */
function replaceAccountCard(acc) {
  const card = findAllByData(document, 'id', acc.id).find(el => el.classList.contains('acct'));
  if (card) card.outerHTML = renderAccountCard(acc);
}

function patchAccountGrid(accounts) {
  const grid = document.querySelector('[data-account-grid]');
  if (!grid) {
      if (state.view === 'accounts') views.accounts();
    return;
  }
  const live = new Set();
  for (const acc of accounts || []) {
    if (!acc || !acc.id) continue;
    live.add(String(acc.id));
    const card = findAllByData(grid, 'id', acc.id).find(el => el.classList.contains('acct'));
    if (card) card.outerHTML = renderAccountCard(acc);
    else grid.insertAdjacentHTML('beforeend', renderAccountCard(acc));
  }
  Array.from(grid.querySelectorAll('.acct[data-id]')).forEach(card => {
    if (!live.has(card.dataset.id)) card.remove();
  });
  for (const acc of accounts || []) {
    const card = findAllByData(grid, 'id', acc.id).find(el => el.classList.contains('acct'));
    if (card) grid.appendChild(card);
  }
}

function applyAccountUpdate(acc) {
  if (!acc || !acc.id) return;
  const i = state.accounts.findIndex(a => a.id === acc.id);
  const prev = i >= 0 ? state.accounts[i] : null;
  if (i >= 0) state.accounts[i] = Object.assign({}, state.accounts[i], acc);
  const merged = state.accounts[i >= 0 ? i : -1] || acc;
  const structureChanged = !!prev && (!!prev.sessionExpired !== !!merged.sessionExpired || prev.presenceError === 'Session expired' !== (merged.presenceError === 'Session expired'));
  if (structureChanged && state.view === 'accounts') {
    replaceAccountCard(merged);
    maybeKeepAlive(merged);
    return;
  }

  const presEl = findByData(document, 'acct-presence', acc.id);
  if (presEl) {
    presEl.className = 'presence ' + presenceClass(acc.presence);
    presEl.innerHTML = `<span class="pd"></span>${esc(acc.presence || 'Offline')}`;
    if (acc.presenceError) presEl.setAttribute('data-tip', acc.presenceError);
    else presEl.removeAttribute('data-tip');
  }
  const gameEl = findByData(document, 'acct-game', acc.id);
  if (gameEl) {
    if (acc.game && acc.game.name) { gameEl.hidden = false; gameEl.innerHTML = icon('compass') + ' ' + esc(acc.game.name); }
    else { gameEl.hidden = true; gameEl.innerHTML = ''; }
  }
  const robuxEl = findByData(document, 'acct-robux', acc.id);
  if (robuxEl && acc.robux != null) {
    robuxEl.hidden = false;
    robuxEl.innerHTML = `${acc.premium ? '<b class="prem">P</b>' : ''}${icon('box')} ${fmtNum(acc.robux)}`;
    robuxEl.setAttribute('data-tip', 'Robux balance' + (acc.premium ? ' - Premium member' : ''));
  }
  maybeKeepAlive(state.accounts[i >= 0 ? i : -1] || acc);
}

/* ----------------------------- Keep-alive (auto-rejoin) ----------------------------- */
/* Armed per launch: if a watched account stops being in-game (crash, kick,
   disconnect), Fleet relaunches it into the same game. Rides the existing 12s
   presence stream - no extra polling. 90s cooldown + 3 strikes per account so
   a genuinely broken join can't loop forever. */
const keepAlive = { armed: new Map() }; // accountId -> {placeId, gameId, name, lastRelaunch, fails, everInGame}
const KEEPALIVE_COOLDOWN_MS = 90000;

function armKeepAlive(ids, placeId, gameId, name) {
  if (!placeId) return;
  const now = Date.now();
  ids.forEach(id => keepAlive.armed.set(id, { placeId: String(placeId), gameId: gameId || '', name: name || 'game', lastRelaunch: now, fails: 0, everInGame: false }));
  renderKeepAliveChip();
}
function disarmKeepAlive() { keepAlive.armed.clear(); renderKeepAliveChip(); }

function renderKeepAliveChip() {
  const el = $('#keepalive-chip');
  if (!el) return;
  const n = keepAlive.armed.size;
  el.hidden = !n;
  el.innerHTML = n ? `${icon('activity')} Keep-alive: ${n} account${n === 1 ? '' : 's'} <button class="btn sm ghost" data-action="keepalive-off">Stop</button>` : '';
}

async function maybeKeepAlive(acc) {
  if (!acc || !acc.id) return;
  const t = keepAlive.armed.get(acc.id);
  if (!t) return;
  const inGame = presenceClass(acc.presence) === 'ingame';
  if (inGame) { t.everInGame = true; t.fails = 0; return; }
  // Only react after the account has actually made it in once (joining takes
  // a while), then rate-limit relaunches and give up after 3 straight fails.
  if (!t.everInGame) return;
  const now = Date.now();
  if (now - t.lastRelaunch < KEEPALIVE_COOLDOWN_MS) return;
  if (t.fails >= 3) { keepAlive.armed.delete(acc.id); renderKeepAliveChip(); toast(`Keep-alive gave up on ${acc.displayName || acc.username} after 3 tries`, 'bad'); return; }
  t.lastRelaunch = now;
  t.fails += 1;
  toast(`Keep-alive: putting ${esc(acc.displayName || acc.username)} back into ${esc(t.name)}-`);
  const r = t.gameId
    ? await call(() => api.launch.join([acc.id], t.placeId, t.gameId))
    : await call(() => api.launch.accounts([acc.id], t.placeId));
  if (!(r && r.ok)) toast('Keep-alive relaunch failed - will retry', 'bad');
}

/* ----------------------------- Games view ----------------------------- */
views.games = function () {
  const g = state.games;
  mount(`
    <div class="page-head">
      <h1>Games</h1>
      <p>Browse and search Roblox experiences, then jump straight in. Joining uses the game's place ID${state.accounts.length ? ' and your selected account (or the first one).' : ' - add an account to join signed in.'}</p>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="games-search" type="text" placeholder="Search experiences-" value="${esc(g.query)}"></div>
      <button class="btn" data-action="refresh-games" data-tip="Reload popular experiences">${icon('refresh')} Refresh</button>
      <button class="btn primary" data-action="random-game" data-tip="Join a random game from the list">${icon('dice')} Random Game</button>
    </div>
    <div class="games-cats" id="games-cats"></div>
    <div class="games-tools">
      <button class="btn sm ${g.hideEmpty ? 'active-filter' : ''}" data-action="games-hide-empty">${icon('users-group')} ${g.hideEmpty ? 'Showing active only' : 'Hide empty'}</button>
    </div>
    <div class="games-grid" id="games-grid"></div>
  `);
  const inp = $('#games-search');
  if (inp) {
    let debounce = null;
    inp.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (state.view === 'games' && inp.value.trim() !== state.games.query) doGamesSearch(inp.value);
      }, 450);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); doGamesSearch(inp.value); } });
  }
  renderGamesCategories();
  if (!g.loaded && !g.loading) gamesBrowse();
  else renderGamesGrid();
};

// Category filter chips (browse mode only - Roblox explore sorts). "All" is default.
function renderGamesCategories() {
  const box = $('#games-cats');
  if (!box) return;
  const g = state.games;
  const cats = g.categories || [];
  const favs = favGames().length;
  const recents = recentGames().length;
  if (!cats.length && !favs && !recents) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const chip = (label, value, count) => {
    const n = count != null ? count : (value === 'All' ? g.list.length : g.list.filter(x => (x.categories || []).includes(value)).length);
    return `<button class="cat-chip ${g.category === value ? 'on' : ''}" data-action="games-category" data-cat="${esc(value)}">${esc(label)}<span class="cat-n">${n}</span></button>`;
  };
  box.innerHTML = (cats.length ? chip('All', 'All') : '')
    + (favs ? chip('Favorites', '__fav', favs) : '')
    + (recents ? chip('Recent', '__recent', recents) : '')
    + cats.map(c => chip(c, c)).join('');
}

function gameRating(gm) {
  const up = Number(gm.upVotes);
  const down = Number(gm.downVotes);
  const total = up + down;
  return total > 0 ? Math.round(up / total * 100) : null;
}

// Loose text match for search ranking: normalized exact > prefix > substring,
// plus per-token prefix overlap (so "grow a gard" pins "Grow a Garden" first).
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function matchScore(name, query) {
  const n = normName(name), q = normName(query);
  if (!q || !n) return 0;
  if (n === q) return 100;
  let s = 0;
  if (n.startsWith(q)) s = 80;
  else if (n.includes(q)) s = 62;
  const nt = n.split(' '), qt = q.split(' ');
  let hit = 0;
  for (const t of qt) if (t && nt.some(w => w.startsWith(t))) hit++;
  s += (hit / qt.length) * 30;
  return s;
}

function visibleGames() {
  const g = state.games;
  // Favorites and Recents render straight from their stores (kept in saved
  // order - player counts there are snapshots, not live).
  if (g.category === '__fav') return favGames();
  if (g.category === '__recent') return recentGames();
  const list = g.list.filter(game =>
    (!g.hideEmpty || Number(game.playerCount) > 0)
    && (!g.category || g.category === 'All' || (game.categories || []).includes(g.category))
  ).slice();
  if (g.query) {
    // Search mode: the API order is relevance - keep it, but float the games
    // whose names actually resemble the query to the top (stable).
    const idx = new Map(list.map((game, i) => [game, i]));
    list.sort((a, b) => matchScore(b.name, g.query) - matchScore(a.name, g.query) || idx.get(a) - idx.get(b));
  } else if (g.sort === 'rating') {
    list.sort((a, b) => (gameRating(b) == null ? -1 : gameRating(b)) - (gameRating(a) == null ? -1 : gameRating(a))
      || Number(b.playerCount || 0) - Number(a.playerCount || 0));
  } else if (g.sort === 'name') {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } else {
    list.sort((a, b) => Number(b.playerCount || 0) - Number(a.playerCount || 0));
  }
  return list;
}

function gameCard(gm) {
  const thumb = gm.thumbnail
    ? `<img loading="lazy" src="${esc(gm.thumbnail)}" alt="">`
    : `<div class="ph">${icon('compass')}</div>`;
  const rating = gameRating(gm);
  const likes = rating != null ? `<span class="likes">${icon('thumb')} ${rating}%</span>` : '';
  return `<div class="game">
    <div class="game-thumb">${thumb}<span class="game-players">${icon('users-group')} ${fmtNum(gm.playerCount)}</span></div>
    <div class="game-body">
      <div class="game-name" title="${esc(gm.name)}">${esc(gm.name)}</div>
      <div class="game-meta">${gm.creator ? '<span>' + esc(gm.creator) + '</span>' : ''}${likes}</div>
      <div class="game-actions">
        <button class="btn primary sm" data-action="join-game" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}">${icon('play')} Join</button>
        <button class="btn sm icon fav ${isFav(gm) ? 'on' : ''}" data-action="toggle-fav" data-place="${esc(gm.placeId)}" data-tip="${isFav(gm) ? 'Remove from favorites' : 'Save to favorites'}">${icon('bookmark')}</button>
        <button class="btn sm" data-action="open-servers" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}" data-tip="Browse & join a specific server">${icon('server')}</button>
        <button class="btn sm icon" data-action="open-game-web" data-place="${esc(gm.placeId)}" data-tip="Open on Roblox">${icon('box')}</button>
        <button class="btn sm icon" data-action="copy-place-id" data-place="${esc(gm.placeId)}" data-tip="Copy place ID">${icon('copy')}</button>
      </div>
    </div>
  </div>`;
}

/* ----------------------------- Server browser ----------------------------- */
const SERVER_SORTS = [
  ['best', 'Best match'],
  ['ping', 'Lowest ping'],
  ['space', 'Most space'],
  ['players', 'Most players'],
  ['fps', 'Highest FPS'],
];

function sortedServers(list, mode) {
  const out = (list || []).slice();
  const slots = s => Math.max(0, Number(s.maxPlayers || 0) - Number(s.playing || 0));
  const ping = s => Number(s.ping == null ? 999999 : s.ping);
  const fps = s => Number(s.fps == null ? -1 : s.fps);
  const fill = s => (Number(s.maxPlayers) > 0 ? Number(s.playing || 0) / Number(s.maxPlayers) : 1);
  const full = s => (slots(s) > 0 ? 0 : 1); // non-full (0) sorts before full (1)
  if (mode === 'ping') {
    out.sort((a, b) => ping(a) - ping(b) || slots(b) - slots(a));
  } else if (mode === 'space') {
    out.sort((a, b) => slots(b) - slots(a) || ping(a) - ping(b));
  } else if (mode === 'players') {
    out.sort((a, b) => full(a) - full(b) || Number(b.playing || 0) - Number(a.playing || 0) || ping(a) - ping(b));
  } else if (mode === 'fps') {
    out.sort((a, b) => full(a) - full(b) || fps(b) - fps(a) || ping(a) - ping(b));
  } else { // 'best' - has room, low ping, and not packed (a blended score, distinct from pure ping)
    const score = s => ping(s) + fill(s) * 60;
    out.sort((a, b) => full(a) - full(b) || score(a) - score(b));
  }
  return out;
}

function serverStats(list) {
  const l = list || [];
  const withPing = l.filter(s => s.ping != null);
  const withFps = l.filter(s => s.fps != null);
  const pings = withPing.map(s => Number(s.ping)).sort((a, b) => a - b);
  const avgPing = withPing.length ? Math.round(withPing.reduce((n, s) => n + Number(s.ping), 0) / withPing.length) : null;
  const bestPing = withPing.length ? Math.min(...withPing.map(s => Number(s.ping))) : null;
  const medianPing = pings.length ? pings[Math.floor(pings.length / 2)] : null;
  const avgFps = withFps.length ? Math.round(withFps.reduce((n, s) => n + Number(s.fps), 0) / withFps.length) : null;
  const peakPlayers = l.length ? Math.max(...l.map(s => Number(s.playing) || 0)) : 0;
  return { count: l.length, avgPing, bestPing, medianPing, avgFps, peakPlayers };
}

function filteredServers(sv) {
  const f = sv.filters || {};
  return (sv.list || []).filter(s => {
    const capacity = Number(s.maxPlayers) || 0;
    const occupancy = capacity ? (Number(s.playing) || 0) / capacity * 100 : 0;
    const free = Math.max(0, capacity - (Number(s.playing) || 0));
    return occupancy >= Number(f.occupancy || 0)
      && (Number(f.maxPing || 0) <= 0 || (s.ping != null && Number(s.ping) <= Number(f.maxPing)))
      && (Number(f.minFps || 0) <= 0 || (s.fps != null && Number(s.fps) >= Number(f.minFps)))
      && free >= Number(f.freeSlots || 1);
  });
}

function serverQuality(s) {
  const ping = s.ping == null ? 180 : Number(s.ping);
  const fps = s.fps == null ? 30 : Number(s.fps);
  const fill = s.maxPlayers ? Number(s.playing || 0) / Number(s.maxPlayers) : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - ping * .28 + (fps - 30) * .5 - Math.max(0, fill - .9) * 80)));
  return { score, label: score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Weak' };
}

function filterSelect(label, key, value, options) {
  return `<label class="server-filter"><span>${label}</span><select data-server-filter="${key}">
    ${options.map(([v, text]) => `<option value="${v}"${String(value) === String(v) ? ' selected' : ''}>${text}</option>`).join('')}
  </select></label>`;
}

function serverSortControls(sv, visible) {
  const sort = sv.sort || 'best';
  const st = serverStats(visible);
  const f = sv.filters || {};
  const scanText = sv.scanning ? 'Scanning Roblox pages-' : sv.deepScanned ? `${sv.scan && sv.scan.pagesScanned || 0} pages analyzed` : 'Quick sample';
  return `<div class="server-tools">
    <div class="server-tool-head"><div class="seg-wrap" role="tablist" aria-label="Sort servers">
      ${SERVER_SORTS.map(([v, label]) => `<button class="seg-chip ${sort === v ? 'on' : ''}" data-action="server-sort" data-sort="${v}">${label}</button>`).join('')}
    </div><button class="btn sm" data-action="servers-scan" ${sv.scanning ? 'disabled' : ''}>${sv.scanning ? '<span class="spinner dark"></span>' : icon('search')} Deep scan</button></div>
    <div class="server-filters">
      ${filterSelect('Occupancy', 'occupancy', f.occupancy, [[0, 'Any'], [25, '25%+'], [50, '50%+'], [75, '75%+']])}
      ${filterSelect('Max ping', 'maxPing', f.maxPing, [[0, 'Any'], [50, '50 ms'], [100, '100 ms'], [150, '150 ms'], [250, '250 ms']])}
      ${filterSelect('Min FPS', 'minFps', f.minFps, [[0, 'Any'], [30, '30'], [45, '45'], [55, '55']])}
      ${filterSelect('Free slots', 'freeSlots', f.freeSlots, [[1, '1+'], [2, '2+'], [5, '5+'], [10, '10+']])}
      <button class="server-reset" data-action="servers-filter-reset">Reset</button>
    </div>
    <div class="server-intel">
      <div><strong>${st.count}</strong><span>Visible</span></div>
      <div><strong>${st.medianPing == null ? '-' : st.medianPing + ' ms'}</strong><span>Median ping</span></div>
      <div><strong>${st.avgFps == null ? '-' : st.avgFps}</strong><span>Average FPS</span></div>
      <div><strong>${st.peakPlayers}</strong><span>Peak players</span></div>
    </div>
    <div class="server-summary">${scanText}${sv.error ? ` - ${esc(sv.error)}` : ''}</div>
  </div>`;
}

function renderServersModal() {
  const sv = state.servers;
  if (!sv) return;
  let body;
  if (sv.loading && !sv.list.length) body = `<div class="games-end"><span class="spinner dark"></span> Loading servers-</div>`;
  else if (sv.error && !sv.list.length) body = `<div class="games-end">${esc(sv.error)}</div>`;
  else if (!sv.list.length) body = `<div class="games-end">No joinable servers found - every server is full right now.</div>`;
  else {
    const visible = filteredServers(sv);
    const sorted = sortedServers(visible, sv.sort);
    body = `${serverSortControls(sv, visible)}<div class="server-list">${sorted.length ? sorted.map((s, i) => {
      const quality = serverQuality(s);
      return `
      <div class="server-row">
        <div class="server-fill"><strong>${s.playing}/${s.maxPlayers}</strong><span>players</span></div>
        <div class="server-bar"><span style="width:${s.maxPlayers ? Math.min(100, Math.round(s.playing / s.maxPlayers * 100)) : 0}%"></span></div>
        <div class="server-meta"><span class="server-quality q-${quality.label.toLowerCase()}">${quality.score} - ${quality.label}</span>${s.ping != null ? `${s.ping} ms` : ''}${s.fps != null ? ` - ${s.fps} fps` : ''}</div>
        <button class="server-copy" data-action="copy-server-id" data-server="${esc(s.id)}" data-tip="Copy server ID">${icon('copy')}</button>
        <button class="btn primary sm" data-action="join-server" data-place="${esc(sv.placeId)}" data-server="${esc(s.id)}" data-name="${esc(sv.name)}" data-tip="Server #${i + 1}">${icon('play')} Join</button>
      </div>`;
    }).join('') : '<div class="games-end">No servers match these filters.</div>'}
      ${sv.nextPageCursor ? `<button class="btn sm servers-more" data-action="servers-more">Load more servers</button>` : ''}</div>`;
  }
  const hasList = !!sv.list.length;
  openModal(`
    <div class="m-head"><h3>Servers - ${esc(sv.name)}</h3><p>Join a specific public server${state.accounts.length ? ' with your selected account' : ''}.</p></div>
    <div class="m-body">${body}</div>
    <div class="m-foot">
      ${hasList ? `<button class="btn" data-action="servers-refresh" style="margin-right:auto" data-tip="Reload the server list">${icon('refresh')} Refresh</button>
      <button class="btn ${sv.autoRefresh ? 'on' : ''}" data-action="servers-auto-refresh" data-tip="Refresh this server list every 30 seconds">Live ${sv.autoRefresh ? 'on' : 'off'}</button>` : ''}
      <button class="btn" data-action="modal-cancel">Close</button>
      ${hasList ? `<button class="btn primary" data-action="join-best" data-tip="Join the top server for this filter">${icon('play')} Join best</button>` : ''}
    </div>`, 'server-modal');
}

async function openServersModal(placeId, name) {
  state.servers = {
    placeId: String(placeId), name: name || 'game', list: [], cursor: null, nextPageCursor: null,
    loading: true, scanning: false, deepScanned: false, scan: null, error: null, sort: 'best',
    filters: { occupancy: 0, maxPing: 0, minFps: 0, freeSlots: 1 },
    autoRefresh: false, refreshTimer: null, requestId: 0,
  };
  renderServersModal();
  await loadServers(false);
}

async function loadServers(append) {
  const sv = state.servers;
  if (!sv) return;
  const requestId = ++sv.requestId;
  sv.loading = true;
  sv.error = null;
  renderServersModal();
  const r = await call(() => api.games.servers(sv.placeId, append ? sv.nextPageCursor : null), undefined, 45000);
  if (!state.servers || state.servers !== sv || sv.requestId !== requestId) return;
  sv.loading = false;
  if (r && r.ok) {
    if (append) {
      const seen = new Set(sv.list.map(s => s.id));
      sv.list = sv.list.concat((r.servers || []).filter(s => !seen.has(s.id)));
    } else {
      sv.list = r.servers || [];
    }
    sv.nextPageCursor = r.nextPageCursor;
    if (r.scan) sv.scan = r.scan;
  } else sv.error = (r && r.error) || 'Could not load servers.';
  renderServersModal();
}

async function deepScanServers(silent) {
  const sv = state.servers;
  if (!sv || sv.scanning) return;
  const requestId = ++sv.requestId;
  sv.scanning = true;
  sv.error = null;
  renderServersModal();
  const r = await call(() => api.games.scanServers(sv.placeId, 8), undefined, 120000);
  if (!state.servers || state.servers !== sv || sv.requestId !== requestId) return;
  sv.scanning = false;
  if (r && r.ok) {
    const byId = new Map(sv.list.map(s => [s.id, s]));
    (r.servers || []).forEach(s => byId.set(s.id, s));
    sv.list = Array.from(byId.values());
    sv.deepScanned = true;
    sv.scan = r.scan || null;
    if (!silent) toast(`Analyzed ${r.scan && r.scan.examined || sv.list.length} servers`, 'good');
  } else {
    sv.error = (r && r.error) || 'Deep scan failed.';
    if (!silent) toast(sv.error, 'bad');
  }
  renderServersModal();
}

function setServerAutoRefresh(enabled) {
  const sv = state.servers;
  if (!sv) return;
  if (sv.refreshTimer) clearInterval(sv.refreshTimer);
  sv.refreshTimer = null;
  sv.autoRefresh = !!enabled;
  if (sv.autoRefresh) sv.refreshTimer = setInterval(() => {
    if (state.servers === sv && !sv.loading && !sv.scanning) loadServers(false);
  }, 30000);
  renderServersModal();
}

async function joinServer(placeId, serverId, name) {
  if (!state.accounts.length) { toast('Add an account to join a server', 'bad'); closeModal(); state.servers = null; setView('accounts'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  const r = await call(() => api.launch.join(ids, String(placeId), String(serverId)));
  if (r && r.ok) {
    toast(`Joining ${name} - ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
    recordRecentGame(gameByPlaceId(placeId));
    closeModal(); state.servers = null;
  } else toast((r && r.error) || 'Join failed', 'bad');
}

function renderGamesGrid() {
  const grid = $('#games-grid');
  if (!grid) return;
  const g = state.games;
  if (g.loading && !g.list.length) { grid.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Loading experiences-</div>`; return; }
  if (g.error && !g.list.length) { grid.innerHTML = `<div class="games-end">${esc(g.error)}</div>`; return; }
  if (!g.list.length) { grid.innerHTML = `<div class="games-end">No experiences found.</div>`; return; }
  const list = visibleGames();
  if (!list.length) { grid.innerHTML = `<div class="games-end">No active experiences match this filter.</div>`; return; }
  let tail = '';
  if (g.nextPageToken && g.query) tail = `<div class="games-end"><span class="spinner dark"></span> Scroll for more-</div>`;
  else if (g.query) tail = `<div class="games-end">End of results</div>`;
  grid.innerHTML = list.map(gameCard).join('') + tail;
}

async function gamesBrowse() {
  const g = state.games;
  g.loading = true; g.error = null; g.query = ''; g.list = []; g.nextPageToken = null;
  g.categories = []; g.category = 'All';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  const r = await call(() => api.games.browse());
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || []; }
  else g.error = (r && r.error) || 'Could not load games.';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
}

async function doGamesSearch(query) {
  const g = state.games;
  g.query = (query || '').trim(); g.loading = true; g.error = null; g.list = []; g.nextPageToken = null;
  g.categories = []; g.category = 'All';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  const r = await call(() => (g.query ? api.games.search(g.query) : api.games.browse()));
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || []; }
  else g.error = (r && r.error) || 'Search failed.';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
}

async function gamesLoadMore() {
  const g = state.games;
  if (g.loading || !g.nextPageToken || !g.query) return;
  g.loading = true;
  const r = await call(() => api.games.search(g.query, g.nextPageToken));
  g.loading = false;
  if (r && r.ok) { g.list = g.list.concat(r.games); g.nextPageToken = r.nextPageToken; if (state.view === 'games') renderGamesGrid(); }
}

async function joinPlace(placeId, name) {
  if (!placeId) { toast('No place id for this game', 'bad'); return; }
  if (!state.accounts.length) { toast('Add an account to join games', 'bad'); setView('accounts'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  toast('Joining ' + (name || 'game') + (ids.length > 1 ? ' with ' + ids.length + ' accounts' : '') + '-');
  const r = await call(() => api.launch.accounts(ids, String(placeId)));
  if (r && r.ok) {
    toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
    recordRecentGame(gameByPlaceId(placeId));
  } else toast((r && r.error) || 'Join failed', 'bad');
}

/* ----------------------------- People view ----------------------------- */
views.people = function () {
  if (state.people.route === 'friends') return renderFriendsPage();
  if (state.people.route === 'profile') return renderPeopleProfile();
  if (state.people.route === 'server') return renderServerPage();
  return renderPeopleHome();
};

function peopleSectionTabs() {
  const tab = state.people.tab || 'people';
  return `<div class="segmented compact" aria-label="People section" style="margin:0 0 16px">
    <button data-action="people-tab" data-tab="people" class="${tab === 'people' ? 'on' : ''}">People</button>
    <button data-action="people-tab" data-tab="server" class="${tab === 'server' ? 'on' : ''}">Server</button>
  </div>`;
}

function renderPeopleHome() {
  const pp = state.people;
  const search = pp.search;
  const onboarding = state.accounts.length ? '' : `
    <div class="banner warn" style="margin-bottom:14px"><svg class="b-ico"><use href="#i-user-plus"/></svg>
      <div class="b-text"><b>Add a Roblox account to unlock People</b><span>Search, friends, live presence and Join buttons all need a signed-in session - Roblox hides them from anonymous apps. Sign in once and everything here lights up.</span></div>
      <div class="b-actions"><button class="btn sm primary" data-action="goto-accounts">Add account</button></div>
    </div>`;
  mount(`
    <div class="page-head">
      <h1>People</h1>
      <p>Find Roblox users or browse friends shared across your saved accounts.</p>
    </div>
    ${peopleSectionTabs()}
    ${onboarding}
    <div class="toolbar people-searchbar">
      <div class="search">${icon('search')}<input id="people-search" type="text" maxlength="50" placeholder="Username, display name, or user ID" value="${esc(search.query)}"></div>
      <button class="btn" data-action="people-search-clear" ${search.searched || search.query ? '' : 'disabled'}>Clear</button>
      <button class="btn primary" data-action="people-search" ${search.loading ? 'disabled' : ''}>${search.loading ? '<span class="spinner"></span>' : icon('search')} Search</button>
    </div>
    <div class="section-title">Browse</div>
    <button class="people-entry" data-action="open-friends">
      <span class="people-entry-icon">${icon('users-group')}</span>
      <span><strong>Friends</strong><small>${pp.loaded ? `${fmtNum(pp.total)} unique friend${pp.total === 1 ? '' : 's'}` : 'Across all saved accounts'}</small></span>
      ${icon('chevron-right')}
    </button>
    <div id="people-search-results" class="people-results"></div>
  `);
  const input = $('#people-search');
  if (input) {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runPeopleSearch(input.value); });
    input.focus();
  }
  renderPeopleSearchResults();
}

function personMatchesFilter(u) {
  const filter = state.people.filter || 'all';
  const status = String(u && u.presence || 'Offline').toLowerCase();
  if (filter === 'ingame') return status.includes('game');
  if (filter === 'online') return status === 'online' || status.includes('studio');
  if (filter === 'offline') return status === 'offline';
  return true;
}

function personPresenceRank(u) {
  const status = String(u && u.presence || 'Offline').toLowerCase();
  if (status.includes('game')) return 0;
  if (status === 'online' || status.includes('studio')) return 1;
  if (status === 'unknown') return 3;
  return 2;
}

function visiblePeople(list) {
  const out = (list || []).filter(personMatchesFilter).slice();
  if (state.people.sort === 'name') {
    out.sort((a, b) => String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
  } else if (state.people.sort === 'status') {
    out.sort((a, b) => personPresenceRank(a) - personPresenceRank(b)
      || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
  }
  return out;
}

function peopleTools() {
  const filter = state.people.filter || 'all';
  const sort = state.people.sort || 'status';
  return `<div class="people-tools">
    <div class="segmented compact" aria-label="Filter people">
      <button data-action="people-filter" data-filter="all" class="${filter === 'all' ? 'on' : ''}">All</button>
      <button data-action="people-filter" data-filter="ingame" class="${filter === 'ingame' ? 'on' : ''}">In game</button>
      <button data-action="people-filter" data-filter="online" class="${filter === 'online' ? 'on' : ''}">Online</button>
      <button data-action="people-filter" data-filter="offline" class="${filter === 'offline' ? 'on' : ''}">Offline</button>
    </div>
    <div class="segmented compact" aria-label="Sort people">
      <button data-action="people-sort" data-sort="status" class="${sort === 'status' ? 'on' : ''}">Live first</button>
      <button data-action="people-sort" data-sort="name" class="${sort === 'name' ? 'on' : ''}">Name</button>
    </div>
  </div>`;
}

function personJoinButton(u, className) {
  if (!u || !u.canJoin) return '';
  const game = u.game || {};
  return `<button class="${className || 'btn primary sm'}" data-action="join-person" data-user="${esc(u.userId)}" data-place="${esc(game.placeId || u.placeId || '')}" data-game="${esc(game.gameId || u.gameId || '')}" data-name="${esc(u.displayName)}">${icon('play')} Join</button>`;
}

function personCardActions(u) {
  return `${personJoinButton(u)}
    <button class="btn sm icon" data-action="copy-user-id" data-user="${esc(u.userId)}" data-tip="Copy user ID">${icon('copy')}</button>
    <button class="btn sm" data-action="open-person" data-user="${esc(u.userId)}">View</button>`;
}

function personCard(u) {
  const presClass = presenceClass(u.presence);
  const avatar = u.avatar ? `<img class="avatar" loading="lazy" src="${esc(u.avatar)}" alt="">` : `<div class="avatar"></div>`;
  const gameLine = `<div class="acct-game" data-person-game="${esc(u.userId)}"${u.game && u.game.name ? '' : ' hidden'}>${u.game && u.game.name ? icon('compass') + ' ' + esc(u.game.name) : ''}</div>`;
  const sources = u.connectedAccounts && u.connectedAccounts.length
    ? `<div class="friend-source">Friend of ${esc(u.connectedAccounts.map(a => a.displayName).join(', '))}</div>` : '';
  return `<div class="person" data-person-card="${esc(u.userId)}">
    <div class="top">
      ${avatar}
      <div class="who">
        <div class="dname">${esc(u.displayName)} ${u.hasVerifiedBadge ? `<span class="verified" data-tip="Verified">${icon('check-circle')}</span>` : ''}</div>
        <div class="uname">@${esc(u.username)}</div>
      </div>
    </div>
    ${u.bio ? `<div class="person-bio">${esc(u.bio)}</div>` : ''}
    ${sources}
    <div class="row-split" style="margin-top:auto">
      <span class="presence ${presClass}" data-person-presence="${esc(u.userId)}"><span class="pd"></span>${esc(u.presence)}</span>
      <span class="inline" data-person-actions="${esc(u.userId)}">${personCardActions(u)}</span>
    </div>
    ${gameLine}
  </div>`;
}

function serverStatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

function serverHealthText(u) {
  const stats = u && u.stats || {};
  const health = serverStatNumber(stats.health != null ? stats.health : u && u.health);
  const maxHealth = serverStatNumber(stats.maxHealth != null ? stats.maxHealth : u && u.maxHealth);
  if (health && maxHealth) return `${health} / ${maxHealth}`;
  if (health) return health;
  return 'Unknown';
}

function serverTeamText(u) {
  const stats = u && u.stats || {};
  return String((stats.team || u && u.team || '')).trim() || 'No team';
}

function serverPersonCard(u) {
  const avatar = u.avatar ? `<img class="avatar" loading="lazy" src="${esc(u.avatar)}" alt="">` : `<div class="avatar"></div>`;
  return `<div class="person server-person" data-person-card="${esc(u.userId)}">
    <div class="top">
      <span class="server-avatar-slot" data-server-avatar="${esc(u.userId)}">${avatar}</span>
      <div class="who">
        <div class="dname" data-server-dname="${esc(u.userId)}">${esc(u.displayName)}</div>
        <div class="uname" data-server-uname="${esc(u.userId)}">@${esc(u.username)}</div>
      </div>
    </div>
    <div class="server-person-stats">
      <div><span>Health</span><strong data-server-health="${esc(u.userId)}">${esc(serverHealthText(u))}</strong></div>
      <div><span>Team</span><strong data-server-team="${esc(u.userId)}">${esc(serverTeamText(u))}</strong></div>
    </div>
    <div class="row-split" style="margin-top:auto">
      <span class="server-person-id">ID ${esc(u.userId || '')}</span>
      <span class="inline">
        <button class="btn sm icon" data-action="copy-user-id" data-user="${esc(u.userId)}" data-tip="Copy user ID">${icon('copy')}</button>
        <button class="btn sm" data-action="open-person" data-user="${esc(u.userId)}">View</button>
      </span>
    </div>
  </div>`;
}

function sortServerPeople(list) {
  return (list || []).slice().sort((a, b) => String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
}

function serverRosterSignature(list, search) {
  const mode = search && search.searched ? `search:${search.query || ''}` : 'all';
  return `${mode}|${(list || []).map(u => Number(u && u.userId) || 0).join(',')}`;
}

function patchServerRosterCards(list) {
  for (const u of (list || [])) {
    const id = String(u && u.userId || '');
    if (!id) continue;
    const dname = findByData(document, 'server-dname', id);
    if (dname) dname.textContent = u.displayName || u.username || 'Unknown';
    const uname = findByData(document, 'server-uname', id);
    if (uname) uname.textContent = '@' + (u.username || u.displayName || 'Unknown');
    const health = findByData(document, 'server-health', id);
    if (health) health.textContent = serverHealthText(u);
    const team = findByData(document, 'server-team', id);
    if (team) team.textContent = serverTeamText(u);
    const avatar = findByData(document, 'server-avatar', id);
    if (avatar) {
      const img = avatar.querySelector('img.avatar');
      if (u.avatar) {
        if (img) {
          if (img.getAttribute('src') !== u.avatar) img.setAttribute('src', u.avatar);
        } else {
          avatar.innerHTML = `<img class="avatar" loading="lazy" src="${esc(u.avatar)}" alt="">`;
        }
      } else if (img) {
        avatar.innerHTML = '<div class="avatar"></div>';
      }
    }
  }
}

function renderFriendsPage() {
  const pp = state.people;
  const start = pp.total ? pp.page * pp.pageSize + 1 : 0;
  const end = Math.min(pp.total, (pp.page + 1) * pp.pageSize);
  mount(`
    <button class="back-link" data-action="people-home">${icon('chevron-left')} Back to People</button>
    <div class="page-head compact">
      <h1>Friends</h1>
      <p>Public profiles from every saved account, merged without duplicates.</p>
    </div>
    <div class="row-split" style="margin-bottom:16px">
      <div class="section-title" style="margin:0">${pp.total ? `${start}-${end} of ${pp.total}` : 'Friends'}</div>
      <div class="inline">
        <button class="btn sm" data-action="people-prev" ${pp.hasPrev ? '' : 'disabled'}>${icon('chevron-left')} Previous</button>
        <button class="btn sm" data-action="people-next" ${pp.hasNext ? '' : 'disabled'}>Next ${icon('chevron-right')}</button>
        <button class="btn sm" data-action="people-refresh" data-tip="Reload">${icon('refresh')}</button>
      </div>
    </div>
    ${peopleTools()}
    <div class="people-grid" id="people-grid"></div>
  `);
  if (!pp.loaded && !pp.loading) loadPeople(0);
  else renderPeopleGrid();
}

function renderServerPage() {
  const server = state.people.server;
  const search = server.search;
  const summary = server.total
    ? `${fmtNum(server.total)} player${server.total === 1 ? '' : 's'}`
    : 'Scanning';
  const updated = server.updatedAt ? `Updated ${relTime(server.updatedAt)}` : 'Waiting for roster';
  mount(`
    <button class="back-link" data-action="people-home">${icon('chevron-left')} Back to People</button>
    <div class="page-head compact">
      <h1>Server</h1>
      <p>Inspect the active server roster with memory-read health and team when available.</p>
    </div>
    ${peopleSectionTabs()}
    <div class="server-roster-meta">
      <div class="row-split" style="align-items:flex-start;gap:14px">
        <div>
          <div id="server-roster-count" class="section-title" style="margin:0">${summary}</div>
          <div class="hint">${updated}${server.note ? ` - ${esc(server.note)}` : ''}</div>
        </div>
        <span class="server-roster-refresh">2s refresh</span>
        <button class="btn sm icon" data-action="server-refresh" data-tip="Refresh now">${icon('refresh')}</button>
      </div>
    </div>
    <div class="toolbar people-searchbar">
      <div class="search">${icon('search')}<input id="server-search" type="text" maxlength="50" placeholder="Search only the players in this server" value="${esc(search.query)}"></div>
      <button class="btn" data-action="server-search-clear" ${search.searched || search.query ? '' : 'disabled'}>Clear</button>
      <button class="btn primary" data-action="server-search" ${server.loading ? 'disabled' : ''}>${server.loading ? '<span class="spinner"></span>' : icon('search')} Search</button>
    </div>
    <div id="server-search-results" class="people-results"></div>
  `);
  const input = $('#server-search');
  if (input) {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runServerSearch(input.value); });
    input.focus();
  }
  if (!server.loaded && !server.loading) {
    // Kick the load after paint so the tab opens immediately and the backend
    // work cannot block the initial render path.
    setTimeout(() => { if (state.view === 'people' && state.people.route === 'server') loadServerPeople(false); }, 0);
  }
  else renderServerSearchResults();
}

function renderServerMeta() {
  const server = state.people.server;
  const count = $('#server-roster-count');
  if (count) count.textContent = server.total ? `${fmtNum(server.total)} player${server.total === 1 ? '' : 's'}` : 'Scanning';
  const updated = $('.server-roster-meta .hint');
  if (updated) updated.textContent = `${server.updatedAt ? `Updated ${relTime(server.updatedAt)}` : 'Waiting for roster'}${server.note ? ` - ${server.note}` : ''}`;
}

function renderPeopleGrid() {
  const grid = $('#people-grid');
  if (!grid) return;
  const pp = state.people;
  if (pp.loading) { grid.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Loading people-</div>`; return; }
  if (pp.error) { grid.innerHTML = `<div class="games-end">${esc(pp.error)}</div>`; return; }
  if (!pp.list.length) { grid.innerHTML = `<div class="card"><div class="empty"><div class="e-ico">${icon('users-group')}</div><h3>No people to show</h3><p>Add an account with friends to populate this list.</p></div></div>`; return; }
  const list = visiblePeople(pp.list);
  grid.innerHTML = list.length
    ? list.map(personCard).join('')
    : `<div class="games-end">No people match this filter.</div>`;
}

async function loadPeople(page) {
  const pp = state.people;
  pp.loading = true; pp.error = null;
  if (state.view === 'people' && pp.route === 'friends') renderPeopleGrid();
  const r = await call(() => api.people.list(page, pp.pageSize, false));
  pp.loading = false; pp.loaded = true;
  if (r && r.ok) {
    pp.list = r.people; pp.page = r.page; pp.total = r.total; pp.hasNext = r.hasNext; pp.hasPrev = r.hasPrev;
  } else {
    pp.list = []; pp.error = (r && r.error) || 'Could not load people.';
  }
  if (state.view === 'people' && pp.route === 'friends') views.people();
}

async function refreshPeople() {
  const pp = state.people;
  pp.loading = true; pp.error = null;
  renderPeopleGrid();
  const r = await call(() => api.people.list(pp.page, pp.pageSize, true));
  pp.loading = false; pp.loaded = true;
  if (r && r.ok) {
    pp.list = r.people; pp.page = r.page; pp.total = r.total; pp.hasNext = r.hasNext; pp.hasPrev = r.hasPrev;
  } else pp.error = (r && r.error) || 'Could not load friends.';
  if (state.view === 'people' && pp.route === 'friends') views.people();
}

function renderPeopleSearchResults() {
  const root = $('#people-search-results');
  if (!root) return;
  const search = state.people.search;
  if (search.loading) {
    root.innerHTML = `<div class="people-search-state"><span class="spinner dark"></span><div><strong>Searching Roblox</strong><small>Checking matching public profiles...</small></div></div>`;
    return;
  }
  if (search.error) {
    root.innerHTML = `<div class="people-search-state error">${icon('alert-circle')}<div><strong>Search paused</strong><small>${esc(search.error)}</small></div>
      ${search.retryable ? `<button class="btn sm" data-action="people-search-retry">${icon('refresh')} Retry</button>` : ''}</div>`;
    return;
  }
  if (search.loading) {
    root.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Searching people-</div>`;
    return;
  }
  if (search.error) {
    root.innerHTML = `<div class="people-result-head"><div class="section-title">Search</div></div><div class="games-end">${esc(search.error)}</div>`;
    return;
  }
  if (!search.searched) { root.innerHTML = ''; return; }
  const notice = search.notice
    ? `<div class="people-search-notice ${search.source === 'friends' ? 'warn' : ''}">${icon(search.source === 'friends' ? 'alert-circle' : 'check-circle')}<span>${esc(search.notice)}${search.cached ? ' (cached)' : ''}</span></div>`
    : '';
  root.innerHTML = `
    ${notice}
    <div class="people-result-head"><div class="section-title">Results for -${esc(search.query)}-</div><span>${search.list.length} shown</span></div>
    ${search.list.length ? peopleTools() : ''}
    <div class="people-grid">${visiblePeople(search.list).length ? visiblePeople(search.list).map(personCard).join('') : `<div class="games-end">${search.list.length ? 'No people match this filter.' : 'No people found.'}</div>`}</div>
    ${search.nextPageCursor ? `<button class="btn people-more" data-action="people-search-more">Show more</button>` : ''}`;
}

function setPeopleSearchBusy(busy) {
  const button = document.querySelector('[data-action="people-search"]');
  if (button) button.disabled = !!busy;
}

function clearPeopleSearch() {
  const requestId = state.people.search.requestId + 1;
  state.people.search = {
    query: '', list: [], nextPageCursor: null, loading: false, error: null,
    searched: false, requestId, notice: null, source: null, cached: false, retryable: false,
  };
  if (state.view === 'people' && state.people.route === 'home') renderPeopleHome();
}

async function runPeopleSearch(query, append) {
  const search = state.people.search;
  if (search.loading) return;
  const q = String(query == null ? search.query : query).trim();
  if (q.length < 2) { search.error = 'Type at least 2 characters.'; search.searched = true; renderPeopleSearchResults(); return; }
  if (!append) { search.query = q; search.list = []; search.nextPageCursor = null; }
  const requestId = ++search.requestId;
  search.loading = true; search.error = null; search.searched = true; search.notice = null;
  search.source = null; search.cached = false; search.retryable = false;
  setPeopleSearchBusy(true);
  renderPeopleSearchResults();
  const r = await call(() => api.people.search(search.query, append ? search.nextPageCursor : null));
  if (requestId !== search.requestId) return;
  search.loading = false;
  setPeopleSearchBusy(false);
  if (r && r.ok) {
    search.list = append ? search.list.concat(r.people || []) : (r.people || []);
    search.nextPageCursor = r.nextPageCursor || null;
    search.notice = r.notice || null;
    search.source = r.source || 'keyword';
    search.cached = !!r.cached;
  } else {
    search.error = (r && r.error) || 'Search failed.';
    search.retryable = !!(r && r.retryable);
  }
  if (state.view === 'people' && state.people.route === 'home') renderPeopleSearchResults();
}

function renderServerSearchResults() {
  const root = $('#server-search-results');
  if (!root) return;
  const server = state.people.server;
  const search = server.search;
  if (server.loading && !server.loaded) {
    root.dataset.serverRosterSignature = '';
    root.innerHTML = `<div class="people-search-state"><span class="spinner dark"></span><div><strong>Checking the server</strong><small>Loading the people currently detected in the server...</small></div></div>`;
    return;
  }
  if (server.error) {
    root.dataset.serverRosterSignature = '';
    root.innerHTML = `<div class="people-search-state error">${icon('alert-circle')}<div><strong>Server list unavailable</strong><small>${esc(server.error)}</small></div>
      <button class="btn sm" data-action="server-refresh">${icon('refresh')} Retry</button></div>`;
    return;
  }
  if (search.error) {
    root.dataset.serverRosterSignature = '';
    root.innerHTML = `<div class="people-search-state error">${icon('alert-circle')}<div><strong>Search paused</strong><small>${esc(search.error)}</small></div></div>`;
    return;
  }
  if (!server.loaded) { root.dataset.serverRosterSignature = ''; root.innerHTML = ''; return; }
  const sourceList = Array.isArray(search.searched ? search.list : server.list) ? (search.searched ? search.list : server.list) : [];
  const visible = sortServerPeople(sourceList);
  const total = sourceList.length;
  const empty = search.searched
    ? 'No one in the current server matches that search.'
    : 'No players are available for this server yet.';
  const signature = serverRosterSignature(visible, search);
  if (root.dataset.serverRosterSignature === signature) {
    patchServerRosterCards(visible);
    return;
  }
  root.innerHTML = `
    ${search.searched ? `<div class="people-result-head"><div class="section-title">Results for "${esc(search.query)}"</div><span>${search.list.length} shown</span></div>` : ''}
    <div class="people-grid">${total && visible.length ? visible.map(serverPersonCard).join('') : `<div class="games-end">${empty}</div>`}</div>`;
  root.dataset.serverRosterSignature = signature;
}

async function loadServerPeople(force, options) {
  const silent = !!(options && options.silent);
  const server = state.people.server;
  if (server.refreshing) return;
  server.refreshing = true;
  if (!silent) server.loading = true;
  server.error = null;
  if (!silent && state.view === 'people' && state.people.route === 'server') renderServerSearchResults();
  try {
    const r = await call(() => api.people.serverList(!!force));
    server.loaded = true;
    if (r && r.ok) {
      const rows = Array.isArray(r.people) ? r.people : [];
      server.list = rows.map(p => ({
        userId: p && p.userId != null ? Number(p.userId) || null : null,
        username: String((p && p.username) || (p && p.displayName) || 'Unknown'),
        displayName: String((p && p.displayName) || (p && p.username) || 'Unknown'),
        presence: String((p && p.presence) || 'In game'),
        lastOnline: p && p.lastOnline || null,
        game: p && p.game ? p.game : null,
        canJoin: !!(p && p.canJoin),
        avatar: p && p.avatar || null,
        stats: p && p.stats || {},
        team: p && p.team || p && p.stats && p.stats.team || null,
        health: p && p.health != null ? Number(p.health) : p && p.stats && p.stats.health != null ? Number(p.stats.health) : null,
        maxHealth: p && p.maxHealth != null ? Number(p.maxHealth) : p && p.stats && p.stats.maxHealth != null ? Number(p.stats.maxHealth) : null,
        connectedAccounts: Array.isArray(p && p.connectedAccounts) ? p.connectedAccounts : [],
        bio: p && p.bio || '',
        hasVerifiedBadge: !!(p && p.hasVerifiedBadge),
      }));
      if (server.search.searched && server.search.query) applyServerSearchFilter();
      server.total = Number(r.total) || server.list.length;
      server.updatedAt = r.updatedAt || null;
      server.note = r.note || null;
      server.error = null;
    } else {
      if (!silent || !server.loaded) {
        server.list = [];
        server.total = 0;
      }
      server.error = (r && r.error) || 'Could not load the current server players.';
    }
  } catch (err) {
    const hadLoaded = server.loaded;
    server.loaded = true;
    if (!silent || !hadLoaded) {
      server.list = [];
      server.total = 0;
    }
    server.error = (err && err.message) || 'Could not load the current server players.';
  } finally {
    server.refreshing = false;
    server.loading = false;
  }
  if (state.view === 'people' && state.people.route === 'server') {
    renderServerMeta();
    renderServerSearchResults();
  }
}

function clearServerSearch() {
  state.people.server.search = {
    query: '', list: [], loading: false, error: null, searched: false, requestId: state.people.server.search.requestId + 1,
  };
  if (state.view === 'people' && state.people.route === 'server') renderServerSearchResults();
}

function applyServerSearchFilter() {
  const server = state.people.server;
  const search = server.search;
  const needle = String(search.query || '').trim().toLowerCase();
  search.list = needle ? server.list.filter(user => {
    const username = String(user && user.username || '').toLowerCase();
    const displayName = String(user && user.displayName || '').toLowerCase();
    const userId = String(user && user.userId || '');
    const team = String(serverTeamText(user)).toLowerCase();
    return username.includes(needle) || displayName.includes(needle) || userId.includes(needle) || team.includes(needle);
  }) : [];
}

async function runServerSearch(query) {
  const server = state.people.server;
  const search = server.search;
  if (server.loading) return;
  const q = String(query == null ? search.query : query).trim();
  if (!q) { clearServerSearch(); return; }
  if (q.length < 2) { search.error = 'Type at least 2 characters.'; search.searched = true; renderServerSearchResults(); return; }
  search.query = q;
  search.loading = true;
  search.error = null;
  search.searched = true;
  renderServerSearchResults();
  applyServerSearchFilter();
  search.loading = false;
  renderServerSearchResults();
}

let peoplePresenceBusy = false;
function mergePresence(user, fresh) {
  if (!user || !fresh) return user;
  return Object.assign({}, user, fresh, {
    placeId: fresh.game && fresh.game.placeId || null,
    gameId: fresh.game && fresh.game.gameId || null,
  });
}

function presenceChanged(before, after) {
  const a = before && before.game || {};
  const b = after && after.game || {};
  return String(before && before.presence || '') !== String(after && after.presence || '')
    || !!(before && before.canJoin) !== !!(after && after.canJoin)
    || String(a.name || '') !== String(b.name || '')
    || String(a.placeId || '') !== String(b.placeId || '')
    || String(a.gameId || '') !== String(b.gameId || '');
}

function profileHeroActions(u) {
  return `${personJoinButton(u, 'btn primary')}
    <button class="btn" data-action="ext-link" data-url="${esc(u.profileUrl || `https://www.roblox.com/users/${u.userId}/profile`)}">Open on Roblox</button>`;
}

function profileLivePanel(u) {
  if (!u || !u.game) return '';
  return `<div class="now-playing${u.canJoin ? ' joinable' : ''}">${icon('compass')}
    <span><strong>${esc(u.game.name)}</strong><small>${u.canJoin ? 'Playing now - Fleet checks access when you join' : 'Currently playing'}</small></span>
    ${personJoinButton(u)}</div>`;
}

function patchPersonPresence(user) {
  if (!user || !user.userId) return;
  const id = String(user.userId);
  findAllByData(document, 'person-presence', id).forEach(el => {
    el.className = 'presence ' + presenceClass(user.presence);
    el.innerHTML = `<span class="pd"></span>${esc(user.presence || 'Offline')}`;
  });
  findAllByData(document, 'person-game', id).forEach(el => {
    if (user.game && user.game.name) {
      el.hidden = false;
      el.innerHTML = icon('compass') + ' ' + esc(user.game.name);
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
  });
  findAllByData(document, 'person-actions', id).forEach(el => {
    el.innerHTML = personCardActions(user);
  });
  findAllByData(document, 'person-card', id).forEach(el => {
    el.hidden = !personMatchesFilter(user);
  });
  const profileActions = findByData(document, 'profile-actions', id);
  if (profileActions) profileActions.innerHTML = profileHeroActions(user);
  const live = findByData(document, 'profile-live', id);
  if (live) live.innerHTML = profileLivePanel(user);
}

/** Poll visible users, then patch only cards whose live state actually changed. */
async function refreshVisiblePeoplePresence() {
  if (!api || document.hidden || peoplePresenceBusy || state.view !== 'people') return;
  const pp = state.people;
  let users = [];
  if (pp.route === 'home' && pp.search.searched) users = pp.search.list;
  else if (pp.route === 'friends') users = pp.list;
  else if (pp.route === 'profile' && pp.detail.profile) users = [pp.detail.profile];
  const ids = Array.from(new Set(users.map(u => Number(u && u.userId)).filter(Boolean)));
  if (!ids.length) return;
  peoplePresenceBusy = true;
  const r = await call(() => api.people.presence(ids), null, 12000);
  peoplePresenceBusy = false;
  if (!r || !r.ok || !Array.isArray(r.people)) return;
  const byId = new Map(r.people.map(item => [Number(item.userId), item]));
  if (pp.route === 'home') {
    pp.search.list = pp.search.list.map(user => {
      const next = mergePresence(user, byId.get(Number(user.userId)));
      if (presenceChanged(user, next)) patchPersonPresence(next);
      return next;
    });
  } else if (pp.route === 'friends') {
    pp.list = pp.list.map(user => {
      const next = mergePresence(user, byId.get(Number(user.userId)));
      if (presenceChanged(user, next)) patchPersonPresence(next);
      return next;
    });
  } else if (pp.route === 'profile' && pp.detail.profile) {
    const previous = pp.detail.profile;
    const next = mergePresence(previous, byId.get(Number(previous.userId)));
    pp.detail.profile = next;
    if (presenceChanged(previous, next)) patchPersonPresence(next);
  }
}

function peopleStat(label, value) {
  return `<div class="profile-stat"><strong>${fmtNum(value)}</strong><span>${esc(label)}</span></div>`;
}

function profileListSection(title, items, emptyText, renderItem) {
  return `<section class="profile-section"><h2>${esc(title)} <span>${items.length}</span></h2>
    ${items.length ? `<div class="profile-list">${items.map(renderItem).join('')}</div>` : `<p class="profile-empty">${esc(emptyText)}</p>`}</section>`;
}

function profileGameSection(title, games) {
  return profileListSection(title, games, 'Nothing public to show.', game => `
    <div class="profile-game">
      ${game.thumbnail ? `<img src="${esc(game.thumbnail)}" loading="lazy" alt="">` : `<span class="profile-game-ph">${icon('compass')}</span>`}
      <span><strong>${esc(game.name)}</strong><small>${game.visits ? `${fmtNum(game.visits)} visits` : 'Public experience'}</small></span>
      ${game.rootPlaceId ? `<button class="btn sm" data-action="join-game" data-place="${esc(game.rootPlaceId)}" data-name="${esc(game.name)}">${icon('play')} Join</button>` : ''}
    </div>`);
}

function accountAge(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'today';
  const years = Math.floor(days / 365);
  if (years >= 1) { const mo = Math.floor((days - years * 365) / 30); return years + ' yr' + (years === 1 ? '' : 's') + (mo ? ` ${mo} mo` : ''); }
  const months = Math.floor(days / 30);
  if (months >= 1) return months + ' month' + (months === 1 ? '' : 's');
  return days + ' day' + (days === 1 ? '' : 's');
}

function renderPeopleProfile() {
  const detail = state.people.detail;
  const backLabel = state.people.returnRoute === 'friends'
    ? 'Back to Friends'
    : (state.people.returnRoute === 'server' ? 'Back to Server' : 'Back to People');
  if (detail.loading) {
    mount(`<button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button><div class="profile-loading"><span class="spinner dark"></span> Loading public profile data-</div>`);
    return;
  }
  if (detail.error || !detail.profile) {
    mount(`<button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button><div class="card"><div class="empty"><div class="e-ico">${icon('alert-circle')}</div><h3>Profile unavailable</h3><p>${esc(detail.error || 'Could not load this profile.')}</p></div></div>`);
    return;
  }
  const u = detail.profile;
  const counts = u.counts || {};
  const presClass = presenceClass(u.presence);
  const created = u.created ? new Date(u.created).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown';
  const source = u.connectedAccounts && u.connectedAccounts.length ? `Friend of ${u.connectedAccounts.map(a => a.displayName).join(', ')}` : 'Public Roblox profile';
  const groups = u.groups || [], badges = u.robloxBadges || [], assets = u.avatarDetails && u.avatarDetails.assets || [];
  const collectibles = u.inventory && u.inventory.collectibles || [];
  mount(`
    <button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button>
    <div class="profile-hero">
      <div class="profile-identity">
        ${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : `<span class="profile-avatar-ph">${icon('users-group')}</span>`}
        <div><h1>${esc(u.displayName)} ${u.hasVerifiedBadge ? `<span class="verified">${icon('check-circle')}</span>` : ''}</h1><p>@${esc(u.username)}</p>
          <span class="presence ${presClass}" data-person-presence="${esc(u.userId)}"><span class="pd"></span>${esc(u.presence)}</span></div>
      </div>
      <div class="inline" data-profile-actions="${esc(u.userId)}">${profileHeroActions(u)}</div>
    </div>
    <div class="profile-stats">${peopleStat('Friends', counts.friends)}${peopleStat('Followers', counts.followers)}${peopleStat('Following', counts.following)}</div>
    <div class="profile-layout">
      <div class="profile-main">
        <section class="profile-section"><h2>About</h2><p class="profile-bio">${esc(u.bio || 'No description provided.')}</p>
          <div class="profile-facts"><span><strong>Joined</strong>${esc(created)}${accountAge(u.created) ? ` - ${esc(accountAge(u.created))} old` : ''}</span><span><strong>User ID</strong>${esc(u.userId)}</span><span><strong>Connection</strong>${esc(source)}</span><span><strong>Account</strong>${u.isBanned ? 'Banned' : 'Active'}</span></div>
          <div data-profile-live="${esc(u.userId)}">${profileLivePanel(u)}</div>
        </section>
        ${profileGameSection('Created experiences', u.createdGames || [])}
        ${profileGameSection('Favorite experiences', u.favoriteGames || [])}
        ${profileListSection('Groups', groups, 'No public groups.', group => `<div class="profile-row"><span>${icon('users-group')}</span><div><strong>${esc(group.name)}</strong><small>${esc(group.role || 'Member')}${group.memberCount ? ` - ${fmtNum(group.memberCount)} members` : ''}</small></div></div>`)}
        ${profileListSection('Roblox badges', badges, 'No Roblox badges.', badge => `<div class="profile-row"><span>${icon('check-circle')}</span><div><strong>${esc(badge.name)}</strong><small>${esc(badge.description || 'Roblox badge')}</small></div></div>`)}
      </div>
      <aside class="profile-side">
        <section class="profile-section avatar-preview"><h2>Avatar</h2>${u.fullBodyAvatar ? `<img src="${esc(u.fullBodyAvatar)}" alt="Full avatar">` : '<p class="profile-empty">Avatar unavailable.</p>'}
          ${u.avatarDetails ? `<p>${esc(u.avatarDetails.avatarType || 'Avatar')} ? ${assets.length} equipped asset${assets.length === 1 ? '' : 's'}</p>` : ''}</section>
        ${profileListSection('Currently wearing', assets, 'Outfit details unavailable.', asset => `<div class="asset-row"><strong>${esc(asset.name)}</strong><small>${esc(asset.assetType || 'Asset')} - #${esc(asset.id)}</small></div>`)}
        ${profileListSection('Previous usernames', u.previousUsernames || [], 'No previous usernames.', name => `<div class="asset-row"><strong>@${esc(name)}</strong></div>`)}
        ${profileListSection('Public collectibles', collectibles, u.inventory && u.inventory.canView ? 'No collectibles returned.' : 'Inventory is private.', item => `<div class="asset-row"><strong>${esc(item.name)}</strong><small>${esc(item.assetType || 'Collectible')}${item.recentAveragePrice ? ` - ${fmtNum(item.recentAveragePrice)} recent value` : ''}</small></div>`)}
      </aside>
    </div>`);
}

async function openPerson(userId) {
  const id = Number(userId);
  if (!id) return;
  state.people.returnRoute = state.people.route === 'friends'
    ? 'friends'
    : (state.people.route === 'server' || state.people.tab === 'server' ? 'server' : 'home');
  state.people.route = 'profile';
  state.people.detail = { userId: id, profile: null, loading: true, error: null };
  views.people();
  const r = await call(() => api.people.profile(id));
  if (state.people.detail.userId !== id) return;
  state.people.detail.loading = false;
  if (r && r.ok) state.people.detail.profile = r.profile;
  else state.people.detail.error = (r && r.error) || 'Could not load this profile.';
  if (state.view === 'people' && state.people.route === 'profile') views.people();
}

/* ----------------------------- History view ----------------------------- */
/* ----------------------------- Stats view ----------------------------- */
function fmtDur(ms) {
  if (!ms || ms < 1000) return '0m';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  const d = Math.floor(h / 24);
  if (!d) return `${h}h ${m % 60}m`;
  return `${d}d ${h % 24}h`;
}

views.stats = async function () {
  mount(`
    <div class="page-head"><h1>Stats</h1><p>Playtime tracked from your accounts' live presence - per game and per account, kept on this PC only.</p></div>
    <div id="stats-body"><div class="games-end"><span class="spinner dark"></span> Crunching playtime-</div></div>
  `);
  const r = await call(() => api.playtime.stats(), { ok: false });
  const root = $('#stats-body');
  if (!root || state.view !== 'stats') return;
  if (!r || !r.ok) { root.innerHTML = `<div class="games-end">Could not load stats.</div>`; return; }
  const t = r.totals || {};
  const statCard = (label, value, sub) => `<div class="card pad stat-card"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;
  const row = (cells, live) => `<div class="setting stat-row"><div><div class="s-label">${live ? '<span class="pd live-dot"></span>' : ''}${esc(cells.name)}</div><div class="s-desc">${esc(cells.desc)}</div></div>
    <div class="s-control stat-cells"><span data-tip="Today">${fmtDur(cells.today)}</span><span data-tip="Last 7 days">${fmtDur(cells.week)}</span><b data-tip="All time">${fmtDur(cells.total)}</b></div></div>`;
  const games = (r.perGame || []).slice(0, 15).map(g => row({ name: g.label, desc: `${g.sessions} session${g.sessions === 1 ? '' : 's'}`, today: g.todayMs, week: g.weekMs, total: g.totalMs }, g.live)).join('');
  const accountsRows = (r.perAccount || []).map(a => row({ name: a.label, desc: `${a.sessions} session${a.sessions === 1 ? '' : 's'}`, today: a.todayMs, week: a.weekMs, total: a.totalMs }, a.live)).join('');
  const recent = (r.recent || []).map(s => `<div class="setting stat-row"><div><div class="s-label">${s.live ? '<span class="pd live-dot"></span>' : ''}${esc(s.game)}</div>
    <div class="s-desc">${esc(s.username)} - ${new Date(s.start).toLocaleString()}</div></div><div class="s-control"><b>${fmtDur(s.ms)}</b></div></div>`).join('');
  root.innerHTML = `
    <div class="stat-grid">
      ${statCard('Today', fmtDur(t.todayMs))}
      ${statCard('Last 7 days', fmtDur(t.weekMs))}
      ${statCard('All time', fmtDur(t.totalMs), `${t.sessions || 0} sessions`)}
      ${statCard('Tracking now', String(r.tracking || 0), r.tracking ? 'accounts in game' : 'no one in game')}
    </div>
    ${games ? `<div class="section-title">By game <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${games}</div>` : ''}
    ${accountsRows ? `<div class="section-title">By account <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${accountsRows}</div>` : ''}
    ${recent ? `<div class="section-title">Recent sessions</div><div class="card pad">${recent}</div>` : ''}
    ${!games && !recent ? `<div class="games-end">No playtime yet. Stats build up automatically while your accounts play - launch a game and check back.</div>` : ''}
    <div class="inline" style="margin-top:16px"><div class="spacer" style="flex:1"></div>
      <button class="btn sm" data-action="stats-refresh">${icon('refresh')} Refresh</button>
      <button class="btn sm danger" data-action="stats-clear">${icon('trash')} Clear playtime data</button></div>`;
};

views.history = async function () {
  const r = await call(() => api.history.get(), { history: [] });
  state.history = (r && r.history) || [];
  const rows = state.history.length ? state.history.map(h => `
    <tr>
      <td>${esc(fmtTime(h.time))}</td>
      <td>${esc(h.profileName)}</td>
      <td><span class="pill ${esc(h.result)}">${esc(h.result)}</span></td>
      <td class="mono">${h.pid || '-'}</td>
      <td>${esc(h.message || '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="5"><div class="empty" style="padding:40px"><div class="e-ico">${icon('clock')}</div><h3>No launches yet</h3><p>Your launch history will appear here.</p></div></td></tr>`;

  mount(`
    <div class="page-head"><h1>History</h1><p>A record of every launch, restart and the result.</p></div>
    <div class="row-split" style="margin-bottom:14px">
      <div class="section-title" style="margin:0">Recent activity</div>
      <button class="btn sm danger" data-action="clear-history" ${state.history.length ? '' : 'disabled'}>${icon('trash')} Clear history</button>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data"><thead><tr><th>Time</th><th>Account / mode</th><th>Result</th><th>PID</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  `);
};

/* ----------------------------- Diagnostics view ----------------------------- */
views.diagnostics = async function () {
  const d = await call(() => api.diag(), { diagnostics: {} });
  state.diag = (d && d.diagnostics) || {};
  const g = state.diag;
  const kv = (k, v) => `<div class="k">${esc(k)}</div><div class="v">${esc(v == null ? '-' : v)}</div>`;
  mount(`
    <div class="page-head"><h1>Diagnostics</h1><p>Environment details and a live log to help troubleshoot. Share these if you report a problem.</p></div>
    <div class="section-title">Environment</div>
    <div class="card pad">
      <div class="kv">
        ${kv('Fleet version', g.appVersion)}
        ${kv('Host runtime', 'Tauri')}
        ${kv('Node / V8', (g.node || '?') + ' / ' + (g.v8 || '?'))}
        ${kv('OS', (g.osType || '') + ' ' + (g.osRelease || '') + ' (' + (g.arch || '') + ')')}
        ${kv('CPU', g.cpu)}
        ${kv('Memory', (g.totalMemGB || '?') + ' GB')}
        ${kv('Native helper', g.ffiAvailable ? 'available' : 'unavailable')}
        ${kv('Multi-instance', g.multiInstance)}
        ${kv('Guard', g.guard)}
        ${kv('Singleton objects', g.singletonNames)}
        ${kv('Roblox', g.robloxFound ? (g.robloxVersion + ' via ' + g.robloxSource) : 'not found')}
        ${kv('Roblox path', g.robloxPath)}
        ${kv('Data folder', g.userData)}
        ${kv('Log file', g.logFile)}
      </div>
      <div class="inline" style="margin-top:16px">
        <button class="btn sm" data-action="copy-diag">${icon('copy')} Copy diagnostics</button>
        <button class="btn sm" data-action="open-userdata">${icon('folder')} Open data folder</button>
      </div>
    </div>
    <div class="row-split" style="margin:26px 2px 12px">
      <div class="section-title" style="margin:0">Live log</div>
      <div class="inline">
        <div class="segmented" id="log-filter">
          ${['all', 'info', 'warn', 'error'].map(f => `<button data-action="log-filter" data-f="${f}" class="${state.logFilter === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
        </div>
        <button class="btn sm" data-action="logs-folder">${icon('folder')} Folder</button>
        <button class="btn sm danger" data-action="logs-clear">${icon('trash')} Clear</button>
      </div>
    </div>
    <div class="logview" id="logview"></div>
  `);
  const lr = await call(() => api.logs.get(400), { entries: [] });
  state.logs = (lr && lr.entries) || [];
  renderLogs();
};
function renderLogs() {
  const view = $('#logview');
  if (!view) return;
  const f = state.logFilter;
  const items = state.logs.filter(e => f === 'all' || e.level === f);
  view.innerHTML = items.map(e => `
    <div class="logline ${esc(e.level)}">
      <span class="t">${esc((e.time || '').slice(11))}</span>
      <span class="lv">${esc(e.level.toUpperCase())}</span>
      <span class="m">${esc(e.message)}${e.detail ? ' <small>' + esc(e.detail) + '</small>' : ''}</span>
    </div>`).join('') || `<div class="logline"><span></span><span></span><span class="m" style="color:var(--ink-3)">No log entries.</span></div>`;
  view.scrollTop = view.scrollHeight;
}

/* ----------------------------- Settings view ----------------------------- */
views.settings = async function () {
  if (!state.settings) {
    const r = await call(() => api.settings.get(), { settings: null });
    state.settings = (r && r.settings) || {};
  }
  const s = state.settings;
  const st = state.status || {};
  if (!state.updater) state.updater = await call(() => api.updater.status(), { state: 'disabled' });
  const up = state.updater || { state: 'disabled' };
  const updateText = up.state === 'ready' ? `Version ${up.availableVersion} is ready to install`
    : up.state === 'downloading' ? `Downloading ${Math.round(up.percent || 0)}%`
      : up.state === 'available' ? `Downloading version ${up.availableVersion}`
        : up.state === 'checking' ? 'Checking for updates-'
          : up.state === 'error' ? `Update check failed: ${up.error || 'unknown error'}`
            : up.state === 'disabled' ? 'Automatic updates activate in the installed version'
              : `Fleet ${st.appVersion || ''} is up to date`;
  const auto = s.autoDetect !== false;
  mount(`
    <div class="page-head"><h1>Settings</h1><p>Everything is saved to your user profile and persists between sessions.</p></div>
    <div class="section-title">Appearance</div>
    <div class="card pad">
      ${settingRow('Theme', 'Follow Windows, or choose graphite or obsidian.',
        `<div class="segmented compact" id="set-theme">
          <button type="button" data-action="set-theme" data-theme="system" class="${themePref() === 'system' ? 'on' : ''}">System</button>
          <button type="button" data-action="set-theme" data-theme="light" class="${themePref() === 'light' ? 'on' : ''}">Graphite</button>
          <button type="button" data-action="set-theme" data-theme="dark" class="${themePref() === 'dark' ? 'on' : ''}">Obsidian</button>
        </div>`)}
    </div>
    <div class="section-title">Roblox location</div>
    <div class="card pad">
      <div class="field">
        <label>Detection</label>
        <div class="segmented" id="set-detect" data-auto="${auto}">
          <button type="button" data-action="set-detect" data-auto="true" class="${auto ? 'on' : ''}">Auto-detect</button>
          <button type="button" data-action="set-detect" data-auto="false" class="${auto ? '' : 'on'}">Manual path</button>
        </div>
        <div class="hint">Auto-detect finds Roblox from the registry and your install folder.</div>
      </div>
      <div class="field" id="set-path-row" style="${auto ? 'display:none' : ''}">
        <label for="set-path">RobloxPlayerBeta.exe path</label>
        <div class="inline">
          <input id="set-path" type="text" value="${esc(s.robloxPath || '')}" placeholder="C:\\Users\\...\\RobloxPlayerBeta.exe" />
          <button class="btn" data-action="settings-browse">${icon('folder')} Browse</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>Currently detected</label>
        <div class="inline">
          <input type="text" readonly value="${esc(st.playerPath || 'Not found')}" />
          <button class="btn" data-action="redetect" data-tip="Run detection again">${icon('refresh')} Re-detect</button>
        </div>
      </div>
    </div>
    <div class="section-title">Behaviour</div>
    <div class="card pad">
      ${settingRow('Confirm before bulk actions', 'Ask for confirmation before -End all- and -Cleanup-.',
        `<label class="toggle"><input type="checkbox" id="set-confirm" ${s.confirmCleanup ? 'checked' : ''}><span class="track"></span></label>`)}
      ${settingRow('Refresh interval', 'How often the running-clients list updates (750-10000 ms).',
        `<input id="set-poll" type="number" min="750" max="10000" step="250" value="${s.pollIntervalMs}" style="width:120px">`)}
      ${settingRow('Delay between launches', 'Pause between each client in a multi-launch so each boots first (0-20000 ms).',
        `<input id="set-delay" type="number" min="0" max="20000" step="500" value="${s.launchDelayMs}" style="width:120px">`)}
      ${settingRow('Warn above this many instances', 'Show a heads-up when launching would exceed this count.',
        `<input id="set-warn" type="number" min="1" max="100" value="${s.warnInstanceCount}" style="width:120px">`)}
      ${settingRow('History entries to keep', 'Maximum launch-history rows stored (10-2000).',
        `<input id="set-historylimit" type="number" min="10" max="2000" step="10" value="${s.historyLimit}" style="width:120px">`)}
    </div>
    <div class="section-title">Updates</div>
    <div class="card pad">
      ${settingRow('Automatic updates', updateText,
        up.state === 'ready'
          ? `<button class="btn primary" data-action="update-install">${icon('refresh')} Restart and update</button>`
          : `<button class="btn" data-action="update-check" ${up.state === 'checking' || up.state === 'downloading' ? 'disabled' : ''}>${icon('refresh')} Check now</button>`)}
    </div>
    <div class="inline" style="margin-top:20px">
      <button class="btn primary" data-action="settings-save">${icon('check')} Save settings</button>
      <button class="btn" data-action="settings-reset">Reset to defaults</button>
      <div class="spacer" style="flex:1"></div>
      <button class="btn ghost" data-action="open-userdata">${icon('folder')} Open data folder</button>
    </div>
  `);
};
function settingRow(label, desc, control) {
  return `<div class="setting"><div><div class="s-label">${esc(label)}</div><div class="s-desc">${esc(desc)}</div></div>
    <div class="s-control">${control}</div></div>`;
}
function currentSettingsDraft() {
  const auto = $('#set-detect').dataset.auto === 'true';
  return {
    autoDetect: auto,
    robloxPath: $('#set-path') ? $('#set-path').value.trim() : (state.settings.robloxPath || ''),
    confirmCleanup: $('#set-confirm').checked,
    pollIntervalMs: parseInt($('#set-poll').value, 10),
    launchDelayMs: parseInt($('#set-delay').value, 10),
    warnInstanceCount: parseInt($('#set-warn').value, 10),
    historyLimit: parseInt($('#set-historylimit').value, 10),
  };
}

async function saveSettings() {
  const partial = currentSettingsDraft();
  const r = await call(() => api.settings.save(partial));
  if (r && r.ok) { state.settings = r.settings; toast('Settings saved', 'good'); await refreshStatus(); views.settings(); }
  else toast((r && r.error) || 'Could not save settings', 'bad');
}

/* ----------------------------- Help view ----------------------------- */
views.help = function () {
  mount(`
    <div class="help">
      <div class="page-head"><h1>Help</h1><p>Everything you need to use Fleet - no external guide required.</p></div>

      <h2>What Fleet does</h2>
      <p>Fleet runs several Roblox clients on one PC at the same time and manages them from one place. Normally Roblox allows only a single client; Fleet works around that automatically - no settings to change.</p>

      <h2>Quick start</h2>
      <div class="step"><div class="n">1</div><div>On <b>Accounts</b>, click <b>Add account</b>. Fleet opens a Tauri Roblox sign-in window and saves the account after Roblox sets the session.</div></div>
      <div class="step"><div class="n">2</div><div>On <b>Instances</b>, choose <b>With account</b> or <b>Signed out</b>. Optionally paste a Place ID, game URL, or exact-server link, then click <b>Launch</b>.</div></div>
      <div class="step"><div class="n">3</div><div>Every client appears under <b>Running clients</b>, where you can focus, restart or end it.</div></div>

      <h2>Accounts</h2>
      <p>Accounts appear with avatar, name and presence. Fleet stores sessions locally and uses them for launch, follow, People search and join flows.</p>

      <h2>Sessions and appearance</h2>
      <p>On <b>Instances</b>, <b>Save current setup</b> stores the selected accounts, game/server target, and optional window arrangement for one-click reuse. In <b>Settings ? Appearance</b>, choose System, Light, or Dark.</p>

      <h2>How multi-instance works</h2>
      <p>Roblox guards single-instance with named Windows objects, including a mutex tied to the client's exact program path. Fleet launches each client through its own folder -junction- (a unique path, no files copied) and a small guard clears the shared lock as it reappears - so every launch opens a new client that stays running.</p>

      <h2>Tools</h2>
      <ul>
        <li><b>Focus</b> brings a client's window to the front. <b>Restart</b> relaunches it. <b>End</b> closes it.</li>
        <li><b>End all</b> closes every client; <b>Cleanup</b> also clears leftover Roblox crash-handler processes.</li>
        <li>Right-click any client for the same actions plus <b>Copy PID</b>.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <div class="faq">
        <details><summary>-Roblox not found-</summary><div class="a">Install Roblox, or open <b>Settings ? Roblox location</b>, switch to <b>Manual path</b> and point Fleet at <code>RobloxPlayerBeta.exe</code>.</div></details>
        <details><summary>A client closes after sign-in</summary><div class="a">The launch ticket may have expired - try again. Give each launch a few seconds (raise <b>Settings ? Delay between launches</b> on a slow PC).</div></details>
        <details><summary>An account shows -Session expired-</summary><div class="a">Roblox sessions don't last forever. Click <b>Sign in again</b> on that account to refresh it through the Tauri sign-in window.</div></details>
        <details><summary>Is my login safe?</summary><div class="a">Existing saved sessions remain local to this PC and are never shown in the UI.</div></details>
      </div>

      <h2>Use responsibly</h2>
      <p>Run only as many clients as your PC can handle, and follow Roblox's Terms of Use for the experiences you play.</p>
      <p style="margin-top:14px"><button class="btn sm" data-action="ext-link" data-url="https://www.roblox.com/download">${icon('box')} Get Roblox</button></p>
    </div>
  `);
};

/* ----------------------------- Action dispatch ----------------------------- */
document.addEventListener('click', async (e) => {
  const elAction = e.target.closest('[data-action]');
  if (!elAction) return;
  const action = elAction.dataset.action;
  const pid = elAction.dataset.pid ? parseInt(elAction.dataset.pid, 10) : null;
  const id = elAction.dataset.id;

  switch (action) {
    case 'step': {
      const inp = document.getElementById(elAction.dataset.target);
      if (inp) {
        const min = parseInt(inp.min, 10) || 1, max = parseInt(inp.max, 10) || 99;
        inp.value = Math.max(min, Math.min(max, (parseInt(inp.value, 10) || min) + parseInt(elAction.dataset.dir, 10)));
      }
      break;
    }
    case 'goto-settings': setView('settings'); break;
    case 'goto-accounts': setView('accounts'); break;

    case 'launch-mode': {
      state.launchMode = elAction.dataset.mode;
      $('#launch-mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.launchMode));
      $('#lp-account').style.display = state.launchMode === 'account' ? '' : 'none';
      $('#lp-plain').style.display = state.launchMode === 'plain' ? '' : 'none';
      break;
    }
    case 'toggle-account': {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      // update chip + card states without full re-render
      findAllByData(document, 'id', id).filter(el => el.classList.contains('chip')).forEach(c => c.classList.toggle('on', state.selected.has(id)));
      findAllByData(document, 'id', id).filter(el => el.classList.contains('acct')).forEach(c => c.classList.toggle('selected', state.selected.has(id)));
      updateLaunchCount();
      if (state.view === 'accounts') updateAccountsLaunchButton();
      break;
    }
    case 'launch-quick': {
      const inp = $('#launch-count');
      const n = Math.max(1, Math.min(10, parseInt(inp && inp.value, 10) || 1));
      if (state.settings && n > state.settings.warnInstanceCount) {
        const ok = await confirmDialog({ title: 'Launch ' + n + ' clients?', body: 'That is more than your warning threshold of ' + state.settings.warnInstanceCount + '. Continue?', confirmText: 'Launch' });
        if (!ok) break;
      }
      elAction.disabled = true;
      const r = await call(() => api.launch.quick(n));
      elAction.disabled = false;
      if (r && r.ok) toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), 'good');
      else toast((r && r.error) || 'Launch failed', 'bad');
      break;
    }
    case 'launch-accounts': case 'launch-selected': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select at least one account', 'bad'); break; }
      const placeEl = $('#lp-place');
      const raw = placeEl ? placeEl.value.trim() : state.placeId;
      const target = parseRobloxTarget(raw);
      if (target.invalid) { toast('Could not read a place ID from that - paste a Roblox game link or a numeric ID', 'bad'); break; }
      state.placeId = raw;
      elAction.disabled = true;
      const r = target.gameId && target.placeId
        ? await call(() => api.launch.join(ids, target.placeId, target.gameId))
        : await call(() => api.launch.accounts(ids, target.placeId));
      elAction.disabled = false;
      if (r && r.ok) {
        toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (target.gameId ? ' into the exact server' : '') + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        const ka = $('#lp-keepalive');
        if (ka && ka.checked && target.placeId) { armKeepAlive(ids, target.placeId, target.gameId, 'the game'); toast('Keep-alive armed - crashed clients rejoin automatically', 'good'); }
      } else toast((r && r.error) || 'Launch failed', 'bad');
      break;
    }
    case 'launch-account': {
      const r = await call(() => api.launch.accounts([id], ''));
      if (r && r.ok) toast('Launched ' + (r.launched) + ' client', 'good');
      else toast((r && (r.error || (r.results && r.results[0] && r.results[0].reason))) || 'Launch failed', 'bad');
      break;
    }
    case 'follow-account': {
      openFollowDialog(id);
      break;
    }
    case 'toggle-follow-account': {
      if (state.following || id === state.followTargetId) break;
      if (state.followSelected.has(id)) state.followSelected.delete(id); else state.followSelected.add(id);
      renderFollowDialog();
      break;
    }
    case 'follow-confirm': {
      if (state.following || !state.followTargetId || !state.followSelected.size) break;
      const targetId = state.followTargetId;
      const followerIds = Array.from(state.followSelected).filter(accountId => accountId !== targetId);
      if (!followerIds.length) { toast('Choose at least one other account', 'bad'); break; }
      state.following = true;
      renderFollowDialog();
      const r = await call(() => api.accounts.follow(targetId, followerIds));
      state.following = false;
      if (r && r.ok) {
        const targetName = r.targetDisplayName || r.targetUsername || 'account';
        closeFollowDialog();
        toast(`Joined ${targetName} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        const firstFailure = r && r.results && r.results.find(result => !result.ok);
        renderFollowDialog();
        toast((r && r.error) || (firstFailure && firstFailure.reason) || 'Could not follow that account', 'bad');
      }
      break;
    }

    case 'add-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening account flow-');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) { await loadAccounts(); toast((r.updated ? 'Account updated: ' : 'Account added: ') + (r.account ? r.account.username : ''), 'good'); }
      else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not add account', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'reauth-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening account flow-');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) {
        await loadAccounts();
        toast('Signed in again: ' + (r.account ? r.account.username : ''), 'good');
      } else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not sign in again', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'remove-account': {
      const acc = state.accounts.find(a => a.id === id);
      const ok = await confirmDialog({ title: 'Remove account?', body: 'Remove -' + (acc ? acc.username : '') + '- from Fleet? This deletes its stored session on this PC.', confirmText: 'Remove', danger: true });
      if (!ok) break;
      const r = await call(() => api.accounts.remove(id));
      state.selected.delete(id);
      if (r && r.ok) { state.accounts = r.accounts; updateAccountsCount(); views.accounts(); toast('Account removed', 'good'); }
      break;
    }
    case 'refresh-account': {
      const r = await call(() => api.accounts.refresh(id));
      if (r && r.ok) { state.accounts = r.accounts; patchAccountGrid(state.accounts); updateAccountsCount(); toast('Refreshed', 'good'); }
      break;
    }
    case 'refresh-accounts': {
      toast('Refreshing accounts-');
      const r = await call(() => api.accounts.refresh(undefined, true));
      if (r && r.ok) { state.accounts = r.accounts; state.accountsRefreshedAt = Date.now(); patchAccountGrid(state.accounts); updateAccountsCount(); toast('Accounts refreshed', 'good'); }
      break;
    }

    case 'refresh-games': gamesBrowse(); break;
    case 'random-game': {
      const list = visibleGames();
      if (!list.length) { toast('No games loaded yet', 'bad'); break; }
      const gm = list[Math.floor(Math.random() * list.length)];
      joinPlace(gm.placeId, gm.name);
      break;
    }
    case 'games-sort':
      state.games.sort = elAction.dataset.sort || 'players';
      views.games();
      break;
    case 'games-category':
      state.games.category = elAction.dataset.cat || 'All';
      renderGamesCategories();
      renderGamesGrid();
      break;
    case 'toggle-fav': {
      const gm = gameByPlaceId(elAction.dataset.place);
      if (!gm) break;
      const added = toggleFav(gm);
      toast(added ? 'Saved to favorites' : 'Removed from favorites', 'good');
      renderGamesCategories();
      renderGamesGrid();
      break;
    }
    case 'clip-use': {
      const text = elAction.dataset.text || '';
      state.placeId = text;
      const inp = $('#lp-place');
      if (inp) { inp.value = text; inp.focus(); }
      const box = $('#clip-offer');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      toast('Link loaded - pick accounts and launch', 'good');
      break;
    }
    case 'clip-dismiss': {
      const box = $('#clip-offer');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      break;
    }
    case 'keepalive-off':
      disarmKeepAlive();
      toast('Keep-alive stopped', 'good');
      break;
    case 'stats-refresh': views.stats(); break;
    case 'stats-clear': {
      const ok = await confirmDialog({ title: 'Clear playtime data?', body: 'All recorded sessions are deleted from this PC. This cannot be undone.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.playtime.clear());
      toast('Playtime data cleared', 'good');
      views.stats();
      break;
    }
    case 'set-theme':
      setThemePref(elAction.dataset.theme || 'system');
      if (state.view === 'settings') views.settings();
      break;
    case 'session-save': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select the accounts to include first', 'bad'); break; }
      const placeEl = $('#lp-place');
      const target = parseRobloxTarget(placeEl ? placeEl.value.trim() : state.placeId);
      if (target.invalid) { toast('Could not read a place ID from that - paste a Roblox game link or a numeric ID', 'bad'); break; }
      state.sessionDraft = {
        accountIds: ids.filter(id => state.accounts.some(account => account.id === id)),
        placeId: target.placeId,
        gameId: target.gameId,
      };
      openModal(`
        <div class="m-head"><h3>Save session</h3><p>${ids.length} account${ids.length === 1 ? '' : 's'} - ${target.placeId ? 'place ' + esc(target.placeId) : 'Roblox home'}</p></div>
        <div class="m-body">
          <div class="field"><label for="session-name">Name</label>
          <input id="session-name" type="text" maxlength="40" placeholder="e.g. Farming crew" value="Session ${loadSessions().length + 1}"></div>
          <label class="toggle-row inline" style="gap:10px;margin-top:4px;cursor:pointer">
            <input type="checkbox" id="session-arrange"> <span>Auto-arrange windows ~20s after launch</span>
          </label>
          <label class="toggle-row inline" style="gap:10px;margin-top:8px;cursor:pointer">
            <input type="checkbox" id="session-keepalive"> <span>Keep alive - auto-rejoin accounts that crash or disconnect</span>
          </label>
        </div>
        <div class="m-foot"><button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="session-save-confirm">${icon('check')} Save session</button></div>`);
      const inp = $('#session-name');
      if (inp) { inp.focus(); inp.select(); }
      break;
    }
    case 'session-save-confirm': {
      const draft = state.sessionDraft;
      if (!draft || !draft.accountIds.length) { closeModal(); toast('That session setup is no longer available', 'bad'); break; }
      const nameEl = $('#session-name');
      const sessions = loadSessions();
      sessions.push({
        id: 's' + Date.now(),
        name: (nameEl && nameEl.value.trim()) || `Session ${sessions.length + 1}`,
        accountIds: draft.accountIds,
        placeId: draft.placeId,
        gameId: draft.gameId,
        arrange: !!($('#session-arrange') && $('#session-arrange').checked),
        keepAlive: !!($('#session-keepalive') && $('#session-keepalive').checked),
      });
      const saved = saveSessions(sessions);
      state.sessionDraft = null;
      closeModal();
      toast(saved ? 'Session saved' : 'Could not save the session on this PC', saved ? 'good' : 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'session-launch': {
      const session = loadSessions().find(x => x.id === elAction.dataset.id);
      if (!session) break;
      const ids = session.accountIds.filter(i => state.accounts.some(a => a.id === i));
      if (!ids.length) { toast('None of this session\'s accounts exist anymore', 'bad'); break; }
      elAction.disabled = true;
      const r = session.gameId && session.placeId
        ? await call(() => api.launch.join(ids, session.placeId, session.gameId))
        : await call(() => api.launch.accounts(ids, session.placeId || ''));
      elAction.disabled = false;
      if (r && r.ok) {
        toast(`Session "${session.name}": launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        if (session.arrange) {
          toast('Windows will be arranged in ~20s', 'good');
          setTimeout(() => { call(() => api.instances.arrange()); }, 20000);
        }
        if (session.keepAlive && session.placeId) armKeepAlive(ids, session.placeId, session.gameId, session.name);
      } else toast((r && r.error) || 'Session launch failed', 'bad');
      break;
    }
    case 'session-delete': {
      if (!saveSessions(loadSessions().filter(x => x.id !== elAction.dataset.id))) toast('Could not delete the session', 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'games-hide-empty':
      state.games.hideEmpty = !state.games.hideEmpty;
      views.games();
      break;
    case 'join-game': joinPlace(elAction.dataset.place, elAction.dataset.name); break;
    case 'open-game-web':
      await call(() => api.openExternal(`https://www.roblox.com/games/${encodeURIComponent(elAction.dataset.place || '')}`));
      break;
    case 'copy-place-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.place || ''));
        toast('Place ID copied', 'good');
      } catch (_) { toast('Could not copy place ID', 'bad'); }
      break;
    case 'open-servers': openServersModal(elAction.dataset.place, elAction.dataset.name); break;
    case 'join-server': joinServer(elAction.dataset.place, elAction.dataset.server, elAction.dataset.name); break;
    case 'server-sort':
      if (state.servers) {
        state.servers.sort = elAction.dataset.sort || 'best';
        renderServersModal();
        if (state.servers.sort === 'players' && !state.servers.deepScanned) await deepScanServers(true);
      }
      break;
    case 'servers-scan': await deepScanServers(false); break;
    case 'servers-filter-reset':
      if (state.servers) {
        state.servers.filters = { occupancy: 0, maxPing: 0, minFps: 0, freeSlots: 1 };
        renderServersModal();
      }
      break;
    case 'servers-auto-refresh':
      if (state.servers) setServerAutoRefresh(!state.servers.autoRefresh);
      break;
    case 'copy-server-id':
      try { await navigator.clipboard.writeText(String(elAction.dataset.server || '')); toast('Server ID copied', 'good'); }
      catch (_) { toast('Could not copy server ID', 'bad'); }
      break;
    case 'servers-more': loadServers(true); break;
    case 'servers-refresh': loadServers(false); break;
    case 'join-best': {
      const sv = state.servers;
      if (sv && sv.list.length) { const top = sortedServers(filteredServers(sv), sv.sort)[0]; if (top) joinServer(sv.placeId, top.id, sv.name); }
      break;
    }

    case 'open-friends':
      state.people.tab = 'people';
      state.people.route = 'friends';
      views.people();
      break;
    case 'people-home':
      state.people.tab = 'people';
      state.people.route = 'home';
      views.people();
      break;
    case 'people-tab':
      state.people.tab = elAction.dataset.tab === 'server' ? 'server' : 'people';
      state.people.route = state.people.tab === 'server' ? 'server' : 'home';
      views.people();
      break;
    case 'people-back': state.people.route = state.people.returnRoute || 'home'; views.people(); break;
    case 'people-search': runPeopleSearch(($('#people-search') || {}).value || ''); break;
    case 'people-search-retry': runPeopleSearch(state.people.search.query); break;
    case 'people-search-clear': clearPeopleSearch(); break;
    case 'people-search-more': runPeopleSearch(state.people.search.query, true); break;
    case 'server-search': runServerSearch(($('#server-search') || {}).value || ''); break;
    case 'server-search-clear': clearServerSearch(); break;
    case 'server-refresh': await loadServerPeople(true); break;
    case 'people-filter':
      state.people.filter = elAction.dataset.filter || 'all';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      else if (state.people.route === 'server') renderServerSearchResults();
      break;
    case 'people-sort':
      state.people.sort = elAction.dataset.sort || 'status';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      else if (state.people.route === 'server') renderServerSearchResults();
      break;
    case 'copy-user-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.user || ''));
        toast('User ID copied', 'good');
      } catch (_) { toast('Could not copy user ID', 'bad'); }
      break;
    case 'open-person': openPerson(elAction.dataset.user); break;
    case 'people-prev': if (state.people.hasPrev) loadPeople(state.people.page - 1); break;
    case 'people-next': if (state.people.hasNext) loadPeople(state.people.page + 1); break;
    case 'people-refresh': refreshPeople(); break;
    case 'join-person': openPersonJoinDialog(elAction.dataset.user, elAction.dataset.place, elAction.dataset.game, elAction.dataset.name); break;
    case 'select-join-account': {
      if (!state.personJoin || state.personJoin.joining) break;
      const set = state.personJoin.selectedIds;
      if (set.has(id)) set.delete(id); else set.add(id);
      renderPersonJoinDialog();
      break;
    }
    case 'person-join-confirm': {
      const join = state.personJoin;
      if (!join || join.joining || !join.selectedIds.size) break;
      const ids = Array.from(join.selectedIds).filter(x => state.accounts.some(a => a.id === x));
      if (!ids.length) { toast('Those accounts are no longer available', 'bad'); closePersonJoinDialog(); break; }
      join.joining = true;
      renderPersonJoinDialog();
      const r = await call(() => api.launch.joinPersonMulti(ids, join.userId));
      if (r && r.ok) {
        closePersonJoinDialog();
        toast(`Joining ${join.name} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        join.joining = false;
        renderPersonJoinDialog();
        const firstFailure = r && r.results && r.results.find(result => !result.ok);
        toast((r && r.error) || (firstFailure && firstFailure.reason) || 'Join failed', 'bad');
      }
      break;
    }

    case 'refresh-instances': { await loadInstances(); toast('Refreshed', 'good'); break; }
    case 'arrange': {
      if (!state.instances.length) { toast('No Roblox windows to arrange', 'bad'); break; }
      const r = await call(() => api.instances.arrange());
      toast(r && r.ok ? `Arranged ${r.tiled} window${r.tiled === 1 ? '' : 's'} in a ${r.cols}-${r.rows} grid` : (r && r.reason) || 'Could not arrange windows', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'end-all': {
      if (!state.instances.length) { toast('No clients running', 'bad'); break; }
      const ok = !needConfirm() || await confirmDialog({ title: 'End all Roblox clients?', body: 'This closes every running Roblox client.', confirmText: 'End all', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.killAll());
      toast(r && r.ok ? 'All clients ended' : 'Could not end clients', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'cleanup': {
      const ok = !needConfirm() || await confirmDialog({ title: 'Run cleanup?', body: 'Ends all Roblox clients and clears leftover crash-handler processes.', confirmText: 'Clean up', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.cleanup());
      toast(r && r.ok ? 'Cleanup complete' : 'Cleanup failed', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'focus': { const r = await call(() => api.instances.focus(pid)); if (!(r && r.ok)) toast((r && r.reason) || 'Could not focus window', 'bad'); break; }
    case 'restart': { const r = await call(() => api.instances.restart(pid)); toast(r && r.ok ? 'Client restarted' : 'Restart failed', r && r.ok ? 'good' : 'bad'); break; }
    case 'end': { const r = await call(() => api.instances.kill(pid)); toast(r && r.ok ? 'Client ended' : 'Could not end client', r && r.ok ? 'good' : 'bad'); break; }

    case 'modal-cancel':
      if (state.personJoin) closePersonJoinDialog();
      else if (state.followTargetId) closeFollowDialog();
      else { closeModal(); state.servers = null; state.sessionDraft = null; }
      break;
    case 'confirm-yes': if (confirmResolver) { confirmResolver(true); confirmResolver = null; } closeModal(); break;
    case 'confirm-no': if (confirmResolver) { confirmResolver(false); confirmResolver = null; } closeModal(); break;

    case 'clear-history': {
      const ok = await confirmDialog({ title: 'Clear history?', body: 'Remove all launch-history entries.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.history.clear()); views.history(); toast('History cleared', 'good');
      break;
    }

    case 'set-detect': {
      const auto = elAction.dataset.auto === 'true';
      const seg = $('#set-detect'); seg.dataset.auto = String(auto);
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === String(auto)));
      const row = $('#set-path-row'); if (row) row.style.display = auto ? 'none' : '';
      break;
    }
    case 'settings-browse': {
      const r = await call(() => api.settings.browse());
      if (r && r.ok && r.path) {
        const inp = $('#set-path'); if (inp) inp.value = r.path;
        const seg = $('#set-detect');
        if (seg) {
          seg.dataset.auto = 'false';
          seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === 'false'));
        }
        const row = $('#set-path-row'); if (row) row.style.display = '';
        if (!r.valid) {
          toast(r.reason || 'That file does not look like RobloxPlayerBeta.exe', 'bad');
          break;
        }
        const saved = await call(() => api.settings.save(currentSettingsDraft()));
        if (saved && saved.ok) {
          state.settings = saved.settings;
          await refreshStatus();
          views.settings();
          toast(state.status && state.status.robloxFound ? 'Roblox detected from manual path' : 'Manual path saved, but Roblox was not detected', state.status && state.status.robloxFound ? 'good' : 'bad');
        } else {
          toast((saved && saved.error) || 'Could not save Roblox path', 'bad');
        }
      }
      break;
    }
    case 'redetect': {
      const saved = await call(() => api.settings.save(currentSettingsDraft()));
      if (saved && saved.ok) state.settings = saved.settings;
      await refreshStatus();
      views.settings();
      toast(state.status && state.status.robloxFound ? 'Roblox detected' : 'Roblox not found', state.status && state.status.robloxFound ? 'good' : 'bad');
      break;
    }
    case 'update-check': {
      state.updater = Object.assign({}, state.updater, { state: 'checking', error: null });
      views.settings();
      const r = await call(() => api.updater.check());
      state.updater = await call(() => api.updater.status(), state.updater);
      if (!(r && r.ok)) toast((r && r.error) || 'Update check failed', 'bad');
      else if (state.updater.state === 'current') toast('Fleet is up to date', 'good');
      if (state.view === 'settings') views.settings();
      break;
    }
    case 'update-install': await call(() => api.updater.install()); break;
    case 'settings-save': saveSettings(); break;
    case 'settings-reset': {
      const ok = await confirmDialog({ title: 'Reset settings?', body: 'Restore all settings to their defaults.', confirmText: 'Reset', danger: true });
      if (!ok) break;
      const r = await call(() => api.settings.reset());
      if (r && r.ok) { state.settings = r.settings; views.settings(); toast('Settings reset', 'good'); }
      break;
    }

    case 'log-filter': state.logFilter = elAction.dataset.f;
      $('#log-filter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === state.logFilter));
      renderLogs(); break;
    case 'logs-clear': await call(() => api.logs.clear()); state.logs = []; renderLogs(); toast('Logs cleared', 'good'); break;
    case 'logs-folder': await call(() => api.logs.openFolder()); break;
    case 'copy-diag': copyDiagnostics(); break;
    case 'open-userdata': await call(() => api.openUserData()); break;
    case 'ext-link': await call(() => api.openExternal(elAction.dataset.url)); break;
  }
});

document.addEventListener('change', (e) => {
  const filter = e.target.closest('[data-server-filter]');
  if (!filter || !state.servers) return;
  const key = filter.dataset.serverFilter;
  if (!Object.prototype.hasOwnProperty.call(state.servers.filters, key)) return;
  state.servers.filters[key] = Number(filter.value) || 0;
  renderServersModal();
});

function needConfirm() { return !state.settings || state.settings.confirmCleanup !== false; }

/* Right-click context menu on instance rows */
content.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-row]');
  if (!row) return;
  e.preventDefault();
  const pid = parseInt(row.dataset.pid, 10);
  showContextMenu(e.clientX, e.clientY, [
    { id: 'focus', icon: 'focus', label: 'Focus window', onClick: () => doRowAction('focus', pid) },
    { id: 'restart', icon: 'rotate', label: 'Restart client', onClick: () => doRowAction('restart', pid) },
    { sep: true },
    { id: 'copy', icon: 'copy', label: 'Copy PID', onClick: () => navigator.clipboard.writeText(String(pid)).then(() => toast('PID copied', 'good')) },
    { sep: true },
    { id: 'end', icon: 'x', label: 'End client', danger: true, onClick: () => doRowAction('end', pid) },
  ]);
});
async function doRowAction(kind, pid) {
  if (kind === 'focus') { const r = await call(() => api.instances.focus(pid)); if (!(r && r.ok)) toast((r && r.reason) || 'Could not focus', 'bad'); }
  if (kind === 'restart') { const r = await call(() => api.instances.restart(pid)); toast(r && r.ok ? 'Restarted' : 'Restart failed', r && r.ok ? 'good' : 'bad'); }
  if (kind === 'end') { const r = await call(() => api.instances.kill(pid)); toast(r && r.ok ? 'Ended' : 'Could not end', r && r.ok ? 'good' : 'bad'); }
}

async function copyDiagnostics() {
  const g = state.diag || {};
  const lines = ['Fleet diagnostics', '----------------'];
  Object.keys(g).forEach(k => { if (k !== 'candidates') lines.push(k + ': ' + g[k]); });
  lines.push('', 'Recent log:');
  state.logs.slice(-40).forEach(e => lines.push(`[${e.time}] ${e.level.toUpperCase()} ${e.message}${e.detail ? ' | ' + e.detail : ''}`));
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('Diagnostics copied', 'good'); }
  catch (_) { toast('Could not copy', 'bad'); }
}

/* ----------------------------- Data + live updates ----------------------------- */
async function refreshStatus() {
  const r = await call(() => api.status(), null);
  if (r && r.ok) { state.status = r; state.settings = r.settings; }
}
async function loadInstances() {
  const r = await call(() => api.instances.get(), { instances: [] });
  if (r && r.instances) { state.instances = r.instances; if (state.view === 'instances') renderInstanceList(); updateNavCount(); }
}
async function loadAccounts() {
  const r = await call(() => api.accounts.list(), { accounts: [] });
  state.accounts = (r && r.accounts) || [];
  // prune selections that no longer exist
  for (const id of Array.from(state.selected)) if (!state.accounts.find(a => a.id === id)) state.selected.delete(id);
  updateAccountsCount();
}
function updateNavCount() { const el = $('#nav-count'); if (el) el.textContent = (state.instances || []).length; }
function updateAccountsCount() { const el = $('#nav-accounts'); if (el) el.textContent = (state.accounts || []).length; }

if (api) {
  let instanceRenderFrame = 0;
  api.onInstances((payload) => {
    if (payload && payload.instances) {
      state.instances = payload.instances;
      if (payload.summary) state.summary = payload.summary;
      updateNavCount();
      if (state.view === 'instances' && !instanceRenderFrame) {
        instanceRenderFrame = requestAnimationFrame(() => {
          instanceRenderFrame = 0;
          if (state.view === 'instances') renderInstanceList();
        });
      }
    }
  });
  api.onLog((entry) => {
    state.logs.push(entry);
    if (state.logs.length > 600) state.logs.shift();
    if (state.view === 'diagnostics' && (state.logFilter === 'all' || state.logFilter === entry.level)) renderLogs();
  });
  // Real-time presence/game: patch only the changed account card.
  api.onAccountUpdate((acc) => applyAccountUpdate(acc));
  // Session expired: keep the card and wait for an explicit Sign in again click.
  // Background polling must never open a login window or Roblox client.
  api.onAccountExpired((acc) => {
    applyAccountUpdate(acc);
    toast('Session expired for ' + (acc.username || 'an account') + ' - click Sign in again', 'bad');
  });
  // Re-authenticated (or new account added in background): reload the list.
  api.onAccountAdded(async () => { await loadAccounts(); if (state.view === 'accounts') views.accounts(); });
  api.onUpdaterStatus((status) => {
    state.updater = status;
    if (state.view === 'settings') views.settings();
    if (status && status.state === 'ready') toast(`Fleet ${status.availableVersion || 'update'} is ready`, 'good');
  });
}
setInterval(refreshInstanceElapsedTimes, 5000);
setInterval(refreshVisiblePeoplePresence, 10000);
setInterval(() => {
  if (!document.hidden && state.view === 'people' && state.people.route === 'server' && !state.people.server.loading && !state.people.server.refreshing) {
    loadServerPeople(true, { silent: true });
  }
}, SERVER_PEOPLE_REFRESH_MS);

// Infinite scroll for the Games search results
(() => {
  const scroller = document.querySelector('.content');
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    if (state.view !== 'games') return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 320) gamesLoadMore();
  }, { passive: true });
})();

/* ----------------------------- Boot ----------------------------- */
(async function boot() {
  if (!api) {
    content.innerHTML = `<div class="view"><div class="banner bad"><svg class="b-ico"><use href="#i-alert-circle"/></svg>
      <div class="b-text"><b>Fleet bridge unavailable</b><span>Open this through the Fleet application, not a browser.</span></div></div></div>`;
    return;
  }
  // Independent boot calls run together and each has a timeout, so one broken
  // subsystem can no longer leave users staring at the splash forever.
  await Promise.all([refreshStatus(), loadInstances(), loadAccounts()]);
  state.launchMode = state.accounts.length ? 'account' : 'plain';
  setView('instances');
})();

