'use strict';

/**
 * Public Roblox people data. This module deliberately has no write endpoints
 * and never returns an account cookie to the renderer.
 */

const accounts = require('./accounts');
const native = require('./native');
const processes = require('./processes');
const path = require('path');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');

const OFFSETS = Object.freeze({
  FakeDataModel: 0x7c3d2e8,
  FakeDataModelToDataModel: 0x1d0,
  DataModel: {
    Workspace: 0x160,
  },
  Instance: {
    ChildrenStart: 0x70,
    ChildrenEnd: 0x8,
    ChildStride: 8,
    Name: 0x98,
    Parent: 0x50,
    ClassDescriptor: 0,
    ClassName: 0x8,
  },
  Player: {
    DisplayName: 0x138,
    LocalPlayer: 0x130,
    ModelInstance: 0x298,
    Team: 0x2b0,
    UserId: 0x2f0,
  },
  Humanoid: {
    Health: 0x188,
    MaxHealth: 0x18c,
    DirectFloat: true,
  },
  Misc: {
    Value: 0xc8,
  },
  String: {
    Length: 0x10,
    Value: 0xb8,
  },
});

const BACKUP_OFFSETS = Object.freeze({
  FakeDataModel: 0x74f6758,
  FakeDataModelToDataModel: 0x1d0,
  DataModel: {
    Workspace: 0x160,
  },
  Instance: {
    ChildrenStart: 0x78,
    ChildrenEnd: 0x8,
    ChildStride: 16,
    Name: 0xb0,
    Parent: 0x70,
    ClassDescriptor: 0x18,
    ClassName: 0x8,
  },
  Player: {
    DisplayName: 0x130,
    LocalPlayer: 0x138,
    ModelInstance: 0x3a8,
    Team: 0x2b0,
    UserId: 0x2d8,
  },
  Humanoid: {
    Health: 0x194,
    MaxHealth: 0x1b4,
  },
  Misc: {
    Value: 0xd0,
  },
  String: {
    Length: 0x10,
    Value: 0xb8,
  },
});

const SERVER_OFFSET_PROFILES = Object.freeze([
  Object.assign({ name: 'fleet-current' }, OFFSETS),
  Object.assign({ name: 'backup-4-copy' }, BACKUP_OFFSETS),
]);

const CACHE_TTL = 2 * 60 * 1000;
const FRIENDS_TTL = 5 * 60 * 1000;
const SEARCH_TTL = 5 * 60 * 1000;
const SEARCH_MIN_INTERVAL_MS = 750;
const SERVER_SCAN_TIMEOUT_MS = 3000;
const SERVER_SCAN_PID_LIMIT = 4;
const SERVER_SCAN_READ_LIMIT = 12000;
const SERVER_SCAN_CHILD_LIMIT = 512;
const cache = new Map();
const searchCache = new Map();
const searchInFlight = new Map();
let friendsCache = { at: 0, list: [] };
let searchQueue = Promise.resolve();
let lastKeywordSearchAt = 0;
const searchSessionId = randomUUID();
let logger = { info() {}, warn() {}, error() {} };

function configure(opts) {
  if (opts && opts.logger) logger = opts.logger;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));

function rememberSearch(key, value) {
  // Bound memory for long-running Fleet sessions.
  while (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { at: Date.now(), value });
}

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 2000);
}

function u64(buf, off) {
  if (!buf || off < 0 || off + 8 > buf.length) return 0;
  return Number(buf.readBigUInt64LE(off));
}

function u32(buf, off) {
  if (!buf || off < 0 || off + 4 > buf.length) return 0;
  return buf.readUInt32LE(off);
}

function createScanBudget(options) {
  const opts = options || {};
  return {
    startedAt: Date.now(),
    timeoutMs: Math.max(250, Number(opts.timeoutMs) || SERVER_SCAN_TIMEOUT_MS),
    maxReads: Math.max(100, Number(opts.maxReads) || SERVER_SCAN_READ_LIMIT),
    childLimit: Math.max(16, Number(opts.childLimit) || SERVER_SCAN_CHILD_LIMIT),
    reads: 0,
    timedOut: false,
    offsets: opts.offsets || OFFSETS,
  };
}

function scanExpired(ctx) {
  if (!ctx) return false;
  if (ctx.reads >= ctx.maxReads || Date.now() - ctx.startedAt > ctx.timeoutMs) {
    ctx.timedOut = true;
    return true;
  }
  return false;
}

function readPtr(pid, addr, ctx) {
  if (scanExpired(ctx)) return 0;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 8);
  return b && b.length >= 8 ? Number(b.readBigUInt64LE(0)) : 0;
}

function readU32(pid, addr, ctx) {
  if (scanExpired(ctx)) return 0;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 4);
  return b && b.length >= 4 ? b.readUInt32LE(0) : 0;
}

function readU64Big(pid, addr, ctx) {
  if (scanExpired(ctx)) return 0n;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 8);
  return b && b.length >= 8 ? b.readBigUInt64LE(0) : 0n;
}

function readDouble(pid, addr, ctx) {
  if (scanExpired(ctx)) return NaN;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 8);
  return b && b.length >= 8 ? b.readDoubleLE(0) : NaN;
}

function readFloat(pid, addr, ctx) {
  if (scanExpired(ctx)) return NaN;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 4);
  return b && b.length >= 4 ? b.readFloatLE(0) : NaN;
}

