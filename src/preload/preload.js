'use strict';

/**
 * preload.js — the only bridge between the (isolated, node-free) renderer and
 * the main process. Exposes a small, explicit `window.fleet` API; the renderer
 * can reach nothing else.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

function subscribe(channel, cb) {
  const handler = (_evt, data) => { try { cb(data); } catch (_) {} };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('fleet', {
  status: () => invoke('app:status'),
  detect: () => invoke('roblox:detect'),

  launch: {
    quick: (count) => invoke('launch:quick', { count }),
    accounts: (accountIds, placeId) => invoke('launch:accounts', { accountIds, placeId }),
    join: (accountIds, placeId, gameId) => invoke('launch:join', { accountIds, placeId, gameId }),
    joinPerson: (accountId, targetUserId) => invoke('launch:join-person', { accountId, targetUserId }),
    joinPersonMulti: (accountIds, targetUserId) => invoke('launch:join-person-multi', { accountIds, targetUserId }),
  },

  accounts: {
    list: () => invoke('accounts:list'),
    add: () => invoke('accounts:add'),
    remove: (id) => invoke('accounts:remove', { id }),
    refresh: (id, full) => invoke('accounts:refresh', { id, full }),
    follow: (targetAccountId, followerAccountIds) => invoke('accounts:follow', { targetAccountId, followerAccountIds }),
  },

  games: {
    browse: () => invoke('games:browse'),
    search: (query, pageToken) => invoke('games:search', { query, pageToken }),
    servers: (placeId, cursor) => invoke('games:servers', { placeId, cursor }),
  },

  people: {
    list: (page, pageSize, force) => invoke('people:list', { page, pageSize, force }),
    search: (query, cursor) => invoke('people:search', { query, cursor }),
    profile: (userId) => invoke('people:profile', { userId }),
  },

  instances: {
    get: () => invoke('instances:get'),
    focus: (pid) => invoke('instance:focus', { pid }),
    kill: (pid) => invoke('instance:kill', { pid }),
    restart: (pid) => invoke('instance:restart', { pid }),
    killAll: () => invoke('instances:killAll'),
    cleanup: () => invoke('instances:cleanup'),
    arrange: () => invoke('instances:arrange'),
  },

  history: {
    get: () => invoke('history:get'),
    clear: () => invoke('history:clear'),
  },

  settings: {
    get: () => invoke('settings:get'),
    save: (partial) => invoke('settings:save', { partial }),
    reset: () => invoke('settings:reset'),
    browse: () => invoke('settings:browse'),
  },

  logs: {
    get: (limit) => invoke('logs:get', { limit }),
    clear: () => invoke('logs:clear'),
    openFolder: () => invoke('logs:openFolder'),
  },

  diag: () => invoke('diag:get'),
  openExternal: (url) => invoke('app:openExternal', { url }),
  openUserData: () => invoke('app:openUserData'),

  onInstances: (cb) => subscribe('instances:update', cb),
  onLog: (cb) => subscribe('log:entry', cb),
  onAccountUpdate: (cb) => subscribe('account:update', cb),
  onAccountExpired: (cb) => subscribe('account:expired', cb),
  onAccountAdded: (cb) => subscribe('account:added', cb),
});
