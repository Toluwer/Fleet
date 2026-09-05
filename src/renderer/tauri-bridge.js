'use strict';

function tauriApi() {
  return window.__TAURI__ || {};
}

function wrapEvent(channel, cb) {
  const listen = tauriApi().event && tauriApi().event.listen;
  if (typeof listen !== 'function') return () => {};
  let unlisten = null;
  listen(channel, (event) => {
    try { cb(event.payload); } catch (_) {}
  }).then((fn) => { unlisten = fn; }).catch(() => {});
  return () => {
    try { if (typeof unlisten === 'function') unlisten(); } catch (_) {}
  };
}

function tauriInvoke(channel, payload) {
  const invoke = tauriApi().core && tauriApi().core.invoke;
  if (typeof invoke !== 'function') {
    return Promise.resolve({ ok: false, error: 'Tauri bridge is unavailable.' });
  }
  return invoke(channel, payload || {});
}

/**
 * Tauri command arguments deserialize strictly: an i64/u32/usize field rejects
 * string values ("12345") outright, which used to break joining people (the
 * user id arrives from a data-* attribute, always a string). Coerce the common
 * numeric fields once, here, so no call site can regress this again.
 */
function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function invokeWithNumbers(channel, numericKeys, payload) {
  const out = Object.assign({}, payload);
  for (const key of numericKeys) {
    if (key in out) out[key] = coerceNumber(out[key]);
  }
  return tauriInvoke(channel, out);
}

function currentWindow() {
  const windowApi = tauriApi().window;
  try { return windowApi && typeof windowApi.getCurrentWindow === 'function' ? windowApi.getCurrentWindow() : null; }
  catch (_) { return null; }
}

async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, text: String(text || '') };
  } catch (err) {
    return { ok: false, text: '', error: (err && err.message) || 'Clipboard access was denied.' };
  }
}

function windowCall(method) {
  const appWindow = currentWindow();
  if (!appWindow || typeof appWindow[method] !== 'function') return Promise.resolve(false);
  return Promise.resolve(appWindow[method]()).then(() => true).catch(() => false);
}

window.fleet = {
  status: () => tauriInvoke('app_status'),
  detect: () => tauriInvoke('roblox_detect'),
  ui: {
    clipboard: readClipboard,
    window: {
      minimize: () => windowCall('minimize'),
      toggleMaximize: () => windowCall('toggleMaximize'),
      close: () => windowCall('close'),
      startDragging: () => windowCall('startDragging'),
      isMaximized: async () => {
        const appWindow = currentWindow();
        try { return !!(appWindow && await appWindow.isMaximized()); } catch (_) { return false; }
      },
      onResized: (cb) => {
        const appWindow = currentWindow();
        if (!appWindow || typeof appWindow.onResized !== 'function') return Promise.resolve(() => {});
        return appWindow.onResized(cb).catch(() => () => {});
      },
    },
  },
  updater: {
    status: () => tauriInvoke('updater_status'),
    check: () => tauriInvoke('updater_check'),
    install: () => tauriInvoke('updater_install'),
  },
  launch: {
    quick: (count) => invokeWithNumbers('launch_quick', ['count'], { count }),
    accounts: (accountIds, placeId) => tauriInvoke('launch_accounts', { accountIds, placeId }),
    join: (accountIds, placeId, gameId) => tauriInvoke('launch_join', { accountIds, placeId, gameId }),
    joinPerson: (accountId, targetUserId) => invokeWithNumbers('launch_join_person', ['targetUserId'], { accountId, targetUserId }),
    joinPersonMulti: (accountIds, targetUserId) => invokeWithNumbers('launch_join_person_multi', ['targetUserId'], { accountIds, targetUserId }),
  },
  accounts: {
    list: () => tauriInvoke('accounts_list'),
    add: () => tauriInvoke('accounts_add'),
    remove: (id) => tauriInvoke('accounts_remove', { id }),
    refresh: (id, full) => tauriInvoke('accounts_refresh', { id, full }),
    follow: (targetAccountId, followerAccountIds) => tauriInvoke('accounts_follow', { targetAccountId, followerAccountIds }),
  },
  games: {
    browse: () => tauriInvoke('games_browse'),
    search: (query, pageToken) => tauriInvoke('games_search', { query, pageToken }),
    servers: (placeId, cursor) => tauriInvoke('games_servers', { placeId, cursor }),
    scanServers: (placeId, pageLimit) => invokeWithNumbers('games_server_scan', ['pageLimit'], { placeId, pageLimit }),
  },
  people: {
    list: (page, pageSize, force) => invokeWithNumbers('people_list', ['page', 'pageSize'], { page, pageSize, force }),
    search: (query, cursor) => tauriInvoke('people_search', { query, cursor }),
    profile: (userId) => invokeWithNumbers('people_profile', ['userId'], { userId }),
    presence: (userIds) => tauriInvoke('people_presence', { userIds: (userIds || []).map(coerceNumber).filter(n => n !== null) }),
  },
  instances: {
    get: () => tauriInvoke('instances_get'),
    focus: (pid) => invokeWithNumbers('instance_focus', ['pid'], { pid }),
    kill: (pid) => invokeWithNumbers('instance_kill', ['pid'], { pid }),
    restart: (pid) => invokeWithNumbers('instance_restart', ['pid'], { pid }),
    killAll: () => tauriInvoke('instances_kill_all'),
    cleanup: () => tauriInvoke('instances_cleanup'),
    arrange: () => tauriInvoke('instances_arrange'),
  },
  playtime: {
    stats: () => tauriInvoke('playtime_stats'),
    clear: () => tauriInvoke('playtime_clear'),
  },
  history: {
    get: () => tauriInvoke('history_get'),
    clear: () => tauriInvoke('history_clear'),
  },
  settings: {
    get: () => tauriInvoke('settings_get'),
    save: (partial) => tauriInvoke('settings_save', { partial }),
    reset: () => tauriInvoke('settings_reset'),
    browse: () => tauriInvoke('settings_browse'),
  },
  logs: {
    get: (limit) => invokeWithNumbers('logs_get', ['limit'], { limit }),
    clear: () => tauriInvoke('logs_clear'),
    openFolder: () => tauriInvoke('logs_open_folder'),
  },
  diag: () => tauriInvoke('diag_get'),
  openExternal: (url) => tauriInvoke('app_open_external', { url }),
  openUserData: () => tauriInvoke('app_open_user_data'),
  onInstances: (cb) => wrapEvent('instances:update', cb),
  onLog: (cb) => wrapEvent('log:entry', cb),
  onAccountUpdate: (cb) => wrapEvent('account:update', cb),
  onAccountExpired: (cb) => wrapEvent('account:expired', cb),
  onAccountAdded: (cb) => wrapEvent('account:added', cb),
  onUpdaterStatus: (cb) => wrapEvent('updater:status', cb),
};