function readI64(pid, addr, ctx) {
  if (scanExpired(ctx)) return 0;
  if (ctx) ctx.reads++;
  const b = native.readMemory(pid, addr, 8);
  return b && b.length >= 8 ? Number(b.readBigInt64LE(0)) : 0;
}

function printableAscii(value) {
  const s = String(value || '').replace(/\u0000+$/, '').trim();
  if (!s || s.length > 512) return '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return '';
  }
  return s;
}

function plausibleUsername(value) {
  return /^[A-Za-z0-9_]{3,32}$/.test(String(value || '').trim());
}

function plausibleDisplayName(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 64 || /[\u0000-\u001f]/.test(s)) return false;
  return !/[-]/.test(s);
}

function plausibleRobloxUserId(value) {
  const id = numericId(value);
  return id && id <= 100000000000 ? id : null;
}

function readCString(pid, addr, max, ctx) {
  if (!addr || scanExpired(ctx)) return '';
  if (ctx) ctx.reads++;
  const raw = native.readMemory(pid, addr, Math.max(1, Math.min(max || 256, 1024)));
  if (!raw || !raw.length) return '';
  const end = raw.indexOf(0);
  return printableAscii(raw.subarray(0, end >= 0 ? end : raw.length).toString('utf8'));
}

function readStdString(pid, addr, ctx) {
  if (!addr || scanExpired(ctx)) return '';
  if (ctx) ctx.reads++;
  const raw = native.readMemory(pid, addr, 32);
  if (!raw || raw.length < 32) return '';
  const length = Number(raw.readBigUInt64LE(16));
  const capacity = Number(raw.readBigUInt64LE(24));
  if (!Number.isFinite(length) || length <= 0 || length > 512 || capacity < length) return '';
  if (length < 16) return printableAscii(raw.subarray(0, length).toString('utf8'));
  const ptr = Number(raw.readBigUInt64LE(0));
  return readCString(pid, ptr, length + 1, ctx);
}

function readLegacyStringObject(pid, ptr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  if (!ptr) return '';
  const directStd = readStdString(pid, ptr, ctx);
  if (directStd) return directStd;
  const valuePtr = readPtr(pid, ptr + offsets.String.Value, ctx);
  const len = readU32(pid, ptr + offsets.String.Length, ctx);
  if (valuePtr && len > 0 && len < 512) {
    if (scanExpired(ctx)) return '';
    if (ctx) ctx.reads++;
    const raw = native.readMemory(pid, valuePtr, len);
    if (raw && raw.length) {
      const utf16 = raw.toString('utf16le').replace(/\u0000+$/, '');
      if (utf16) return utf16;
      const ascii = raw.toString('utf8').replace(/\u0000+$/, '');
      if (ascii) return ascii;
    }
  }
  if (scanExpired(ctx)) return '';
  if (ctx) ctx.reads++;
  const inline = native.readMemory(pid, ptr + offsets.String.Value, 128);
  if (!inline) return '';
  const utf16 = inline.toString('utf16le').replace(/\u0000+$/, '');
  if (utf16) return utf16;
  return inline.toString('utf8').replace(/\u0000+$/, '');
}

function readStringObject(pid, ptr, ctx) {
  if (!ptr) return '';
  const direct = readLegacyStringObject(pid, ptr, ctx);
  if (direct) return direct;
  const nested = readPtr(pid, ptr, ctx);
  if (!nested) return '';
  const nestedValue = readLegacyStringObject(pid, nested, ctx);
  if (nestedValue) return nestedValue;
  return readCString(pid, nested, 128, ctx);
}

function readInstanceName(pid, instancePtr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  return cleanText(readStringObject(pid, readPtr(pid, instancePtr + offsets.Instance.Name, ctx), ctx), 128);
}

function readInstanceClass(pid, instancePtr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  if (!offsets.Instance.ClassDescriptor) return '';
  const descriptor = readPtr(pid, instancePtr + offsets.Instance.ClassDescriptor, ctx);
  if (!descriptor) return '';
  return cleanText(readStringObject(pid, readPtr(pid, descriptor + offsets.Instance.ClassName, ctx), ctx), 128);
}

function readChildren(pid, instancePtr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  const vec = readPtr(pid, instancePtr + offsets.Instance.ChildrenStart, ctx);
  if (!vec) return [];
  const start = readPtr(pid, vec, ctx);
  const end = readPtr(pid, vec + offsets.Instance.ChildrenEnd, ctx);
  if (!start || !end || end <= start) return [];
  if (end - start > 0x10000) return [];
  const stride = offsets.Instance.ChildStride || 8;
  const count = Math.min(ctx && ctx.childLimit || SERVER_SCAN_CHILD_LIMIT, Math.floor((end - start) / stride));
  const children = [];
  for (let i = 0; i < count; i++) {
    if (scanExpired(ctx)) break;
    const child = readPtr(pid, start + i * stride, ctx);
    if (child) children.push(child);
  }
  return children;
}

function findFirstChildByName(pid, instancePtr, name, ctx) {
  const wanted = String(name || '');
  if (!instancePtr || !wanted) return 0;
  for (const child of readChildren(pid, instancePtr, ctx)) {
    if (scanExpired(ctx)) break;
    if (readInstanceName(pid, child, ctx) === wanted) return child;
  }
  return 0;
}

