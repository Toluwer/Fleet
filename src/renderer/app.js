'use strict';

/* Fleet renderer — pure UI. All OS/auth work happens in the main process and is
   reached only through the `window.fleet` bridge exposed by the preload. */

const api = window.fleet;

const state = {
  view: 'instances',
  status: null,
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
  games: { list: [], query: '', nextPageToken: null, loading: false, error: null, loaded: false },
  people: {
    route: 'home', returnRoute: 'home',
    list: [], page: 0, pageSize: 9, total: 0, hasNext: false, hasPrev: false, loading: false, error: null, loaded: false,
    search: {
      query: '', list: [], nextPageCursor: null, loading: false, error: null,
      searched: false, requestId: 0, notice: null, source: null, cached: false, retryable: false,
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
function icon(id) { return `<svg class="ico"><use href="#i-${id}"/></svg>`; }
function fmtBytes(b) {
  if (!b) return '0 MB';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
}
function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
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
  if (Number.isNaN(d.getTime())) return '—';
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
function openModal(htmlStr) { $('#modal').innerHTML = htmlStr; $('#modal-back').classList.add('open'); }
function closeModal() { $('#modal-back').classList.remove('open'); $('#modal').innerHTML = ''; }
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
        ${state.following ? '<span class="spinner"></span> Joining…' : `${icon('users-group')} Follow with ${count || ''}`}
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
    <div class="m-head"><h3>Join ${esc(join.name || 'player')}</h3><p>Pick one or more accounts — Fleet joins each into their exact server.</p></div>
    <div class="m-body">
      <div class="join-account-list">${choices}</div>
      <p class="hint" style="margin:13px 0 0">Fleet checks the live server with your selected account when you click Join. Private or privacy-restricted servers can still block the join.</p>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel" ${join.joining ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="person-join-confirm" ${!n || join.joining ? 'disabled' : ''}>
        ${join.joining ? '<span class="spinner"></span> Joining…' : `${icon('play')} Join${n ? ` with ${n} account${n === 1 ? '' : 's'}` : ''}`}
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

/* ----------------------------- Safe API ----------------------------- */
async function call(fn, fallback) {
  try {
    if (!api) throw new Error('Fleet bridge unavailable (run inside the Fleet app).');
    return await fn();
  } catch (err) {
    if (fallback !== undefined) return fallback;
    return { ok: false, error: err.message };
  }
}

/* ----------------------------- Router ----------------------------- */
const views = {};
function setView(name) {
  state.view = name;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  (views[name] || views.instances)();
}
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) {
    if (b.dataset.view === 'people') state.people.route = 'home';
    setView(b.dataset.view);
  }
});
function mount(html) { content.innerHTML = `<div class="view view-enter">${html}</div>`; }

