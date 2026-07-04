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

window.fleet = {
  status: () => tauriInvoke('app_status'),
  detect: () => tauriInvoke('roblox_detect'),
  ui: {
    titlebar: (dark) => tauriInvoke('ui_titlebar', { dark }),
    clipboard: () => tauriInvoke('ui_clipboard'),
  },
  updater: {
    status: () => tauriInvoke('updater_status'),
    check: () => tauriInvoke('updater_check'),
    install: () => tauriInvoke('updater_install'),
  },
  launch: {
    quick: (count) => tauriInvoke('launch_quick', { count }),
    accounts: (accountIds, placeId) => tauriInvoke('launch_accounts', { accountIds, placeId }),
    join: (accountIds, placeId, gameId) => tauriInvoke('launch_join', { accountIds, placeId, gameId }),
    joinPerson: (accountId, targetUserId) => tauriInvoke('launch_join_person', { accountId, targetUserId }),
    joinPersonMulti: (accountIds, targetUserId) => tauriInvoke('launch_join_person_multi', { accountIds, targetUserId }),
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
    scanServers: (placeId, pageLimit) => tauriInvoke('games_server_scan', { placeId, pageLimit }),
  },
  people: {
    list: (page, pageSize, force) => tauriInvoke('people_list', { page, pageSize, force }),
    serverList: (force) => tauriInvoke('people_server_list', { force }),
    search: (query, cursor) => tauriInvoke('people_search', { query, cursor }),
    profile: (userId) => tauriInvoke('people_profile', { userId }),
    presence: (userIds) => tauriInvoke('people_presence', { userIds }),
  },
  instances: {
    get: () => tauriInvoke('instances_get'),
    focus: (pid) => tauriInvoke('instance_focus', { pid }),
    kill: (pid) => tauriInvoke('instance_kill', { pid }),
    restart: (pid) => tauriInvoke('instance_restart', { pid }),
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
    get: (limit) => tauriInvoke('logs_get', { limit }),
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