function findFirstChildByClass(pid, instancePtr, className, ctx) {
  const wanted = String(className || '');
  if (!instancePtr || !wanted) return 0;
  for (const child of readChildren(pid, instancePtr, ctx)) {
    if (scanExpired(ctx)) break;
    const klass = readInstanceClass(pid, child, ctx);
    if (klass === wanted) return child;
    if (!klass && readInstanceName(pid, child, ctx) === wanted) return child;
  }
  return 0;
}

function plausibleStatNumber(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100000) return null;
  return value === 0 || value >= 0.01 ? value : null;
}

function readEncodedFloat(pid, ownerPtr, offset, ctx) {
  if (!ownerPtr || !offset) return null;
  const encoded = readU64Big(pid, ownerPtr + offset, ctx);
  if (!encoded) return null;
  const ptr = Number(encoded);
  if (!Number.isSafeInteger(ptr) || ptr <= 0) return null;
  const key = readU64Big(pid, ptr, ctx);
  if (!key) return null;
  const raw = Buffer.allocUnsafe(8);
  raw.writeBigUInt64LE(encoded ^ key, 0);
  return plausibleStatNumber(raw.readFloatLE(0));
}

function readValueObjectNumber(pid, valuePtr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  if (!valuePtr || !offsets.Misc || !offsets.Misc.Value) return null;
  const asDouble = plausibleStatNumber(readDouble(pid, valuePtr + offsets.Misc.Value, ctx));
  if (asDouble !== null) return asDouble;
  const encoded = readEncodedFloat(pid, valuePtr, offsets.Misc.Value, ctx);
  if (encoded !== null) return encoded;
  return null;
}

function readPlayerStats(pid, playerPtr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  const stats = {};
  if (offsets.Player && offsets.Player.Team) {
    const teamPtr = readPtr(pid, playerPtr + offsets.Player.Team, ctx);
    const team = teamPtr ? readInstanceName(pid, teamPtr, ctx) : '';
    if (team && plausibleDisplayName(team)) stats.team = cleanText(team, 64);
  }
  const character = offsets.Player && offsets.Player.ModelInstance
    ? readPtr(pid, playerPtr + offsets.Player.ModelInstance, ctx)
    : 0;
  if (character) {
    const humanoid = findFirstChildByClass(pid, character, 'Humanoid', ctx);
    if (humanoid && offsets.Humanoid) {
      const health = offsets.Humanoid.DirectFloat
        ? plausibleStatNumber(readFloat(pid, humanoid + offsets.Humanoid.Health, ctx))
        : readEncodedFloat(pid, humanoid, offsets.Humanoid.Health, ctx);
      const maxHealth = offsets.Humanoid.DirectFloat
        ? plausibleStatNumber(readFloat(pid, humanoid + offsets.Humanoid.MaxHealth, ctx))
        : readEncodedFloat(pid, humanoid, offsets.Humanoid.MaxHealth, ctx);
      if (health !== null) stats.health = health;
      if (maxHealth !== null) stats.maxHealth = maxHealth;
    }
    if (stats.health == null || stats.maxHealth == null) {
      const healthValue = findFirstChildByName(pid, character, 'Health', ctx);
      if (healthValue) {
        if (stats.health == null) {
          const health = readValueObjectNumber(pid, healthValue, ctx);
          if (health !== null) stats.health = health;
        }
        if (stats.maxHealth == null) {
          const maxHealthValue = findFirstChildByName(pid, healthValue, 'MaxHealth', ctx);
          const maxHealth = readValueObjectNumber(pid, maxHealthValue, ctx);
          if (maxHealth !== null) stats.maxHealth = maxHealth;
        }
      }
    }
  }
  return stats;
}