/* ----------------------------- Instances view ----------------------------- */
views.instances = function () {
  const s = state.status || {};
  let detection;
  if (s.robloxFound) {
    detection = `<div class="banner good"><svg class="b-ico"><use href="#i-check-circle"/></svg>
      <div class="b-text"><b>Roblox detected</b><span>${esc(s.version || '')} · found via ${esc(s.source || '')}</span></div></div>`;
  } else {
    detection = `<div class="banner bad"><svg class="b-ico"><use href="#i-alert-circle"/></svg>
      <div class="b-text"><b>Roblox not found</b><span>Install Roblox, or set the path manually in Settings.</span></div>
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
      <div class="hint" style="margin:2px 0 12px">Select one or more accounts — Fleet opens a signed-in client for each.</div>
      <div class="chips">${hasAccounts ? accountChips : '<span class="hint">No accounts yet.</span>'}</div>
      <div class="inline" style="margin-top:16px">
        <input id="lp-place" type="text" inputmode="numeric" placeholder="Place ID (optional — join a game)" value="${esc(state.placeId)}" style="max-width:280px" data-tip="Leave blank to open the Roblox home signed in" />
        <div class="spacer" style="flex:1"></div>
        <button class="btn primary lg" data-action="launch-accounts" ${s.robloxFound ? '' : 'disabled'}>${icon('play')} <span id="lp-count-label">Launch ${state.selected.size || ''}</span></button>
      </div>
    </div>`;

  const plainPanel = `
    <div id="lp-plain" style="${mode === 'plain' ? '' : 'display:none'}">
      <div class="hint" style="margin:2px 0 12px">Opens signed-out clients. Each starts a real, separate Roblox client.</div>
      <div class="inline">
        <div class="stepper" data-tip="How many clients to open">
          <button data-action="step" data-dir="-1" data-target="launch-count">–</button>
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
      <p>Launch Roblox and watch every client live. Fleet isolates each one, so you can run several at once — signed in to different accounts or signed out.</p>
    </div>
    ${detection}
    ${lockBanner}
    <div class="card pad" style="margin-top:14px">
      <div class="row-split" style="margin-bottom:16px">
        <div style="font-weight:600;font-size:15px">Launch Roblox</div>
        ${modeToggle}
      </div>
      ${accountPanel}
      ${plainPanel}
    </div>

    <div class="row-split" style="margin:26px 2px 12px">
      <div class="section-title" style="margin:0">Running clients</div>
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
};

function renderInstanceList() {
  const list = $('#ilist');
  if (!list) return;
  const items = state.instances || [];
  const sCard = $('#summary-card');
  const sum = state.summary;
  if (sum && items.length) {
    sCard.style.display = '';
    $('#summary').innerHTML = `
      <div class="stat"><span class="v">${sum.total}</span><span class="k">Total</span></div>
      <div class="stat"><span class="v">${sum.fleet}</span><span class="k">Launched by Fleet</span></div>
      <div class="stat"><span class="v">${sum.external}</span><span class="k">External</span></div>
      <div class="stat"><span class="v">${sum.notResponding}</span><span class="k">Not responding</span></div>
      <div class="stat"><span class="v">${fmtBytes(sum.totalMemBytes)}</span><span class="k">Total memory</span></div>`;
  } else { sCard.style.display = 'none'; }

  if (!items.length) {
    list.innerHTML = `<div class="card"><div class="empty"><div class="e-ico">${icon('box')}</div>
      <h3>No Roblox clients running</h3><p>Use <b>Launch</b> above to open one.</p></div></div>`;
    return;
  }
  const head = `<div class="head"><span></span><span>PID</span><span>Window / source</span><span>Memory</span><span class="when">Started</span><span></span></div>`;
  const rows = items.map(i => {
    const tag = i.source === 'fleet'
      ? `<span class="tag fleet">${i.profileName ? esc(i.profileName) : 'Fleet'}</span>`
      : `<span class="tag external">External</span>`;
    const title = i.windowTitle ? esc(i.windowTitle) : '<span style="color:var(--ink-3)">Loading…</span>';
    const started = (i.startedExact ? '' : '~') + relTime(i.startedAt);
    return `<div class="irow" data-pid="${i.pid}" data-row>
      <span class="dot ${i.status}" data-tip="${i.status === 'not_responding' ? 'Not responding' : 'Running'}"></span>
      <span class="pid">${i.pid}</span>
      <span><div class="title">${title}</div><div style="margin-top:4px">${tag}</div></span>
      <span class="mem">${fmtBytes(i.memBytes)}</span>
      <span class="when" data-tip="${i.startedExact ? 'Launched by Fleet' : 'First seen by Fleet'}">${started}</span>
      <span class="actions">
        <button class="btn icon sm" data-action="focus" data-pid="${i.pid}" data-tip="Bring window to front">${icon('focus')}</button>
        <button class="btn icon sm" data-action="restart" data-pid="${i.pid}" data-tip="Restart this client">${icon('rotate')}</button>
        <button class="btn icon sm danger" data-action="end" data-pid="${i.pid}" data-tip="End this client">${icon('x')}</button>
      </span>
    </div>`;
  }).join('');
  list.innerHTML = head + rows;
}

function updateLaunchCount() {
  const lbl = $('#lp-count-label');
  if (lbl) lbl.textContent = 'Launch ' + (state.selected.size || '');
}

/* ----------------------------- Accounts view ----------------------------- */
views.accounts = function () {
  const list = state.accounts || [];
  const selectedCount = state.selected.size;

  const cards = list.length ? `<div class="acct-grid">` + list.map(a => {
    const presRaw = a.presence || 'Offline';
    const pl = presRaw.toLowerCase();
    const presClass = pl === 'online' ? 'online'
      : (pl.includes('game') || pl.includes('studio')) ? 'ingame'
      : (pl === 'unknown' ? 'unknown' : '');
    const presTip = a.presenceError ? ` data-tip="${esc(a.presenceError)}"` : '';
    const canFollow = pl === 'in game' && list.length > 1;
    const followTip = list.length < 2 ? 'Add another account to use Follow'
      : (canFollow ? 'Choose other accounts to join this exact server' : 'This account must be in a game');
    return `
    <div class="acct ${state.selected.has(a.id) ? 'selected' : ''}" data-id="${a.id}">
      <div class="top">
        ${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : `<div class="avatar"></div>`}
        <div class="who">
          <div class="dname">${esc(a.displayName || a.username)}</div>
          <div class="uname">@${esc(a.username)}</div>
        </div>
        <div class="check" data-action="toggle-account" data-id="${a.id}" data-tip="Select for launch">${icon('check')}</div>
      </div>
      <div class="row-split">
        <span class="presence ${presClass}"${presTip} data-acct-presence="${a.id}"><span class="pd"></span>${esc(presRaw)}</span>
        <span class="hint" style="font-size:11.5px">Added ${esc(relTime(a.addedAt))} ago</span>
      </div>
      <div class="acct-game" data-acct-game="${a.id}"${a.game ? '' : ' hidden'}>${a.game ? icon('compass') + ' ' + esc(a.game.name) : ''}</div>
      <div class="acct-actions">
        <button class="btn primary sm" data-action="launch-account" data-id="${a.id}">${icon('play')} Launch</button>
        <button class="btn sm" data-action="follow-account" data-id="${a.id}" data-tip="${esc(followTip)}" ${canFollow ? '' : 'disabled'}>${icon('users-group')} Follow</button>
        <button class="btn sm icon" data-action="refresh-account" data-id="${a.id}" data-tip="Refresh status">${icon('refresh')}</button>
        <button class="btn sm icon danger" data-action="remove-account" data-id="${a.id}" data-tip="Remove account">${icon('trash')}</button>
      </div>
    </div>`;
  }).join('') + `</div>`
    : `<div class="card"><div class="empty"><div class="e-ico">${icon('users')}</div>
        <h3>No accounts yet</h3><p>Add a Roblox account to launch clients already signed in.</p></div></div>`;

  mount(`
    <div class="page-head">
      <h1>Accounts</h1>
      <p>Sign in to your Roblox accounts once, then launch any of them — alone or several at a time. Sessions are stored encrypted on this PC and never leave it.</p>
    </div>
    <div class="row-split" style="margin-bottom:16px">
      <div class="section-title" style="margin:0">Your accounts</div>
      <div class="inline">
        ${list.length ? `<button class="btn sm" data-action="refresh-accounts" data-tip="Refresh all">${icon('refresh')} Refresh all</button>` : ''}
        ${selectedCount ? `<button class="btn primary sm" data-action="launch-selected">${icon('play')} Launch ${selectedCount} selected</button>` : ''}
        <button class="btn primary sm" data-action="add-account" ${state.addingAccount ? 'disabled' : ''}>
          ${state.addingAccount ? '<span class="spinner"></span>' : icon('user-plus')} ${state.addingAccount ? 'Waiting for sign-in…' : 'Add account'}
        </button>
      </div>
    </div>
    ${cards}
  `);
};

function presenceClass(presRaw) {
  const pl = (presRaw || 'Offline').toLowerCase();
  if (pl === 'online') return 'online';
  if (pl.includes('game') || pl.includes('studio')) return 'ingame';
  if (pl === 'unknown') return 'unknown';
  return '';
}

/**
 * Real-time per-card update: the main process pushes only accounts whose
 * status/game changed. Patch just that card in place — no full re-render,
 * no timer, no extra network from the renderer.
 */
function applyAccountUpdate(acc) {
  if (!acc || !acc.id) return;
  const i = state.accounts.findIndex(a => a.id === acc.id);
  if (i >= 0) state.accounts[i] = Object.assign({}, state.accounts[i], acc);

  const presEl = document.querySelector(`[data-acct-presence="${acc.id}"]`);
  if (presEl) {
    presEl.className = 'presence ' + presenceClass(acc.presence);
    presEl.innerHTML = `<span class="pd"></span>${esc(acc.presence || 'Offline')}`;
    if (acc.presenceError) presEl.setAttribute('data-tip', acc.presenceError);
    else presEl.removeAttribute('data-tip');
  }
  const gameEl = document.querySelector(`[data-acct-game="${acc.id}"]`);
  if (gameEl) {
    if (acc.game && acc.game.name) { gameEl.hidden = false; gameEl.innerHTML = icon('compass') + ' ' + esc(acc.game.name); }
    else { gameEl.hidden = true; gameEl.innerHTML = ''; }
  }
}

/* ----------------------------- Games view ----------------------------- */
views.games = function () {
  const g = state.games;
  mount(`
    <div class="page-head">
      <h1>Games</h1>
      <p>Browse and search Roblox experiences, then jump straight in. Joining uses the game's place ID${state.accounts.length ? ' and your selected account (or the first one).' : ' — add an account to join signed in.'}</p>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="games-search" type="text" placeholder="Search experiences…" value="${esc(g.query)}"></div>
      <button class="btn" data-action="refresh-games" data-tip="Reload popular experiences">${icon('refresh')} Refresh</button>
      <button class="btn primary" data-action="random-game" data-tip="Join a random game from the list">${icon('dice')} Random Game</button>
    </div>
    <div class="games-grid" id="games-grid"></div>
  `);
  const inp = $('#games-search');
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doGamesSearch(inp.value); });
  if (!g.loaded && !g.loading) gamesBrowse();
  else renderGamesGrid();
};

function gameCard(gm) {
  const thumb = gm.thumbnail
    ? `<img loading="lazy" src="${esc(gm.thumbnail)}" alt="">`
    : `<div class="ph">${icon('compass')}</div>`;
  const likes = gm.upVotes != null ? `<span class="likes">${icon('thumb')} ${fmtNum(gm.upVotes)}</span>` : '';
  return `<div class="game">
    <div class="game-thumb">${thumb}<span class="game-players">${icon('users-group')} ${fmtNum(gm.playerCount)}</span></div>
    <div class="game-body">
      <div class="game-name" title="${esc(gm.name)}">${esc(gm.name)}</div>
      <div class="game-meta">${gm.creator ? '<span>' + esc(gm.creator) + '</span>' : ''}${likes}</div>
      <div class="game-actions">
        <button class="btn primary sm" data-action="join-game" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}">${icon('play')} Join</button>
        <button class="btn sm" data-action="open-servers" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}" data-tip="Browse & join a specific server">${icon('server')}</button>
      </div>
    </div>
  </div>`;
}

/* ----------------------------- Server browser ----------------------------- */
function renderServersModal() {
  const sv = state.servers;
  if (!sv) return;
  let body;
  if (sv.loading && !sv.list.length) body = `<div class="games-end"><span class="spinner dark"></span> Loading servers…</div>`;
  else if (sv.error && !sv.list.length) body = `<div class="games-end">${esc(sv.error)}</div>`;
  else if (!sv.list.length) body = `<div class="games-end">No public servers found.</div>`;
  else body = `<div class="server-list">${sv.list.map((s, i) => `
      <div class="server-row">
        <div class="server-fill"><strong>${s.playing}/${s.maxPlayers}</strong><span>players</span></div>
        <div class="server-bar"><span style="width:${s.maxPlayers ? Math.min(100, Math.round(s.playing / s.maxPlayers * 100)) : 0}%"></span></div>
        <div class="server-meta">${s.ping != null ? `${s.ping} ms` : ''}${s.fps != null ? ` · ${s.fps} fps` : ''}</div>
        <button class="btn primary sm" data-action="join-server" data-place="${esc(sv.placeId)}" data-server="${esc(s.id)}" data-name="${esc(sv.name)}" data-tip="Server #${i + 1}">${icon('play')} Join</button>
      </div>`).join('')}
      ${sv.nextPageCursor ? `<button class="btn sm servers-more" data-action="servers-more">Load more servers</button>` : ''}</div>`;
  openModal(`
    <div class="m-head"><h3>Servers — ${esc(sv.name)}</h3><p>Join a specific public server${state.accounts.length ? ' with your selected account' : ''}.</p></div>
    <div class="m-body">${body}</div>
    <div class="m-foot"><button class="btn" data-action="modal-cancel">Close</button></div>`);
}

async function openServersModal(placeId, name) {
  state.servers = { placeId: String(placeId), name: name || 'game', list: [], cursor: null, nextPageCursor: null, loading: true, error: null };
  renderServersModal();
  await loadServers(false);
}

async function loadServers(append) {
  const sv = state.servers;
  if (!sv) return;
  sv.loading = true;
  renderServersModal();
  const r = await call(() => api.games.servers(sv.placeId, append ? sv.nextPageCursor : null));
  if (!state.servers) return;
  sv.loading = false;
  if (r && r.ok) { sv.list = append ? sv.list.concat(r.servers) : r.servers; sv.nextPageCursor = r.nextPageCursor; }
  else sv.error = (r && r.error) || 'Could not load servers.';
  renderServersModal();
}

async function joinServer(placeId, serverId, name) {
  if (!state.accounts.length) { toast('Add an account to join a server', 'bad'); closeModal(); state.servers = null; setView('accounts'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  const r = await call(() => api.launch.join(ids, String(placeId), String(serverId)));
  if (r && r.ok) { toast(`Joining ${name} · ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good'); closeModal(); state.servers = null; }
  else toast((r && r.error) || 'Join failed', 'bad');
}

