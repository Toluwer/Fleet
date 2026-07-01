'use strict';

/**
 * selftest.js — headless functional test of Fleet's service layer.
 *
 *   node test/selftest.js            (safe: no clients launched, no kills)
 *   FLEET_LIVE=1 node test/selftest.js   (also launches + cleans up 1 client)
 *
 * The service modules are pure Node (koffi works outside Electron too), so the
 * whole core can be exercised without spinning up the UI.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const roblox = require('../src/main/roblox');
const native = require('../src/main/native');
const store = require('../src/main/store');
const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const accounts = require('../src/main/accounts');
const people = require('../src/main/people');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, info) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, info: info || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${info ? '  — ' + info : ''}`);
}
async function section(title) { console.log('\n=== ' + title + ' ==='); }

(async function run() {
  console.log('Fleet self-test  (' + new Date().toISOString() + ')');
  console.log('Live mode:', process.env.FLEET_LIVE === '1' ? 'ON' : 'off');

  /* 1. Roblox detection */
  await section('Roblox detection');
  const loc = roblox.locate({ autoDetect: true });
  check('locate() returns a result object', loc && typeof loc === 'object');
  check('Roblox player found', loc.found, loc.playerPath || 'not found');
  check('detected path passes validatePath', loc.found ? roblox.validatePath(loc.playerPath) : true, 'source=' + loc.source);
  check('invalid path rejected', roblox.validatePath('C:\\nope\\fake.exe') === false);

  /* 2. Native multi-instance layer */
  await section('Native multi-instance layer (koffi)');
  check('native.init() succeeds', native.init(), native.getLoadError() || '');
  const idx = native.getTypeIndices();
  check('Event type index resolved', idx && idx.event != null, JSON.stringify(idx));
  check('Mutant type index resolved', idx && idx.mutant != null, JSON.stringify(idx));
  check('guard names present', native.EVENT_NAME === 'ROBLOX_singletonEvent' && native.MUTEX_NAME === 'ROBLOX_singletonMutex');
  const mtx = native.exeMutexName('C:\\X\\RobloxPlayerBeta.exe');
  check('exeMutexName derives per-path mutex', mtx === 'C:_X_RobloxPlayerBeta.exe.mtx', mtx);
  const closeEmpty = native.closeRobloxSingletonHandles([]);
  check('close with no PIDs is a safe no-op', closeEmpty.ok && closeEmpty.closed === 0);
  check('blockerExists returns a boolean', typeof native.blockerExists(loc.playerPath) === 'boolean');
  const focusBogus = native.focusByPid(99999999);
  check('focusByPid(bogus) returns gracefully', focusBogus && focusBogus.ok === false, focusBogus.reason);

  /* 3. Store: settings */
  await section('Store — settings');
  const tmp = path.join(os.tmpdir(), 'fleet-selftest-' + Date.now());
  store.configure(tmp, console);
  const def = store.getSettings();
  check('defaults load', def && def.pollIntervalMs === 2000);
  const clamped = store.saveSettings({ pollIntervalMs: 999999, launchDelayMs: -50 });
  check('pollInterval clamped to <=10000', clamped.pollIntervalMs === 10000, 'got ' + clamped.pollIntervalMs);
  check('launchDelay clamped to >=0', clamped.launchDelayMs === 0, 'got ' + clamped.launchDelayMs);
  const reset = store.resetSettings();
  check('reset restores defaults', reset.pollIntervalMs === 2000);

  /* 4. Store: profiles + validation */
  await section('Store — profiles & validation');
  const badName = store.validateProfile({ name: '', launchMode: 'client' });
  check('empty name rejected', !badName.ok && badName.errors.length > 0);
  const badLink = store.validateProfile({ name: 'X', launchMode: 'deeplink', deeplink: 'ftp://nope' });
  check('bad deeplink rejected', !badLink.ok);
  const goodLink = store.validateProfile({ name: 'X', launchMode: 'deeplink', deeplink: 'roblox-player:1+launchmode:play' });
  check('valid deeplink accepted', goodLink.ok);
  const saved = store.saveProfile({ name: 'Test profile', launchMode: 'client', count: 3, notes: 'hi' });
  check('saveProfile ok', saved.ok && saved.profile.id);
  check('count persisted', saved.profile.count === 3);
  let profs = store.getProfiles();
  check('profile retrievable', profs.length === 1 && profs[0].name === 'Test profile');
  profs = store.deleteProfile(saved.profile.id);
  check('profile deleted', profs.length === 0);

  /* 5. Store: history */
  await section('Store — history');
  store.addHistory({ profileName: 'T', mode: 'client', result: 'launched', pid: 123 });
  check('history entry added', store.getHistory().length === 1);
  check('history cleared', store.clearHistory().length === 0);

  /* 6. Process enumeration */
  await section('Process monitor');
  const list = await processes.list();
  check('processes.list() returns array', Array.isArray(list), list.length + ' running');
  const shapeOk = list.every(r => typeof r.pid === 'number' && 'memBytes' in r && 'status' in r && 'windowTitle' in r);
  check('each row has expected shape', shapeOk);

  /* 7. Launcher guards */
  await section('Launcher');
  const badLaunch = launcher.launchInstance({ playerPath: 'C:\\nope\\fake.exe', mode: 'client' });
  check('launch with bad path fails cleanly', badLaunch.ok === false, badLaunch.reason);
  const badDeep = launcher.launchInstance({ mode: 'deeplink', deeplink: '' });
  check('empty deeplink fails cleanly', badDeep.ok === false);

  /* 8. Account follow links + presence resolution */
  await section('Account follow');
  const jobId = '12345678-abcd-4abc-8abc-1234567890ab';
  const followLink = accounts.buildLaunchUrl('test-ticket', '123456789', jobId);
  const placeLauncher = decodeURIComponent((followLink.match(/placelauncherurl:([^+]+)/) || [])[1] || '');
  check('follow launch requests exact server job', placeLauncher.includes('request=RequestGameJob'));
  check('follow launch includes place id', placeLauncher.includes('placeId=123456789'));
  check('follow launch includes game instance id', placeLauncher.includes('gameId=' + jobId));
  check('invalid server id is rejected', accounts.buildLaunchUrl('test-ticket', '123456789', 'bad&id') === null);

  const accountId = 'follow-target';
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify([{
    id: accountId,
    userId: 987654321,
    username: 'TargetAccount',
    displayName: 'Target Account',
    cookie: 'b64:' + Buffer.from('test-cookie').toString('base64'),
    addedAt: new Date().toISOString(),
  }]), 'utf8');
  accounts.configure({ baseDir: tmp, safeStorage: { isEncryptionAvailable: () => false }, logger: console });
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ userPresences: [{ userPresenceType: 2, placeId: 123456789, gameId: jobId }] }),
    });
    const followContext = await accounts.getFollowContext(accountId);
    check('in-game account resolves follow context', followContext.ok === true);
    check('follow context keeps exact server', followContext.gameInstanceId === jobId && followContext.placeId === '123456789');
    const personJoinContext = await accounts.getPersonJoinContext(accountId, 8216975346);
    check('chosen account resolves another player exact server', personJoinContext.ok && personJoinContext.gameInstanceId === jobId);

    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ userPresences: [{ userPresenceType: 2, placeId: 123456789 }] }),
    });
    const privateContext = await accounts.getPersonJoinContext(accountId, 8216975346);
    check('privacy-hidden server is rejected after account choice', privateContext.ok === false && /private|privacy/i.test(privateContext.reason));

    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ userPresences: [{ userPresenceType: 1 }] }),
    });
    const offlineContext = await accounts.getFollowContext(accountId);
    check('non-playing target is rejected cleanly', offlineContext.ok === false && /not currently in a game/i.test(offlineContext.reason));
  } finally {
    global.fetch = originalFetch;
  }

  /* 9. Public people data normalization */
  await section('People profiles');
  check('people rejects unsafe user ids', people.numericId('nope') === null && people.numericId(-2) === null);
  check('people accepts numeric Roblox user ids', people.numericId('12345') === 12345);
  const normalizedUser = people.baseUser({ id: 42, name: 'builderman', displayName: 'Builderman', description: 'Hello', hasVerifiedBadge: true });
  check('public profile fields are normalized', normalizedUser.userId === 42 && normalizedUser.bio === 'Hello' && normalizedUser.hasVerifiedBadge);
  const normalizedPresence = people.presenceFromRecord({ userPresenceType: 2, lastLocation: 'Test Game', placeId: 99, gameId: jobId });
  check('in-game presence keeps join context', normalizedPresence.canJoin && normalizedPresence.game.placeId === 99 && normalizedPresence.game.gameId === jobId);
  const onlinePresence = people.presenceFromRecord({ userPresenceType: 1 });
  check('online but non-playing users are not joinable', onlinePresence.presence === 'Online' && onlinePresence.canJoin === false);
  const hiddenServerPresence = people.presenceFromRecord({ userPresenceType: 2, placeId: 99 });
  check('in-game public presence still offers account-scoped Join', hiddenServerPresence.presence === 'In game' && hiddenServerPresence.canJoin === true);
  const normalizedGroups = people.normalizeGroups({ data: [{ group: { id: 7, name: 'Fleet', memberCount: 10 }, role: { name: 'Member', rank: 1 } }] });
  check('group roles are normalized', normalizedGroups.length === 1 && normalizedGroups[0].name === 'Fleet' && normalizedGroups[0].role === 'Member');

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  check('People Join opens an account picker', rendererSource.includes("case 'join-person': openPersonJoinDialog") && rendererSource.includes('data-action="select-join-account"'));
  check('People Join resolves the selected accounts together', rendererSource.includes('api.launch.joinPersonMulti(ids, join.userId)'));
  check('Join buttons carry the target user id', (rendererSource.match(/data-user="\$\{esc\(u\.userId\)\}"/g) || []).length >= 2);
  check('friend/search cards and profile view expose join actions', (rendererSource.match(/data-action="join-person"/g) || []).length >= 2);

  await section('Resilient people search');
  const response = (status, data, headers) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (headers && headers[String(name).toLowerCase()]) || null },
    json: async () => data,
  });
  let keywordCallsForFullUsername = 0;
  let exactEndpointTouched = false;
  try {
    global.fetch = async (url, opts) => {
      const href = String(url);
      if (href.includes('/v1/usernames/users')) {
        exactEndpointTouched = true;
        return response(200, { data: [{ id: 24680, name: 'Exact_User', displayName: 'Exact User' }] });
      }
      if (href.includes('/v1/users/search')) {
        keywordCallsForFullUsername++;
        return response(200, {
          data: [
            { id: 24680, name: 'Exact_User', displayName: 'Exact User' },
            { id: 24681, name: 'Exact_UserFan', displayName: 'Exact User Fan' },
          ],
          nextPageCursor: 'more-exact-users',
        });
      }
      if (href.includes('/avatar-headshot')) return response(200, { data: [] });
      if (href.includes('/presence/users')) return response(200, { userPresences: [] });
      throw new Error('Unexpected search URL: ' + href + ' ' + ((opts && opts.method) || 'GET'));
    };
    const fullUsernameResult = await people.search('Exact_User');
    const cachedFullUsername = await people.search('Exact_User');
    check('full username searches use keyword results instead of exact-only matches',
      fullUsernameResult.ok
      && fullUsernameResult.source === 'keyword'
      && fullUsernameResult.people.length === 2
      && fullUsernameResult.nextPageCursor === 'more-exact-users'
      && keywordCallsForFullUsername === 1
      && exactEndpointTouched === false);
    check('identical searches reuse cached results', cachedFullUsername.ok && cachedFullUsername.cached === true && keywordCallsForFullUsername === 1);

    let keywordCalls = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/v1/users/search')) {
        keywordCalls++;
        if (keywordCalls === 1) return response(429, { errors: [{ code: 0, message: '' }] });
        return response(200, { data: [{ id: 13579, name: 'DisplayUser', displayName: 'Display Name' }], nextPageCursor: null });
      }
      if (href.includes('/avatar-headshot')) return response(200, { data: [] });
      if (href.includes('/presence/users')) return response(200, { userPresences: [] });
      throw new Error('Unexpected retry URL: ' + href);
    };
    const retryResult = await people.search('Display Name');
    check('keyword search recovers from one HTTP 429', retryResult.ok && retryResult.people[0].userId === 13579 && keywordCalls === 2);

    let keywordTouched = false;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/v1/users/97531')) return response(200, { id: 97531, name: 'IdUser', displayName: 'ID User' });
      if (href.includes('/v1/users/search')) { keywordTouched = true; return response(500, {}); }
      if (href.includes('/avatar-headshot')) return response(200, { data: [] });
      if (href.includes('/presence/users')) return response(200, { userPresences: [] });
      throw new Error('Unexpected ID URL: ' + href);
    };
    const idResult = await people.search('97531');
    check('numeric user ID lookup avoids keyword search', idResult.ok && idResult.source === 'id' && !keywordTouched);
  } finally {
    global.fetch = originalFetch;
  }

  /* 10. Live launch (opt-in) */
  if (process.env.FLEET_LIVE === '1' && loc.found) {
    await section('LIVE launch + detect + cleanup');
    const before = (await processes.list()).map(r => r.pid);
    const r = launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' });
    check('launchInstance ok', r.ok, 'pid ' + r.pid);
    await new Promise(res => setTimeout(res, 9000));
    const after = await processes.list();
    const found = after.find(p => !before.includes(p.pid));
    check('new client visible in monitor', !!found, found ? 'pid ' + found.pid : 'not detected');
    if (r.pid) {
      const k = await processes.kill(r.pid, true);
      check('launched client cleaned up', k.ok, k.output);
    }
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n----------------------------------------`);
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('Self-test crashed:', err);
  process.exit(2);
});