function readAncestorChain(pid, instancePtr, limit, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  const out = [];
  let cur = instancePtr;
  for (let i = 0; i < (limit || 32) && cur; i++) {
    if (scanExpired(ctx)) break;
    out.push(cur);
    const parent = readPtr(pid, cur + offsets.Instance.Parent, ctx);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return out;
}

function looksLikePlayer(pid, ptr, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  if (!ptr) return false;
  const klass = readInstanceClass(pid, ptr, ctx);
  if (klass && klass !== 'Player') return false;
  const userId = readI64(pid, ptr + offsets.Player.UserId, ctx) || readU32(pid, ptr + offsets.Player.UserId, ctx);
  const display = readStringObject(pid, ptr + offsets.Player.DisplayName, ctx);
  const modelPtr = readPtr(pid, ptr + offsets.Player.ModelInstance, ctx);
  return !!(userId || display || modelPtr || klass === 'Player');
}

function pickRobloxProcess(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const sorted = rows.slice().sort((a, b) => (b.memBytes || 0) - (a.memBytes || 0));
  return sorted.find(r => Number(r && r.pid)) || null;
}

function locatePlayersService(pid, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  const base = native.moduleBaseOf(pid, 'RobloxPlayerBeta.exe');
  if (!base) return null;
  const fake = readPtr(pid, base + offsets.FakeDataModel, ctx);
  if (!fake) return null;
  const dataModel = readPtr(pid, fake + offsets.FakeDataModelToDataModel, ctx) || fake;
  if (!dataModel) return null;
  const rootChildren = readChildren(pid, dataModel, ctx);
  for (const child of rootChildren) {
    if (scanExpired(ctx)) return null;
    const klass = readInstanceClass(pid, child, ctx);
    if (klass === 'Players') return child;
    const name = readInstanceName(pid, child, ctx);
    if (name === 'Players') return child;
  }
  return null;
}

function locatePlayersServiceDeep(pid, options) {
  const ctx = options && options.startedAt ? options : createScanBudget(options);
  const offsets = ctx && ctx.offsets || OFFSETS;
  const root = locatePlayersService(pid, ctx);
  if (root) return root;
  const base = native.moduleBaseOf(pid, 'RobloxPlayerBeta.exe');
  if (!base) return null;
  const fake = readPtr(pid, base + offsets.FakeDataModel, ctx);
  if (!fake) return null;
  const dataModel = readPtr(pid, fake + offsets.FakeDataModelToDataModel, ctx) || fake;
  if (!dataModel) return null;
  const stack = [dataModel];
  const seen = new Set();
  while (stack.length) {
    if (scanExpired(ctx)) return null;
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const klass = readInstanceClass(pid, node, ctx);
    if (klass === 'Players') return node;
    const name = readInstanceName(pid, node, ctx);
    if (name === 'Players') return node;
    const children = readChildren(pid, node, ctx);
    for (const child of children) stack.push(child);
  }
  return null;
}

function readServerPlayersFromPid(pid, options) {
  const profiles = (options && options.offsets) ? [options.offsets] : SERVER_OFFSET_PROFILES;
  let lastError = 'Could not locate the Roblox Players service in memory.';
  let best = null;
  for (const offsets of profiles) {
    const ctx = createScanBudget(Object.assign({}, options || {}, { offsets }));
    const result = readServerPlayersFromPidWithOffsets(pid, ctx);
    if (result && result.ok) {
      if (!best || result.people.length > best.people.length) best = result;
      continue;
    }
    lastError = result && result.error ? result.error : lastError;
    if (ctx.timedOut && !best) return result;
  }
  if (best) return best;
  return { ok: false, error: lastError };
}

function readServerPlayersFromPidWithOffsets(pid, ctx) {
  const offsets = ctx && ctx.offsets || OFFSETS;
  const playersService = locatePlayersService(pid, ctx);
  if (ctx.timedOut) return { ok: false, error: 'Server player inspection timed out.' };
  if (!playersService) return { ok: false, error: 'Could not locate the Roblox Players service in memory.' };
  const children = readChildren(pid, playersService, ctx);
  const seen = new Set();
  const people = [];
  for (const child of children) {
    if (scanExpired(ctx)) return { ok: false, error: 'Server player inspection timed out.' };
    if (!looksLikePlayer(pid, child, ctx)) continue;
    const rawUserId = readI64(pid, child + offsets.Player.UserId, ctx) || readU32(pid, child + offsets.Player.UserId, ctx);
    const userId = plausibleRobloxUserId(rawUserId);
    const username = readInstanceName(pid, child, ctx);
    if (userId && seen.has(userId)) continue;
    if (!userId || !plausibleUsername(username)) continue;
    seen.add(userId);
    const displayName = cleanText(readStringObject(pid, child + offsets.Player.DisplayName, ctx) || username, 64);
    if (!plausibleDisplayName(displayName)) continue;
    if (!username && !displayName) continue;
    const stats = readPlayerStats(pid, child, ctx);
    people.push({
      userId,
      username: username || displayName || 'Unknown',
      displayName: displayName || username || 'Unknown',
      presence: 'In game',
      lastOnline: null,
      game: null,
      canJoin: false,
      avatar: null,
      connectedAccounts: [],
      stats,
      team: stats.team || null,
      health: stats.health == null ? null : stats.health,
      maxHealth: stats.maxHealth == null ? null : stats.maxHealth,
    });
  }
  return {
    ok: true,
    people,
    total: people.length,
    updatedAt: new Date().toISOString(),
    source: 'memory',
    note: `Detected from Roblox player objects in memory (${offsets.name || 'offset profile'}).`,
    scannedPid: pid,
  };
}

function numericId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function getJson(url, options) {
  const key = (options && options.cacheKey) || null;
  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, Object.assign({}, options && options.fetch, { signal: controller.signal }));
    if (!res.ok) return null;
    const value = await res.json();
    if (key) cache.set(key, { at: Date.now(), value });
    return value;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch JSON while preserving HTTP/error metadata (used by resilient search). */
async function getJsonResult(url, fetchOptions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, Object.assign({}, fetchOptions || {}, { signal: controller.signal }));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    const retryHeader = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    return {
      ok: res.ok,
      status: res.status,
      data,
      retryAfterMs: Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : null,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, data: null, retryAfterMs: null, error: (err && err.message) || 'Network error' };
  } finally {
    clearTimeout(timer);
  }
}

function queueKeywordSearch(task) {
  const run = searchQueue.then(task, task);
  searchQueue = run.catch(() => {});
  return run;
}