function renderGamesGrid() {
  const grid = $('#games-grid');
  if (!grid) return;
  const g = state.games;
  if (g.loading && !g.list.length) { grid.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Loading experiences…</div>`; return; }
  if (g.error && !g.list.length) { grid.innerHTML = `<div class="games-end">${esc(g.error)}</div>`; return; }
  if (!g.list.length) { grid.innerHTML = `<div class="games-end">No experiences found.</div>`; return; }
  let tail = '';
  if (g.nextPageToken && g.query) tail = `<div class="games-end"><span class="spinner dark"></span> Scroll for more…</div>`;
  else if (g.query) tail = `<div class="games-end">End of results</div>`;
  grid.innerHTML = g.list.map(gameCard).join('') + tail;
}

async function gamesBrowse() {
  const g = state.games;
  g.loading = true; g.error = null; g.query = ''; g.list = []; g.nextPageToken = null;
  if (state.view === 'games') renderGamesGrid();
  const r = await call(() => api.games.browse());
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; }
  else g.error = (r && r.error) || 'Could not load games.';
  if (state.view === 'games') renderGamesGrid();
}

async function doGamesSearch(query) {
  const g = state.games;
  g.query = (query || '').trim(); g.loading = true; g.error = null; g.list = []; g.nextPageToken = null;
  if (state.view === 'games') renderGamesGrid();
  const r = await call(() => (g.query ? api.games.search(g.query) : api.games.browse()));
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; }
  else g.error = (r && r.error) || 'Search failed.';
  if (state.view === 'games') renderGamesGrid();
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
  toast('Joining ' + (name || 'game') + (ids.length > 1 ? ' with ' + ids.length + ' accounts' : '') + '…');
  const r = await call(() => api.launch.accounts(ids, String(placeId)));
  if (r && r.ok) toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
  else toast((r && r.error) || 'Join failed', 'bad');
}

/* ----------------------------- People view ----------------------------- */
views.people = function () {
  if (state.people.route === 'friends') return renderFriendsPage();
  if (state.people.route === 'profile') return renderPeopleProfile();
  return renderPeopleHome();
};

function renderPeopleHome() {
  const pp = state.people;
  const search = pp.search;
  mount(`
    <div class="page-head">
      <h1>People</h1>
      <p>Find Roblox users or browse friends shared across your saved accounts.</p>
    </div>
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

function personCard(u) {
  const presClass = presenceClass(u.presence);
  const avatar = u.avatar ? `<img class="avatar" loading="lazy" src="${esc(u.avatar)}" alt="">` : `<div class="avatar"></div>`;
  const gameLine = u.game && u.game.name ? `<div class="acct-game">${icon('compass')} ${esc(u.game.name)}</div>` : '';
  const join = u.canJoin
    ? `<button class="btn primary sm" data-action="join-person" data-user="${esc(u.userId)}" data-place="${esc(u.placeId)}" data-game="${esc(u.gameId || '')}" data-name="${esc(u.displayName)}">${icon('play')} Join</button>`
    : '';
  const sources = u.connectedAccounts && u.connectedAccounts.length
    ? `<div class="friend-source">Friend of ${esc(u.connectedAccounts.map(a => a.displayName).join(', '))}</div>` : '';
  return `<div class="person">
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
      <span class="presence ${presClass}"><span class="pd"></span>${esc(u.presence)}</span>
      <span class="inline">${join}<button class="btn sm" data-action="open-person" data-user="${esc(u.userId)}">View</button></span>
    </div>
    ${gameLine}
  </div>`;
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
      <div class="section-title" style="margin:0">${pp.total ? `${start}–${end} of ${pp.total}` : 'Friends'}</div>
      <div class="inline">
        <button class="btn sm" data-action="people-prev" ${pp.hasPrev ? '' : 'disabled'}>${icon('chevron-left')} Previous</button>
        <button class="btn sm" data-action="people-next" ${pp.hasNext ? '' : 'disabled'}>Next ${icon('chevron-right')}</button>
        <button class="btn sm" data-action="people-refresh" data-tip="Reload">${icon('refresh')}</button>
      </div>
    </div>
    <div class="people-grid" id="people-grid"></div>
  `);
  if (!pp.loaded && !pp.loading) loadPeople(0);
  else renderPeopleGrid();
}

function renderPeopleGrid() {
  const grid = $('#people-grid');
  if (!grid) return;
  const pp = state.people;
  if (pp.loading) { grid.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Loading people…</div>`; return; }
  if (pp.error) { grid.innerHTML = `<div class="games-end">${esc(pp.error)}</div>`; return; }
  if (!pp.list.length) { grid.innerHTML = `<div class="card"><div class="empty"><div class="e-ico">${icon('users-group')}</div><h3>No people to show</h3><p>Add an account with friends to populate this list.</p></div></div>`; return; }
  grid.innerHTML = pp.list.map(personCard).join('');
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
    root.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Searching people…</div>`;
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
    <div class="people-result-head"><div class="section-title">Results for “${esc(search.query)}”</div><span>${search.list.length} shown</span></div>
    <div class="people-grid">${search.list.length ? search.list.map(personCard).join('') : '<div class="games-end">No people found.</div>'}</div>
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
  const backLabel = state.people.returnRoute === 'friends' ? 'Back to Friends' : 'Back to People';
  if (detail.loading) {
    mount(`<button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button><div class="profile-loading"><span class="spinner dark"></span> Loading public profile data…</div>`);
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
  const join = u.canJoin && u.game ? `<button class="btn primary" data-action="join-person" data-user="${esc(u.userId)}" data-place="${esc(u.game.placeId)}" data-game="${esc(u.game.gameId || '')}" data-name="${esc(u.displayName)}">${icon('play')} Join game</button>` : '';
  const groups = u.groups || [], badges = u.robloxBadges || [], assets = u.avatarDetails && u.avatarDetails.assets || [];
  const collectibles = u.inventory && u.inventory.collectibles || [];
  mount(`
    <button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button>
    <div class="profile-hero">
      <div class="profile-identity">
        ${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : `<span class="profile-avatar-ph">${icon('users-group')}</span>`}
        <div><h1>${esc(u.displayName)} ${u.hasVerifiedBadge ? `<span class="verified">${icon('check-circle')}</span>` : ''}</h1><p>@${esc(u.username)}</p>
          <span class="presence ${presClass}"><span class="pd"></span>${esc(u.presence)}</span></div>
      </div>
      <div class="inline">${join}<button class="btn" data-action="ext-link" data-url="${esc(u.profileUrl)}">Open on Roblox</button></div>
    </div>
    <div class="profile-stats">${peopleStat('Friends', counts.friends)}${peopleStat('Followers', counts.followers)}${peopleStat('Following', counts.following)}</div>
    <div class="profile-layout">
      <div class="profile-main">
        <section class="profile-section"><h2>About</h2><p class="profile-bio">${esc(u.bio || 'No description provided.')}</p>
          <div class="profile-facts"><span><strong>Joined</strong>${esc(created)}${accountAge(u.created) ? ` · ${esc(accountAge(u.created))} old` : ''}</span><span><strong>User ID</strong>${esc(u.userId)}</span><span><strong>Connection</strong>${esc(source)}</span><span><strong>Account</strong>${u.isBanned ? 'Banned' : 'Active'}</span></div>
          ${u.game ? `<div class="now-playing${u.canJoin ? ' joinable' : ''}">${icon('compass')} <span><strong>${esc(u.game.name)}</strong><small>${u.canJoin ? 'Playing now — Fleet checks access when you join' : 'Currently playing'}</small></span>${u.canJoin ? `<button class="btn primary sm" data-action="join-person" data-user="${esc(u.userId)}" data-place="${esc(u.game.placeId)}" data-game="${esc(u.game.gameId || '')}" data-name="${esc(u.displayName)}">${icon('play')} Join</button>` : ''}</div>` : ''}
        </section>
        ${profileGameSection('Created experiences', u.createdGames || [])}
        ${profileGameSection('Favorite experiences', u.favoriteGames || [])}
        ${profileListSection('Groups', groups, 'No public groups.', group => `<div class="profile-row"><span>${icon('users-group')}</span><div><strong>${esc(group.name)}</strong><small>${esc(group.role || 'Member')}${group.memberCount ? ` · ${fmtNum(group.memberCount)} members` : ''}</small></div></div>`)}
        ${profileListSection('Roblox badges', badges, 'No Roblox badges.', badge => `<div class="profile-row"><span>${icon('check-circle')}</span><div><strong>${esc(badge.name)}</strong><small>${esc(badge.description || 'Roblox badge')}</small></div></div>`)}
      </div>
      <aside class="profile-side">
        <section class="profile-section avatar-preview"><h2>Avatar</h2>${u.fullBodyAvatar ? `<img src="${esc(u.fullBodyAvatar)}" alt="Full avatar">` : '<p class="profile-empty">Avatar unavailable.</p>'}
          ${u.avatarDetails ? `<p>${esc(u.avatarDetails.avatarType || 'Avatar')} · ${assets.length} equipped asset${assets.length === 1 ? '' : 's'}</p>` : ''}</section>
        ${profileListSection('Currently wearing', assets, 'Outfit details unavailable.', asset => `<div class="asset-row"><strong>${esc(asset.name)}</strong><small>${esc(asset.assetType || 'Asset')} · #${esc(asset.id)}</small></div>`)}
        ${profileListSection('Previous usernames', u.previousUsernames || [], 'No previous usernames.', name => `<div class="asset-row"><strong>@${esc(name)}</strong></div>`)}
        ${profileListSection('Public collectibles', collectibles, u.inventory && u.inventory.canView ? 'No collectibles returned.' : 'Inventory is private.', item => `<div class="asset-row"><strong>${esc(item.name)}</strong><small>${esc(item.assetType || 'Collectible')}${item.recentAveragePrice ? ` · ${fmtNum(item.recentAveragePrice)} recent value` : ''}</small></div>`)}
      </aside>
    </div>`);
}

async function openPerson(userId) {
  const id = Number(userId);
  if (!id) return;
  state.people.returnRoute = state.people.route === 'friends' ? 'friends' : 'home';
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
views.history = async function () {
  const r = await call(() => api.history.get(), { history: [] });
  state.history = (r && r.history) || [];
  const rows = state.history.length ? state.history.map(h => `
    <tr>
      <td>${esc(fmtTime(h.time))}</td>
      <td>${esc(h.profileName)}</td>
      <td><span class="pill ${esc(h.result)}">${esc(h.result)}</span></td>
      <td class="mono">${h.pid || '—'}</td>
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
  const kv = (k, v) => `<div class="k">${esc(k)}</div><div class="v">${esc(v == null ? '—' : v)}</div>`;
  mount(`
    <div class="page-head"><h1>Diagnostics</h1><p>Environment details and a live log to help troubleshoot. Share these if you report a problem.</p></div>
    <div class="section-title">Environment</div>
    <div class="card pad">
      <div class="kv">
        ${kv('Fleet version', g.appVersion)}
        ${kv('Electron / Chrome', (g.electron || '?') + ' / ' + (g.chrome || '?'))}
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
  const auto = s.autoDetect !== false;
  mount(`
    <div class="page-head"><h1>Settings</h1><p>Everything is saved to your user profile and persists between sessions.</p></div>
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
      ${settingRow('Confirm before bulk actions', 'Ask for confirmation before “End all” and “Cleanup”.',
        `<label class="toggle"><input type="checkbox" id="set-confirm" ${s.confirmCleanup ? 'checked' : ''}><span class="track"></span></label>`)}
      ${settingRow('Refresh interval', 'How often the running-clients list updates (750–10000 ms).',
        `<input id="set-poll" type="number" min="750" max="10000" step="250" value="${s.pollIntervalMs}" style="width:120px">`)}
      ${settingRow('Delay between launches', 'Pause between each client in a multi-launch so each boots first (0–20000 ms).',
        `<input id="set-delay" type="number" min="0" max="20000" step="500" value="${s.launchDelayMs}" style="width:120px">`)}
      ${settingRow('Warn above this many instances', 'Show a heads-up when launching would exceed this count.',
        `<input id="set-warn" type="number" min="1" max="100" value="${s.warnInstanceCount}" style="width:120px">`)}
      ${settingRow('History entries to keep', 'Maximum launch-history rows stored (10–2000).',
        `<input id="set-historylimit" type="number" min="10" max="2000" step="10" value="${s.historyLimit}" style="width:120px">`)}
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
async function saveSettings() {
  const auto = $('#set-detect').dataset.auto === 'true';
  const partial = {
    autoDetect: auto,
    robloxPath: $('#set-path') ? $('#set-path').value.trim() : (state.settings.robloxPath || ''),
    confirmCleanup: $('#set-confirm').checked,
    pollIntervalMs: parseInt($('#set-poll').value, 10),
    launchDelayMs: parseInt($('#set-delay').value, 10),
    warnInstanceCount: parseInt($('#set-warn').value, 10),
    historyLimit: parseInt($('#set-historylimit').value, 10),
  };
  const r = await call(() => api.settings.save(partial));
  if (r && r.ok) { state.settings = r.settings; toast('Settings saved', 'good'); await refreshStatus(); views.settings(); }
  else toast((r && r.error) || 'Could not save settings', 'bad');
}

/* ----------------------------- Help view ----------------------------- */
views.help = function () {
  mount(`
    <div class="help">
      <div class="page-head"><h1>Help</h1><p>Everything you need to use Fleet — no external guide required.</p></div>

      <h2>What Fleet does</h2>
      <p>Fleet runs several Roblox clients on one PC at the same time and manages them from one place. Normally Roblox allows only a single client; Fleet works around that automatically — no settings to change.</p>

      <h2>Quick start</h2>
      <div class="step"><div class="n">1</div><div>On <b>Accounts</b>, click <b>Add account</b> and sign in to Roblox in the window that opens. Your session is stored encrypted on this PC.</div></div>
      <div class="step"><div class="n">2</div><div>On <b>Instances</b>, choose <b>With account</b>, pick one or more accounts (optionally enter a Place ID to join a game), and click <b>Launch</b>.</div></div>
      <div class="step"><div class="n">3</div><div>Every client appears under <b>Running clients</b>, where you can focus, restart or end it. Prefer signed-out clients? Switch the toggle to <b>Signed out</b> and pick a number.</div></div>

      <h2>Accounts</h2>
      <p>Add as many accounts as you like. Each card shows the avatar, name and presence. Select several and use <b>Launch selected</b> to open them all at once — Fleet signs each client in automatically using a single-use launch ticket, the same mechanism the Roblox site uses when you press Play. When an account is <b>In game</b>, click <b>Follow</b> and choose other accounts to join its exact server.</p>

      <h2>How multi-instance works</h2>
      <p>Roblox guards single-instance with named Windows objects, including a mutex tied to the client's exact program path. Fleet launches each client through its own folder “junction” (a unique path, no files copied) and a small guard clears the shared lock as it reappears — so every launch opens a new client that stays running.</p>

      <h2>Tools</h2>
      <ul>
        <li><b>Focus</b> brings a client's window to the front. <b>Restart</b> relaunches it. <b>End</b> closes it.</li>
        <li><b>End all</b> closes every client; <b>Cleanup</b> also clears leftover Roblox crash-handler processes.</li>
        <li>Right-click any client for the same actions plus <b>Copy PID</b>.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <div class="faq">
        <details><summary>“Roblox not found”</summary><div class="a">Install Roblox, or open <b>Settings → Roblox location</b>, switch to <b>Manual path</b> and point Fleet at <code>RobloxPlayerBeta.exe</code>.</div></details>
        <details><summary>A client closes after sign-in</summary><div class="a">The launch ticket may have expired — try again. Give each launch a few seconds (raise <b>Settings → Delay between launches</b> on a slow PC).</div></details>
        <details><summary>An account shows “Session expired”</summary><div class="a">Roblox sessions don't last forever. Remove the account and add it again to refresh the sign-in.</div></details>
        <details><summary>Is my login safe?</summary><div class="a">Your session cookie is encrypted with Windows DPAPI and stored only on this PC. It never leaves your machine and is never shown in the interface.</div></details>
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
      document.querySelectorAll(`.chip[data-id="${id}"]`).forEach(c => c.classList.toggle('on', state.selected.has(id)));
      document.querySelectorAll(`.acct[data-id="${id}"]`).forEach(c => c.classList.toggle('selected', state.selected.has(id)));
      updateLaunchCount();
      if (state.view === 'accounts') views.accounts();
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
      const placeId = placeEl ? placeEl.value.trim() : state.placeId;
      state.placeId = placeId;
      elAction.disabled = true;
      const r = await call(() => api.launch.accounts(ids, placeId));
      elAction.disabled = false;
      if (r && r.ok) toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      else toast((r && r.error) || 'Launch failed', 'bad');
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
      toast('Opening Roblox sign-in…');
      const r = await call(() => api.accounts.add());
      state.addingAccount = false;
      if (r && r.ok) { await loadAccounts(); toast((r.updated ? 'Account updated: ' : 'Account added: ') + (r.account ? r.account.username : ''), 'good'); }
      else if (r && r.canceled) toast('Sign-in canceled');
      else toast((r && r.error) || 'Could not add account', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'remove-account': {
      const acc = state.accounts.find(a => a.id === id);
      const ok = await confirmDialog({ title: 'Remove account?', body: 'Remove “' + (acc ? acc.username : '') + '” from Fleet? This deletes its stored session on this PC.', confirmText: 'Remove', danger: true });
      if (!ok) break;
      const r = await call(() => api.accounts.remove(id));
      state.selected.delete(id);
      if (r && r.ok) { state.accounts = r.accounts; updateAccountsCount(); views.accounts(); toast('Account removed', 'good'); }
      break;
    }
    case 'refresh-account': {
      const r = await call(() => api.accounts.refresh(id));
      if (r && r.ok) { state.accounts = r.accounts; views.accounts(); toast('Refreshed', 'good'); }
      break;
    }
    case 'refresh-accounts': {
      toast('Refreshing accounts…');
      const r = await call(() => api.accounts.refresh(undefined, true));
      if (r && r.ok) { state.accounts = r.accounts; state.accountsRefreshedAt = Date.now(); views.accounts(); toast('Accounts refreshed', 'good'); }
      break;
    }

    case 'refresh-games': gamesBrowse(); break;
    case 'random-game': {
      const list = state.games.list;
      if (!list.length) { toast('No games loaded yet', 'bad'); break; }
      const gm = list[Math.floor(Math.random() * list.length)];
      joinPlace(gm.placeId, gm.name);
      break;
    }
    case 'join-game': joinPlace(elAction.dataset.place, elAction.dataset.name); break;
    case 'open-servers': openServersModal(elAction.dataset.place, elAction.dataset.name); break;
    case 'join-server': joinServer(elAction.dataset.place, elAction.dataset.server, elAction.dataset.name); break;
    case 'servers-more': loadServers(true); break;

    case 'open-friends': state.people.route = 'friends'; views.people(); break;
    case 'people-home': state.people.route = 'home'; views.people(); break;
    case 'people-back': state.people.route = state.people.returnRoute || 'home'; views.people(); break;
    case 'people-search': runPeopleSearch(($('#people-search') || {}).value || ''); break;
    case 'people-search-retry': runPeopleSearch(state.people.search.query); break;
    case 'people-search-clear': clearPeopleSearch(); break;
    case 'people-search-more': runPeopleSearch(state.people.search.query, true); break;
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
      toast(r && r.ok ? `Arranged ${r.tiled} window${r.tiled === 1 ? '' : 's'} in a ${r.cols}×${r.rows} grid` : (r && r.reason) || 'Could not arrange windows', r && r.ok ? 'good' : 'bad');
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
      else { state.servers = null; closeModal(); }
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
      if (r && r.ok && r.path) { const inp = $('#set-path'); if (inp) inp.value = r.path; if (!r.valid) toast('That file does not look like RobloxPlayerBeta.exe', 'bad'); }
      break;
    }
    case 'redetect': { await refreshStatus(); views.settings(); toast(state.status && state.status.robloxFound ? 'Roblox detected' : 'Roblox not found', state.status && state.status.robloxFound ? 'good' : 'bad'); break; }
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
  updateLockChip();
}
function updateLockChip() {
  const chip = $('#lockchip'); const txt = $('#lock-text'); const s = state.status || {};
  chip.classList.remove('held', 'unavail');
  if (s.ffiAvailable === false) { chip.classList.add('unavail'); txt.textContent = 'Multi-instance: off'; }
  else { chip.classList.add('held'); txt.textContent = 'Multi-instance: ready'; }
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
  api.onInstances((payload) => {
    if (payload && payload.instances) {
      state.instances = payload.instances;
      if (payload.summary) state.summary = payload.summary;
      updateNavCount();
      if (state.view === 'instances') renderInstanceList();
    }
  });
  api.onLog((entry) => {
    state.logs.push(entry);
    if (state.logs.length > 600) state.logs.shift();
    if (state.view === 'diagnostics' && (state.logFilter === 'all' || state.logFilter === entry.level)) renderLogs();
  });
  // Real-time presence/game: patch only the changed account card.
  api.onAccountUpdate((acc) => applyAccountUpdate(acc));
  // Session expired: drop the card; main is already opening the sign-in window.
  api.onAccountExpired((acc) => {
    state.selected.delete(acc.id);
    state.accounts = state.accounts.filter(a => a.id !== acc.id);
    updateAccountsCount();
    if (state.view === 'accounts') views.accounts();
    toast('Session expired for ' + (acc.username || 'an account') + ' — sign in again', 'bad');
  });
  // Re-authenticated (or new account added in background): reload the list.
  api.onAccountAdded(async () => { await loadAccounts(); if (state.view === 'accounts') views.accounts(); });
}
setInterval(() => { if (state.view === 'instances') renderInstanceList(); }, 5000);

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
  await refreshStatus();
  await loadInstances();
  await loadAccounts();
  state.launchMode = state.accounts.length ? 'account' : 'plain';
  setView('instances');
})();
