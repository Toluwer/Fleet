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
const games = require('../src/main/games');
const updater = require('../src/main/updater');
const rendererModel = require('../src/renderer/model');

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
  const personFollowLink = accounts.buildFollowUserLaunchUrl('test-ticket', 8216975346);
  const personFollowLauncher = decodeURIComponent((personFollowLink.match(/placelauncherurl:([^+]+)/) || [])[1] || '');
  check('non-friend join uses Roblox follow-user request', personFollowLauncher.includes('request=RequestFollowUser'));
  check('non-friend join carries the target user id', personFollowLauncher.includes('userId=8216975346'));
  check('invalid follow-user id is rejected', accounts.buildFollowUserLaunchUrl('test-ticket', 'bad&id') === null);

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
  const hiddenPlacePresence = people.presenceFromRecord({ userPresenceType: 2, lastLocation: 'In an experience' });
  check('in-game privacy-hidden presence still offers a Join attempt',
    hiddenPlacePresence.presence === 'In game'
    && hiddenPlacePresence.canJoin === true
    && hiddenPlacePresence.game.placeId === null);
  const normalizedGroups = people.normalizeGroups({ data: [{ group: { id: 7, name: 'Fleet', memberCount: 10 }, role: { name: 'Member', rank: 1 } }] });
  check('group roles are normalized', normalizedGroups.length === 1 && normalizedGroups[0].name === 'Fleet' && normalizedGroups[0].role === 'Member');
  const listServerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'people.js'), 'utf8');
  check('server player reader uses Roblox memory offsets',
    listServerSource.includes('FakeDataModel: 0x7c3d2e8')
    && listServerSource.includes('readServerPlayersFromPid')
    && listServerSource.includes('locatePlayersService')
    && listServerSource.includes('locatePlayersServiceDeep')
    && /looksLikePlayer\(pid, child(?:, ctx)?\)/.test(listServerSource));

  const nativeState = {
    isAvailable: native.isAvailable,
    moduleBaseOf: native.moduleBaseOf,
    readMemory: native.readMemory,
  };
  const pid = 4242;
  const base = 0x10000000;
  const addrs = new Map();
  const write = (addr, buf) => {
    for (let i = 0; i < buf.length; i++) addrs.set(addr + i, buf[i]);
  };
  const writePtr = (addr, value) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value), 0);
    write(addr, buf);
  };
  const writeU32 = (addr, value) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    write(addr, buf);
  };
  const writeStr = (addr, text) => {
    const buf = Buffer.from(String(text), 'utf16le');
    write(addr, buf);
  };
  const readMemory = (readPid, address, size) => {
    if (readPid !== pid) return null;
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      const byte = addrs.get(address + i);
      if (byte == null) return null;
      out[i] = byte;
    }
    return out;
  };
  try {
    native.isAvailable = () => true;
    native.moduleBaseOf = (readPid) => (readPid === pid ? base : 0);
    native.readMemory = readMemory;

    const offsets = people.__test.OFFSETS;
    const fakeDmPtr = 0x20000000;
    const dataModelPtr = 0x20001000;
    const playersServicePtr = 0x20002000;
    const playerPtr = 0x20003000;
    const childrenVecDm = 0x20004000;
    const childrenVecPlayers = 0x20005000;
    const dmChildrenArr = 0x20006000;
    const playersChildrenArr = 0x20007000;
    const nameObj = 0x20008000;
    const nameValue = 0x20009000;
    const playersNameObj = 0x20009500;
    const playersNameValue = 0x20009600;
    const displayObj = 0x2000a000;
    const displayValue = 0x2000b000;

    writePtr(base + offsets.FakeDataModel, fakeDmPtr);
    writePtr(fakeDmPtr + 0x1d0, dataModelPtr);
    writePtr(dataModelPtr + offsets.Instance.ChildrenStart, childrenVecDm);
    writePtr(childrenVecDm, dmChildrenArr);
    writePtr(childrenVecDm + offsets.Instance.ChildrenEnd, dmChildrenArr + 8);
    writePtr(dmChildrenArr, playersServicePtr);
    writePtr(playersServicePtr + offsets.Instance.Name, playersNameObj);
    writeU32(playersNameObj + offsets.String.Length, 14);
    writePtr(playersNameObj + offsets.String.Value, playersNameValue);
    writeStr(playersNameValue, 'Players');
    writePtr(playersServicePtr + offsets.Instance.ChildrenStart, childrenVecPlayers);
    writePtr(childrenVecPlayers, playersChildrenArr);
    writePtr(childrenVecPlayers + offsets.Instance.ChildrenEnd, playersChildrenArr + 8);
    writePtr(playersChildrenArr, playerPtr);

    writePtr(playerPtr + offsets.Instance.Name, nameObj);
    writeU32(nameObj + offsets.String.Length, 8);
    writePtr(nameObj + offsets.String.Value, nameValue);
    writeStr(nameValue, 'Alex');
    writePtr(playerPtr + offsets.Player.DisplayName, displayObj);
    writeU32(displayObj + offsets.String.Length, 16);
    writePtr(displayObj + offsets.String.Value, displayValue);
    writeStr(displayValue, 'Player A');
    writeU32(playerPtr + offsets.Player.UserId, 1234567);

    const mocked = people.__test.readServerPlayersFromPid(pid);
    check('mocked server walk returns detected player',
      mocked.ok
      && mocked.people.length === 1
      && mocked.people[0].username === 'Alex'
      && mocked.people[0].displayName === 'Player A'
      && mocked.people[0].userId === 1234567);
  } finally {
    native.isAvailable = nativeState.isAvailable;
    native.moduleBaseOf = nativeState.moduleBaseOf;
    native.readMemory = nativeState.readMemory;
  }

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const gamesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'games.js'), 'utf8');
  check('People Join opens an account picker', rendererSource.includes("case 'join-person': openPersonJoinDialog") && rendererSource.includes('data-action="select-join-account"'));
  check('People Join resolves the selected accounts together', rendererSource.includes('api.launch.joinPersonMulti(ids, join.userId)'));
  check('Join buttons carry the target user id', (rendererSource.match(/data-user="\$\{esc\(u\.userId\)\}"/g) || []).length >= 2);
  check('friend/search cards and profile view expose join actions',
    rendererSource.includes('function personJoinButton(u, className)')
    && rendererSource.includes('data-action="join-person"')
    && rendererSource.includes('personCardActions(u)')
    && rendererSource.includes('profileHeroActions(u)'));
  check('People Join dialog can open before a place id is visible',
    rendererSource.includes('if (!userId)')
    && !rendererSource.includes('if (!userId || !placeId)'));
  check('visible people presence refreshes automatically',
    rendererSource.includes('setInterval(refreshVisiblePeoplePresence, 10000)')
    && rendererSource.includes('api.people.presence(ids)'));
  const presenceRefreshStart = rendererSource.indexOf('async function refreshVisiblePeoplePresence()');
  const presenceRefreshEnd = rendererSource.indexOf('\nfunction peopleStat', presenceRefreshStart);
  const presenceRefreshSource = rendererSource.slice(presenceRefreshStart, presenceRefreshEnd);
  check('people presence patches only the changed person without refreshing the page',
    presenceRefreshSource.includes('presenceChanged(user, next)')
    && presenceRefreshSource.includes('patchPersonPresence(next)')
    && !presenceRefreshSource.includes('renderPeopleSearchResults()')
    && !presenceRefreshSource.includes('renderPeopleGrid()')
    && !presenceRefreshSource.includes('renderPeopleProfile()'));
  check('People has live filters, sorting and copy-user tools',
    rendererSource.includes("case 'people-filter':")
    && rendererSource.includes("case 'people-sort':")
    && rendererSource.includes("case 'copy-user-id':"));
  check('People includes a Server subtab with its own search and refresh flow',
    rendererSource.includes("data-action=\"people-tab\" data-tab=\"server\"")
    && rendererSource.includes('function renderServerPage()')
    && rendererSource.includes('function runServerSearch(query)')
    && rendererSource.includes("case 'server-search':")
    && rendererSource.includes("case 'server-refresh':"));
  check('Server subtab uses a dedicated backend list path',
    fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8').includes('serverList: (force) => invoke(\'people:server-list\'')
    && fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8').includes("safe('people:server-list'")
    && fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'people.js'), 'utf8').includes('async function listServerPeople(force)'));
  check('Games has advanced sorting, filtering and server ranking',
    rendererSource.includes("case 'games-sort':")
    && rendererSource.includes("case 'games-hide-empty':")
    && rendererSource.includes("case 'games-category':")
    && rendererSource.includes("case 'server-sort':")
    && rendererSource.includes('function sortedServers(list, mode)'));
  check('Games category filter defaults to All and is data-driven',
    rendererSource.includes('function renderGamesCategories()')
    && rendererSource.includes("category: 'All'")
    && gamesSource.includes('categories') && gamesSource.includes('sortDisplayName'));
  check('Server browser offers distinct advanced sort modes',
    ["'best'", "'ping'", "'space'", "'players'", "'fps'"].every(m => rendererSource.includes(m))
    && rendererSource.includes('function serverStats(')
    && rendererSource.includes('SERVER_SORTS'));
  check('Server Intelligence exposes deep scans, multi-filters, quality and live refresh',
    rendererSource.includes('function deepScanServers(')
    && rendererSource.includes('function filteredServers(')
    && rendererSource.includes('function serverQuality(')
    && rendererSource.includes("case 'servers-auto-refresh':")
    && rendererSource.includes('api.games.scanServers'));
  check('Games search keeps relevance order and ranks close matches first',
    rendererSource.includes('function matchScore(')
    && rendererSource.includes('function normName(')
    && rendererSource.includes('if (g.query) {'));
  check('Games search is live (debounced) as you type',
    rendererSource.includes("inp.addEventListener('input'")
    && rendererSource.includes('clearTimeout(debounce)'));
  const nshSource = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  check('Installer is a fully custom card (no wizard chrome)',
    nshSource.includes('customWelcomePage')
    && nshSource.includes('FleetSkinWindow')
    && nshSource.includes('CreateRoundRectRgn')
    && nshSource.includes('customFinishPage')
    && nshSource.includes('ExecShellAsUser'));
  check('Installer detects installed version and states it',
    nshSource.includes('DisplayVersion')
    && nshSource.includes('You already have Fleet installed!')
    && nshSource.includes('Update detected')
    && nshSource.includes('DwmSetWindowAttribute')
    && nshSource.includes('IntOp $8 $4 + 52')
    && nshSource.includes('i r4, i r8, i r5, i 8, i 0x34)'));
  const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  check('Dark and light themes exist and sync the native titlebar',
    cssSource.includes(':root[data-theme="dark"]')
    && cssSource.includes('--on-ink')
    && rendererSource.includes('function applyTheme()')
    && rendererSource.includes("case 'set-theme':")
    && mainSource.includes("ipcMain.handle('ui:titlebar'")
    && preloadSource.includes("invoke('ui:titlebar'"));
  check('Sessions save and relaunch full setups',
    rendererSource.includes('function loadSessions()')
    && rendererSource.includes("case 'session-launch':")
    && rendererSource.includes("case 'session-save-confirm':")
    && rendererSource.includes('api.instances.arrange()'));
  const exactServerId = '12345678-abcd-4abc-8abc-1234567890ab';
  const gameUrlTarget = rendererModel.parseRobloxTarget(`https://www.roblox.com/games/987654/Test?gameInstanceId=${exactServerId}`);
  const protocolTarget = rendererModel.parseRobloxTarget(`roblox-player:1+placelauncherurl:https%3A%2F%2Fassetgame.roblox.com%2Fgame%2FPlaceLauncher.ashx%3FplaceId%3D24680%26gameId%3D${exactServerId}`);
  check('Smart Launch parses game URLs and exact servers',
    gameUrlTarget.placeId === '987654'
    && gameUrlTarget.gameId === exactServerId
    && protocolTarget.placeId === '24680'
    && protocolTarget.gameId === exactServerId
    && rendererSource.includes('api.launch.join(ids, target.placeId, target.gameId)'));
  check('Smart Launch rejects share-code-only and malformed links',
    rendererModel.parseRobloxTarget('https://www.roblox.com/share?code=not-a-place&type=ExperienceDetails').invalid === true
    && rendererModel.parseRobloxTarget('not a Roblox target').invalid === true
    && rendererModel.parseRobloxTarget('').invalid === false);
  const peopleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'people.js'), 'utf8');
  check('Account-less installs are told what to do instead of failing',
    peopleSource.includes('needsAccount: true')
    && peopleSource.includes("presence: 'Unknown'")
    && rendererSource.includes('Sign in once to unlock search')
    && rendererSource.includes('Add a Roblox account to unlock People')
    && rendererSource.includes("case 'goto-accounts':"));
  check('Games have favorites and recent-joins',
    rendererSource.includes('function toggleFav(')
    && rendererSource.includes('function recordRecentGame(')
    && rendererSource.includes("case 'toggle-fav':")
    && rendererSource.includes("'__fav'") && rendererSource.includes("'__recent'"));
  check('Clipboard quick-join offers copied game links locally',
    mainSource.includes("ipcMain.handle('ui:clipboard'")
    && preloadSource.includes("invoke('ui:clipboard')")
    && rendererSource.includes('function checkClipboardForGameLink(')
    && rendererSource.includes("case 'clip-use':"));
  check('Progress page centers by resizing the inner dialog to the card',
    nshSource.includes('stretch it first')
    && nshSource.includes('MoveWindow(i r0, i 0, i 0, i r2, i r3, i 1)'));
  check('Keep-alive auto-rejoins crashed clients with cooldown and strike-out',
    rendererSource.includes('function maybeKeepAlive(')
    && rendererSource.includes('KEEPALIVE_COOLDOWN_MS')
    && rendererSource.includes('t.fails >= 3')
    && rendererSource.includes('everInGame')
    && rendererSource.includes("case 'keepalive-off':")
    && rendererSource.includes('session.keepAlive && session.placeId'));
  const accountsSrcEarly = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'accounts.js'), 'utf8');
  check('Login window spoofs a clean Chrome UA and surfaces load errors',
    accountsSrcEarly.includes('LOGIN_UA')
    && accountsSrcEarly.includes('setUserAgent(LOGIN_UA)')
    && accountsSrcEarly.includes("did-fail-load"));

  // ---- Playtime analytics (module-level behavioural test) ----
  const playtimeMod = require(path.join(__dirname, '..', 'src', 'main', 'playtime.js'));
  const ptFile = {};
  playtimeMod.configure({ store: { readJson: (n, f) => ptFile[n] || f, writeJson: (n, d) => { ptFile[n] = d; } } });
  playtimeMod.clear();
  playtimeMod.observe(111, 'alt1', 'In game', { name: 'Farm Sim', placeId: 42 });
  // simulate 2 minutes passing by rewinding the active session's clock
  const nowStats = playtimeMod.stats();
  check('playtime tracks a live session immediately', nowStats.ok && nowStats.tracking === 1 && nowStats.perGame[0] && nowStats.perGame[0].label === 'Farm Sim' && nowStats.perGame[0].live === true);
  playtimeMod.observe(111, 'alt1', 'Offline', null); // <30s => blip, discarded
  const afterBlip = playtimeMod.stats();
  check('sub-30s presence blips are not recorded as sessions', afterBlip.tracking === 0 && afterBlip.totals.sessions === 0);
  check('playtime is wired into the poller, IPC and UI',
    accountsSrcEarly.includes('onObserve(a.userId, a.username, pres.status, game)')
    && fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8').includes("safe('playtime:stats'")
    && rendererSource.includes('views.stats')
    && rendererSource.includes('function fmtDur('));
  check('accounts carry Robux + Premium data',
    accountsSrcEarly.includes('economy.roblox.com/v1/user/currency')
    && accountsSrcEarly.includes('validate-membership')
    && accountsSrcEarly.includes('ECONOMY_TTL_MS')
    && rendererSource.includes('data-acct-robux')
    && rendererSource.includes('robux-total'));
  check('game card actions wrap instead of clipping',
    cssSource.includes('.game-actions { display: flex; flex-wrap: wrap;'));
  const normalizedSessions = rendererModel.normalizeSessions([
    { id: 'good', name: '  Night run  ', accountIds: ['a', 'a', 2], placeId: '123', gameId: exactServerId, arrange: true },
    { id: 'broken', accountIds: 'not-an-array', placeId: 'bad' },
    null,
  ]);
  check('Saved sessions are normalized before rendering',
    normalizedSessions.length === 1
    && normalizedSessions[0].name === 'Night run'
    && normalizedSessions[0].accountIds.join(',') === 'a,2'
    && normalizedSessions[0].gameId === exactServerId
    && normalizedSessions[0].arrange === true);
  check('Theme preferences reject corrupt local values',
    rendererModel.normalizeThemePreference('DARK') === 'dark'
    && rendererModel.normalizeThemePreference('unknown') === 'system');
  const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
  check('player join no longer requires presence-visible server ids',
    ipcSource.includes('getPersonJoinLaunchInfo(accountIds[i], targetUserId)')
    && ipcSource.includes('return doLaunch({ accountIds, targetUserId });'));

  check('startup has a splash recovery watchdog', mainSource.includes('Startup watchdog revealed the main window'));
  check('startup never opens an account sign-in window automatically',
    mainSource.includes('waiting for explicit sign-in')
    && !mainSource.includes('Promise.resolve(accounts.add())'));
  const accountsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'accounts.js'), 'utf8');
  check('expired accounts stay saved until the user explicitly signs in again',
    accountsSource.includes('sessionExpired: !!a.sessionExpired')
    && !accountsSource.includes('const remaining = readRaw().filter(x => x.id !== a.id)'));
  check('renderer API calls time out instead of hanging boot', rendererSource.includes('Promise.race([work, timeout])'));
  check('interactive account sign-in is not cut off by the normal API timeout',
    (rendererSource.match(/api\.accounts\.add\(\), undefined, 0/g) || []).length === 2
    && rendererSource.includes('if (!(limit > 0)) return await work;'));

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  check('Windows installer is configured for GitHub auto-update',
    manifest.dependencies['electron-updater']
    && manifest.build.publish.provider === 'github'
    && manifest.build.win.target.some(target => target.target === 'nsis'));
  check('official installer keeps the permanent FleetInstaller.exe name',
    manifest.build.artifactName === 'FleetInstaller.${ext}'
    && manifest.build.nsis.runAfterFinish === false);

  await section('Server intelligence and updater safety');
  const mockResponse = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  try {
    global.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.get('sortOrder') === 'Asc') {
        return mockResponse(200, { data: [{ id: 'quiet', playing: 1, maxPlayers: 28, ping: 8, fps: 60 }], nextPageCursor: null });
      }
      return mockResponse(200, { data: [{ id: 'busy', playing: 27, maxPlayers: 28, ping: 60, fps: 58 }], nextPageCursor: null });
    };
    const rankedPool = await games.servers('4924922222');
    check('Most Players receives busy joinable servers, not only the emptiest page',
      rankedPool.ok && rankedPool.servers.some(s => s.id === 'busy' && s.playing === 27));

    let fallbackPages = 0;
    global.fetch = async (url) => {
      const u = new URL(String(url));
      const exclude = u.searchParams.get('excludeFullGames');
      const cursor = u.searchParams.get('cursor');
      if (exclude === 'true') return mockResponse(200, { data: [], nextPageCursor: null });
      fallbackPages++;
      if (!cursor) return mockResponse(200, { data: [{ id: 'full', playing: 28, maxPlayers: 28 }], nextPageCursor: 'page-two' });
      return mockResponse(200, { data: [{ id: 'busy-fallback', playing: 25, maxPlayers: 28, ping: 75, fps: 55 }], nextPageCursor: null });
    };
    const fallbackPool = await games.scanServers('4924922222', 4);
    check('Deep scan walks past full Roblox pages when joinable filtering returns empty',
      fallbackPool.ok && fallbackPool.servers.some(s => s.id === 'busy-fallback') && fallbackPages === 2);
  } finally {
    global.fetch = originalFetch;
  }

  const rawUpdateError = '404 method: GET url: https://github.com/Toluwer/Fleet/releases.atom Headers: { "set-cookie": "secret-marker" }';
  const safeUpdateError = updater.updaterErrorMessage(rawUpdateError);
  check('Updater errors are concise and never expose headers or cookies',
    /HTTP 404/.test(safeUpdateError) && !/headers|cookie|secret-marker/i.test(safeUpdateError));

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
      if (href.includes('/presence/users')) {
        return response(200, { userPresences: [{ userId: 24680, userPresenceType: 2, lastLocation: 'In an experience' }] });
      }
      throw new Error('Unexpected search URL: ' + href + ' ' + ((opts && opts.method) || 'GET'));
    };
    const fullUsernameResult = await people.search('Exact_User');
    const cachedFullUsername = await people.search('Exact_User');
    check('full username searches use keyword results instead of exact-only matches',
      fullUsernameResult.ok
      && fullUsernameResult.source === 'keyword'
      && fullUsernameResult.people.length === 2
      && fullUsernameResult.people[0].canJoin === true
      && fullUsernameResult.people[0].placeId === null
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