async function keywordSearch(query, cursor) {
  return queueKeywordSearch(async () => {
    const wait = SEARCH_MIN_INTERVAL_MS - (Date.now() - lastKeywordSearchAt);
    if (wait > 0) await delay(wait);
    const cleanCursor = cleanText(cursor, 500);
    const tagged = /^(omni|legacy):(.*)$/.exec(cleanCursor);
    const source = tagged ? tagged[1] : cleanCursor ? 'omni' : null;
    const pageToken = tagged ? tagged[2] : cleanCursor;
    const publicOptions = {
      headers: {
        Accept: 'application/json',
        Origin: 'https://www.roblox.com',
        Referer: 'https://www.roblox.com/',
        'User-Agent': 'Fleet/1.5.2',
      },
    };

    const request = async (kind) => {
      const params = kind === 'omni'
        ? new URLSearchParams({
          verticalType: 'user', searchQuery: query, pageToken,
          globalSessionId: searchSessionId, sessionId: searchSessionId,
        })
        : new URLSearchParams({ keyword: query, limit: '10', ...(pageToken ? { cursor: pageToken } : {}) });
      const url = kind === 'omni'
        ? `https://apis.roblox.com/search-api/omni-search?${params}`
        : `https://users.roblox.com/v1/users/search?${params}`;
      lastKeywordSearchAt = Date.now();
      let result = await getJsonResult(url, publicOptions);
      if (result.status === 429) {
        const retryMs = Math.min(3000, Math.max(700, result.retryAfterMs || 1000));
        logger.warn('People search rate-limited; retrying once', `${query} in ${retryMs}ms`);
        await delay(retryMs);
        lastKeywordSearchAt = Date.now();
        result = await getJsonResult(url, publicOptions);
      }
      if (!result.ok) return result;
      if (kind === 'legacy') {
        const data = result.data || {};
        return Object.assign({}, result, {
          data: {
            data: Array.isArray(data.data) ? data.data : [],
            nextPageCursor: data.nextPageCursor ? `legacy:${data.nextPageCursor}` : null,
          },
        });
      }
      const data = result.data || {};
      const rows = [];
      for (const group of (Array.isArray(data.searchResults) ? data.searchResults : [])) {
        for (const item of (Array.isArray(group && group.contents) ? group.contents : [])) {
          rows.push({
            id: item.contentId,
            name: item.username,
            displayName: item.displayName,
            previousUsernames: item.previousUsernames || [],
            hasVerifiedBadge: !!item.hasVerifiedBadge,
          });
        }
      }
      return Object.assign({}, result, {
        data: {
          data: rows,
          nextPageCursor: data.nextPageToken ? `omni:${data.nextPageToken}` : null,
        },
      });
    };

    if (source === 'legacy') return request('legacy');
    const omni = await request('omni');
    if (omni.ok || source === 'omni') return omni;
    logger.warn('Current Roblox People search failed; trying legacy broad search', `${query}: ${omni.error}`);
    return request('legacy');
  });
}

async function numericUserLookup(query) {
  if (!/^\d{1,16}$/.test(query)) return null;
  const id = numericId(query);
  if (!id) return null;
  const result = await getJsonResult(`https://users.roblox.com/v1/users/${id}`);
  return result.ok && result.data && result.data.id ? result.data : null;
}

function presenceFromRecord(p) {
  const labels = { 0: 'Offline', 1: 'Online', 2: 'In game', 3: 'In Studio', 4: 'Offline' };
  const type = p && (p.userPresenceType != null ? p.userPresenceType : p.presenceType);
  const status = labels[type] || 'Offline';
  return {
    presence: status,
    lastOnline: p && p.lastOnline || null,
    game: status === 'In game' ? {
      name: cleanText(p.lastLocation || 'In an experience', 160),
      placeId: p.placeId || null,
      rootPlaceId: p.rootPlaceId || null,
      universeId: p.universeId || null,
      gameId: p.gameId || null,
    } : null,
    // Exact server visibility depends on the account used to join. Roblox can
    // say a non-friend is in-game while hiding placeId/gameId until Fleet checks
    // with the account selected for joining, so allow an account-scoped attempt.
    canJoin: status === 'In game',
  };
}

/** Adapt an accounts.js presence record (already status-mapped) to our shape. */
function adaptPresence(rec) {
  const status = (rec && rec.status) || 'Offline';
  return {
    presence: status,
    lastOnline: (rec && rec.lastOnline) || null,
    game: status === 'In game' ? {
      name: cleanText((rec && rec.lastLocation) || 'In an experience', 160),
      placeId: (rec && rec.placeId) || null,
      rootPlaceId: (rec && rec.rootPlaceId) || null,
      universeId: (rec && rec.universeId) || null,
      gameId: (rec && rec.gameId) || null,
    } : null,
    canJoin: status === 'In game',
  };
}

// Presence MUST be authenticated — Roblox only returns a player's game
// (placeId/gameId) to a signed-in caller who can see them. Using a stored
// account session is what makes the Join button appear for in-game players.
async function getPresence(userIds) {
  const ids = userIds.map(numericId).filter(Boolean).slice(0, 100);
  const out = new Map();
  if (!ids.length) return out;
  // Without a session Roblox reveals nothing — report "Unknown" instead of
  // falsely labelling everyone Offline on account-less installs.
  if (!accounts.hasSession()) {
    for (const id of ids) out.set(id, { presence: 'Unknown', lastOnline: null, game: null, canJoin: false });
    return out;
  }
  // Try every stored session: a person may be visible to a secondary account
  // even when the first account sees them as offline or hides their game.
  const authed = await accounts.presenceForIds(ids);
  for (const id of ids) out.set(id, adaptPresence(authed.get(id)));
  return out;
}

async function thumbnails(userIds, endpoint, size) {
  const ids = userIds.map(numericId).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const j = await getJson(`https://thumbnails.roblox.com/v1/users/${endpoint}?userIds=${ids.join(',')}&size=${size}&format=Png&isCircular=false`);
  for (const item of (j && j.data || [])) {
    if (item.imageUrl) out.set(Number(item.targetId), item.imageUrl);
  }
  return out;
}

function baseUser(raw) {
  const id = numericId(raw && (raw.id || raw.userId));
  return {
    userId: id,
    username: cleanText(raw && (raw.name || raw.username) || id, 64),
    displayName: cleanText(raw && (raw.displayName || raw.name || raw.username) || id, 64),
    bio: cleanText(raw && raw.description, 1000),
    created: raw && raw.created || null,
    isBanned: !!(raw && raw.isBanned),
    hasVerifiedBadge: !!(raw && raw.hasVerifiedBadge),
  };
}

async function enrichUsers(users) {
  const ids = users.map(u => numericId(u.userId || u.id)).filter(Boolean);
  const [heads, presences] = await Promise.all([
    thumbnails(ids, 'avatar-headshot', '150x150'),
    getPresence(ids),
  ]);
  return users.map(raw => {
    const u = baseUser(raw);
    const p = presences.get(u.userId) || presenceFromRecord(null);
    return Object.assign(u, p, {
      avatar: heads.get(u.userId) || null,
      placeId: p.game && p.game.placeId || null,
      gameId: p.game && p.game.gameId || null,
      connectedAccounts: Array.isArray(raw.connectedAccounts) ? raw.connectedAccounts : [],
    });
  });
}

async function fetchFriendsFor(account) {
  const j = await getJson(`https://friends.roblox.com/v1/users/${account.userId}/friends`);
  return (j && j.data || []).map(raw => Object.assign(baseUser(raw), {
    connectedAccounts: [{ userId: account.userId, displayName: account.displayName || account.username }],
  }));
}

async function allFriends(force) {
  if (!force && friendsCache.list.length && Date.now() - friendsCache.at < FRIENDS_TTL) return friendsCache.list;
  const saved = accounts.list();
  const ownIds = new Set(saved.map(a => Number(a.userId)));
  const groups = await Promise.all(saved.map(fetchFriendsFor));
  const merged = new Map();
  for (const group of groups) {
    for (const friend of group) {
      if (!friend.userId || ownIds.has(friend.userId)) continue;
      const existing = merged.get(friend.userId);
      if (existing) {
        for (const source of friend.connectedAccounts) {
          if (!existing.connectedAccounts.some(a => Number(a.userId) === Number(source.userId))) existing.connectedAccounts.push(source);
        }
      } else {
        merged.set(friend.userId, friend);
      }
    }
  }
  friendsCache = {
    at: Date.now(),
    list: Array.from(merged.values()).sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
  return friendsCache.list;
}

async function listFriends(page, pageSize, force) {
  if (!accounts.list().length) return { ok: false, error: 'Add an account to load friends.' };
  const size = Math.max(1, Math.min(24, Number(pageSize) || 9));
  const wantedPage = Math.max(0, Number(page) || 0);
  const all = await allFriends(!!force);
  const lastPage = Math.max(0, Math.ceil(all.length / size) - 1);
  const currentPage = Math.min(wantedPage, lastPage);
  const slice = all.slice(currentPage * size, currentPage * size + size);

  // The friends endpoint can omit names, so fetch canonical profile records.
  const profiles = await Promise.all(slice.map(async friend => {
    const raw = await getJson(`https://users.roblox.com/v1/users/${friend.userId}`, { cacheKey: `user:${friend.userId}` });
    return Object.assign({}, friend, raw || {});
  }));
  const people = await enrichUsers(profiles);
  return {
    ok: true,
    people,
    page: currentPage,
    pageSize: size,
    total: all.length,
    hasPrev: currentPage > 0,
    hasNext: (currentPage + 1) * size < all.length,
  };
}

function inspectServerPlayersInWorker(pid) {
  const workerPath = path.join(__dirname, 'people-server-worker.js');
  const options = {
    timeoutMs: SERVER_SCAN_TIMEOUT_MS,
    maxReads: SERVER_SCAN_READ_LIMIT,
    childLimit: SERVER_SCAN_CHILD_LIMIT,
  };
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Server player inspection timed out.' });
      if (worker) worker.terminate().catch(() => {});
    }, SERVER_SCAN_TIMEOUT_MS + 500);
    try {
      worker = new Worker(`require(${JSON.stringify(workerPath)});`, { eval: true, workerData: { pid, options } });
      worker.once('message', finish);
      worker.once('error', err => finish({ ok: false, error: (err && err.message) || 'Server player inspection failed.' }));
      worker.once('exit', code => {
        if (code && !settled) finish({ ok: false, error: 'Server player inspection stopped unexpectedly.' });
      });
    } catch (err) {
      finish({ ok: false, error: (err && err.message) || 'Server player inspection failed to start.' });
    }
  });
}

async function listServerPeople(force) {
  void force;
  if (!native.isAvailable()) {
    return { ok: false, error: 'Native inspection is unavailable.' };
  }
  const rows = await processes.list();
  const ordered = Array.isArray(rows) ? rows.slice().sort((a, b) => (b.memBytes || 0) - (a.memBytes || 0)) : [];
  if (!ordered.length) return { ok: false, error: 'No Roblox client is running.' };
  let lastError = 'Could not read server players from any Roblox client.';
  for (const row of ordered.slice(0, SERVER_SCAN_PID_LIMIT)) {
    const result = await inspectServerPlayersInWorker(row.pid);
    if (result && result.ok) {
      const ids = (result.people || []).map(p => p && p.userId).filter(Boolean);
      try {
        const heads = await thumbnails(ids, 'avatar-headshot', '150x150');
        result.people = (result.people || []).map(p => Object.assign({}, p, {
          avatar: heads.get(Number(p.userId)) || p.avatar || null,
        }));
      } catch (_) {}
      return result;
    }
    lastError = result && result.error ? result.error : lastError;
  }
  return { ok: false, error: lastError };
}

function rankSearchUsers(users, query) {
  const q = query.toLowerCase();
  const seen = new Set();
  return users.filter(user => {
    const id = numericId(user && (user.id || user.userId));
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => {
    const score = user => {
      const name = String(user.name || user.username || '').toLowerCase();
      const display = String(user.displayName || '').toLowerCase();
      if (name === q) return 0;
      if (display === q) return 1;
      if (name.startsWith(q)) return 2;
      if (display.startsWith(q)) return 3;
      return 4;
    };
    return score(a) - score(b);
  });
}

async function performSearch(query, cursor) {
  // A numeric Roblox user ID is unambiguous and avoids the rate-limited search endpoint.
  if (!cursor && /^\d+$/.test(query)) {
    const user = await numericUserLookup(query);
    if (!user) return { ok: true, people: [], nextPageCursor: null, query, source: 'id', notice: 'No user exists with that ID.' };
    return { ok: true, people: await enrichUsers([user]), nextPageCursor: null, query, source: 'id', notice: 'Matched by Roblox user ID.' };
  }

  // Text searches should stay broad: a full username can still have many
  // nearby players, so use Roblox keyword search instead of collapsing to one
  // exact username result.
  const result = await keywordSearch(query, cursor);
  if (result.ok) {
    const raw = rankSearchUsers((result.data && result.data.data) || [], query);
    return {
      ok: true,
      people: await enrichUsers(raw.map(baseUser)),
      nextPageCursor: result.data && result.data.nextPageCursor || null,
      query,
      source: 'keyword',
      notice: null,
    };
  }

  if (result.status === 429) {
    return {
      ok: false,
      error: 'Roblox is temporarily limiting People search. Wait a moment, then retry.',
      retryable: true,
      retryAfterMs: result.retryAfterMs || 3000,
    };
  }

  logger.warn('People search failed', `${query}: ${result.error || 'unknown error'}`);
  return {
    ok: false,
    error: result.status
      ? `Roblox user search failed (HTTP ${result.status}). Try again.`
      : 'Could not reach Roblox user search. Check your connection and retry.',
    retryable: true,
  };
}

async function search(query, cursor) {
  const q = cleanText(query, 50);
  if (q.length < 2) return { ok: false, error: 'Type at least 2 characters.' };
  const cleanCursor = cursor ? cleanText(cursor, 500) : '';
  const key = q.toLowerCase() + '|' + cleanCursor;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL) {
    return Object.assign({}, cached.value, { cached: true });
  }
  if (cached) searchCache.delete(key);
  if (searchInFlight.has(key)) return searchInFlight.get(key);

  const request = performSearch(q, cleanCursor)
    .then(value => {
      if (value && value.ok) rememberSearch(key, value);
      return value;
    })
    .finally(() => searchInFlight.delete(key));
  searchInFlight.set(key, request);
  return request;
}

/** Lightweight live presence refresh for already-rendered cards/profiles. */
async function presence(userIds) {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : [])
    .map(numericId).filter(Boolean))).slice(0, 100);
  if (!ids.length) return { ok: true, people: [] };
  const map = await getPresence(ids);
  return {
    ok: true,
    people: ids.map(userId => Object.assign({ userId }, map.get(userId) || presenceFromRecord(null))),
  };
}

function socialCount(j) {
  return Number(j && j.count) || 0;
}

function normalizeGroups(j) {
  return (j && j.data || []).slice(0, 30).map(item => ({
    id: numericId(item.group && item.group.id),
    name: cleanText(item.group && item.group.name, 100),
    description: cleanText(item.group && item.group.description, 300),
    memberCount: Number(item.group && item.group.memberCount) || 0,
    role: cleanText(item.role && item.role.name, 100),
    rank: Number(item.role && item.role.rank) || 0,
    isPrimary: !!item.isPrimaryGroup,
  }));
}

function normalizeGames(j) {
  return (j && j.data || []).slice(0, 12).map(game => ({
    id: numericId(game.id),
    name: cleanText(game.name, 120),
    description: cleanText(game.description, 300),
    creatorName: cleanText(game.creator && game.creator.name, 100),
    rootPlaceId: numericId(game.rootPlace && game.rootPlace.id),
    visits: Number(game.placeVisits) || 0,
    created: game.created || null,
    updated: game.updated || null,
    thumbnail: null,
  }));
}

async function addGameIcons(games) {
  const ids = games.map(g => g.id).filter(Boolean);
  if (!ids.length) return games;
  const j = await getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`);
  const icons = new Map((j && j.data || []).map(item => [Number(item.targetId), item.imageUrl || null]));
  return games.map(game => Object.assign(game, { thumbnail: icons.get(game.id) || null }));
}

async function profile(userId) {
  const id = numericId(userId);
  if (!id) return { ok: false, error: 'Invalid Roblox user.' };
  const core = await getJson(`https://users.roblox.com/v1/users/${id}`, { cacheKey: `user:${id}` });
  if (!core || !core.id) return { ok: false, error: 'That Roblox user could not be found.' };

  const endpoints = await Promise.all([
    getJson(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    getJson(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    getJson(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    getJson(`https://users.roblox.com/v1/users/${id}/username-history?limit=10&sortOrder=Desc`),
    getJson(`https://groups.roblox.com/v1/users/${id}/groups/roles`),
    getJson(`https://accountinformation.roblox.com/v1/users/${id}/roblox-badges`),
    getJson(`https://avatar.roblox.com/v1/users/${id}/avatar`),
    getJson(`https://avatar.roblox.com/v1/users/${id}/currently-wearing`),
    getJson(`https://games.roblox.com/v2/users/${id}/games?accessFilter=Public&limit=10&sortOrder=Desc`),
    getJson(`https://games.roblox.com/v2/users/${id}/favorite/games?accessFilter=Public&limit=10&sortOrder=Desc`),
    getJson(`https://inventory.roblox.com/v1/users/${id}/can-view-inventory`),
    getPresence([id]),
    thumbnails([id], 'avatar-headshot', '150x150'),
    thumbnails([id], 'avatar', '420x420'),
  ]);

  const [friendCount, followerCount, followingCount, history, groups, badges, avatar, wearing,
    createdRaw, favoritesRaw, inventoryAccess, presenceMap, heads, bodies] = endpoints;
  const canViewInventory = !!(inventoryAccess && inventoryAccess.canView);
  const collectiblesRaw = canViewInventory
    ? await getJson(`https://inventory.roblox.com/v1/users/${id}/assets/collectibles?limit=10&sortOrder=Desc`)
    : null;
  const createdGames = await addGameIcons(normalizeGames(createdRaw));
  const favoriteGames = await addGameIcons(normalizeGames(favoritesRaw));
  const p = presenceMap.get(id) || presenceFromRecord(null);

  let connectedAccounts = [];
  if (accounts.list().length) {
    const friend = (await allFriends(false)).find(item => item.userId === id);
    connectedAccounts = friend ? friend.connectedAccounts : [];
  }

  return {
    ok: true,
    profile: Object.assign(baseUser(core), p, {
      avatar: heads.get(id) || null,
      fullBodyAvatar: bodies.get(id) || null,
      profileUrl: `https://www.roblox.com/users/${id}/profile`,
      connectedAccounts,
      counts: {
        friends: socialCount(friendCount),
        followers: socialCount(followerCount),
        following: socialCount(followingCount),
      },
      previousUsernames: (history && history.data || []).slice(0, 10).map(item => cleanText(item.name, 64)).filter(Boolean),
      groups: normalizeGroups(groups),
      robloxBadges: (Array.isArray(badges) ? badges : badges && badges.data || []).slice(0, 20).map(badge => ({
        id: numericId(badge.id), name: cleanText(badge.name, 100), description: cleanText(badge.description, 300), imageUrl: badge.imageUrl || null,
      })),
      avatarDetails: avatar ? {
        avatarType: cleanText(avatar.playerAvatarType, 40),
        bodyColors: avatar.bodyColors || null,
        scales: avatar.scales || null,
        assets: (avatar.assets || []).slice(0, 30).map(asset => ({
          id: numericId(asset.id), name: cleanText(asset.name, 100), assetType: cleanText(asset.assetType && asset.assetType.name, 60),
        })),
      } : null,
      wearingAssetIds: (wearing && wearing.assetIds || []).map(numericId).filter(Boolean).slice(0, 50),
      createdGames,
      favoriteGames,
      inventory: {
        canView: canViewInventory,
        collectibles: (collectiblesRaw && collectiblesRaw.data || []).slice(0, 10).map(item => ({
          assetId: numericId(item.assetId), name: cleanText(item.name, 120), assetType: cleanText(item.assetType, 60),
          originalPrice: Number(item.originalPrice) || null, recentAveragePrice: Number(item.recentAveragePrice) || null,
        })),
      },
      availability: {
        groups: groups !== null,
        robloxBadges: badges !== null,
        avatar: avatar !== null,
        createdGames: createdRaw !== null,
        favoriteGames: favoritesRaw !== null,
        inventory: inventoryAccess !== null,
      },
    }),
  };
}

module.exports = {
  configure,
  listFriends,
  listServerPeople,
  search,
  profile,
  presence,
  // Pure helpers exported for focused tests.
  numericId,
  baseUser,
  presenceFromRecord,
  rankSearchUsers,
  normalizeGroups,
  normalizeGames,
  __test: {
    readStringObject,
    readPtr,
    readChildren,
    readInstanceName,
    readInstanceClass,
    readAncestorChain,
    looksLikePlayer,
    locatePlayersServiceDeep,
    findFirstChildByClass,
    readPlayerStats,
    readServerPlayersFromPid,
    OFFSETS,
    BACKUP_OFFSETS,
  },
};
