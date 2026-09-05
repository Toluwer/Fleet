'use strict';

/**
 * selftest.js — headless functional test of Fleet's service layer.
 *
 *   node test/selftest.js            (safe: no clients launched, no kills)
 *   FLEET_LIVE=1 node test/selftest.js   (also launches + cleans up 1 client)
 *
 * The service modules are pure Node (koffi works outside the desktop shell too), so the
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
const rendererModel = require('../src/renderer/model');
const { ProcessMonitor } = require('../src/main/monitor');

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
  check('Roblox player found when live mode is enabled', loc.found || process.env.FLEET_LIVE !== '1', loc.playerPath || 'not found');
  check('detected path passes validatePath', loc.found ? roblox.validatePath(loc.playerPath) : true, 'source=' + loc.source);
  check('invalid path rejected', roblox.validatePath('C:\\nope\\fake.exe') === false);
  const fakeRobloxDir = path.join(os.tmpdir(), 'fleet-selftest-roblox-' + Date.now(), 'version-test');
  fs.mkdirSync(fakeRobloxDir, { recursive: true });
  const fakeRobloxExe = path.join(fakeRobloxDir, 'RobloxPlayerBeta.exe');
  fs.writeFileSync(fakeRobloxExe, '');
  process.env.FLEET_TEST_ROBLOX_DIR = fakeRobloxDir;
  check('manual Roblox path accepts quoted executable paths',
    roblox.validatePath('"' + fakeRobloxExe + '"')
    && roblox.locate({ autoDetect: false, robloxPath: '"' + fakeRobloxExe + '"' }).found);
  check('manual Roblox path accepts a selected version folder',
    roblox.validatePath(fakeRobloxDir)
    && roblox.locate({ autoDetect: false, robloxPath: fakeRobloxDir }).playerPath === fakeRobloxExe);
  check('manual Roblox path accepts environment-variable paths',
    roblox.validatePath('%FLEET_TEST_ROBLOX_DIR%\\RobloxPlayerBeta.exe'));
  check('manual Roblox path extracts executable from command lines',
    roblox.locate({ autoDetect: false, robloxPath: '"' + fakeRobloxExe + '" --app --args' }).playerPath === fakeRobloxExe);

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
  let mockRows = [{ pid: 4101, memBytes: 10, status: 'running', windowTitle: 'Roblox', executablePath: 'C:\\Users\\Test\\AppData\\Local\\Roblox\\Versions\\version-a\\RobloxPlayerBeta.exe', verifiedPath: true, trustedInstall: true }];
  const monitor = new ProcessMonitor({ processProvider: { list: async () => mockRows }, intervalMs: 1000 });
  await monitor.poll();
  check('external Roblox requires a stable second verified sighting', monitor.snapshot().length === 0);
  await monitor.poll();
  check('verified stable Roblox is reported as external', monitor.snapshot().length === 1 && monitor.snapshot()[0].source === 'external');
  mockRows = [];
  await monitor.poll();
  check('exited external clients are removed on the next poll', monitor.snapshot().length === 0);
  mockRows = [{ pid: 4102, memBytes: 10, status: 'running', windowTitle: '', executablePath: 'C:\\Temp\\RobloxPlayerBeta.exe', verifiedPath: true, trustedInstall: false }];
  await monitor.poll();
  await monitor.poll();
  check('renamed or untrusted executables are not reported as Roblox', monitor.snapshot().length === 0);
  monitor.markManaged(4103, { exePath: 'D:\\CustomRoblox\\RobloxPlayerBeta.exe', playerPath: 'D:\\CustomRoblox\\RobloxPlayerBeta.exe' });
  mockRows = [{ pid: 4103, memBytes: 10, status: 'running', windowTitle: '', executablePath: 'D:\\CustomRoblox\\RobloxPlayerBeta.exe', verifiedPath: true, trustedInstall: false }];
  await monitor.poll();
  check('managed custom clients are matched by exact launch path', monitor.snapshot().length === 1 && monitor.snapshot()[0].source === 'fleet');
  monitor.markManaged(4104, { exePath: 'C:\\Roblox\\Versions\\version-b\\RobloxPlayerBeta.exe', processIdentity: 'old' });
  mockRows = [{ pid: 4104, memBytes: 10, status: 'running', windowTitle: 'Roblox', executablePath: 'C:\\Roblox\\Versions\\version-b\\RobloxPlayerBeta.exe', verifiedPath: true, trustedInstall: true, processIdentity: 'new' }];
  await monitor.poll();
  await monitor.poll();
  check('PID reuse cannot inherit Fleet-managed ownership', monitor.snapshot().length === 1 && monitor.snapshot()[0].source === 'external');
  mockRows = [{ pid: 4105, memBytes: 10, status: 'running', windowTitle: 'Roblox', executablePath: '', verifiedPath: false, trustedInstall: false, windowVerified: true, processIdentity: 'restricted' }];
  await monitor.poll();
  await monitor.poll();
  check('permission-limited real windows use conservative stable fallback', monitor.snapshot().length === 1 && monitor.snapshot()[0].source === 'external');

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
  const nativeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'native.js'), 'utf8');
  const peopleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'people.js'), 'utf8');
  check('Fleet never reads the memory of running game clients',
    !nativeSource.includes('ReadProcessMemory')
    && !nativeSource.includes('moduleBaseOf')
    && !peopleSource.includes('readServerPlayersFromPid')
    && !fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'people-server-worker.js')));

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
  check('People view no longer ships the removed memory-roster Server subtab',
    !rendererSource.includes('function renderServerPage()')
    && !rendererSource.includes("case 'server-refresh':")
    && !fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'tauri-bridge.js'), 'utf8').includes('people_server_list')
    && !fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8').includes('people_server_list')
    && !peopleSource.includes('async function listServerPeople(force)'));
  check('Games has advanced sorting, filtering and server ranking',
    rendererSource.includes("case 'games-hide-empty':")
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
  check('Electron installer customization has been removed',
    !fs.existsSync(path.join(__dirname, '..', 'build', 'installer.nsh'))
    && !fs.existsSync(path.join(__dirname, '..', 'build', 'app-update.yml')));
  const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tauriLibSource = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const tauriHostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tauri-node-host.js'), 'utf8');
  const tauriBridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'tauri-bridge.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const packageSource = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  check('Tauri bridge loads before app boot captures window.fleet',
    indexSource.includes('<script src="tauri-bridge.js"></script>')
    && indexSource.indexOf('tauri-bridge.js') < indexSource.indexOf('app.js'));
  check('Graphite and obsidian themes use the blue integrated native window layer',
    cssSource.includes(':root[data-theme="dark"]')
    && cssSource.includes('--accent: #2563eb')
    && cssSource.includes('--on-ink')
    && rendererSource.includes('function applyTheme()')
    && rendererSource.includes("case 'set-theme':")
    && tauriConfig.app.windows.some(w => w.decorations === false && w.transparent === true && w.shadow === false && w.backgroundColor === '#00000000')
    && !tauriLibSource.includes('DWMWA_WINDOW_CORNER_PREFERENCE')
    && !tauriLibSource.includes('CreateRoundRectRgn')
    && cssSource.includes('clip-path: inset(0 round 16px)')
    && indexSource.includes('class="window-shell"')
    && tauriBridgeSource.includes("toggleMaximize: () => windowCall('toggleMaximize')")
    && indexSource.includes('data-window-action="close"')
    && !indexSource.includes('id="lockchip"')
    && !indexSource.includes('class="tb-mark"')
    && !indexSource.includes('class="tb-brand"')
    && !/gradient|red-velvet|\bgreen\b|\bamber\b/i.test(cssSource));
  const iconPng = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.png'));
  const iconIco = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico'));
  const iconVector = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'icons', 'icon-source.svg'), 'utf8');
  check('Blue taskbar icon has a vector master and a full-resolution Windows icon family',
    iconVector.includes('viewBox="0 0 1024 1024"')
    && iconVector.includes('#2563eb')
    && iconPng.readUInt32BE(16) >= 512
    && iconPng.readUInt32BE(20) >= 512
    && iconIco.readUInt16LE(4) >= 6);
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
  check('Account-less installs can search public profiles without exposing account cookies',
    peopleSource.includes("'User-Agent': 'Fleet/1.5.3'")
    && peopleSource.includes('search-api/omni-search')
    && peopleSource.includes("verticalType: 'user'")
    && peopleSource.includes("presence: 'Unknown'")
    && !peopleSource.includes('needsAccount: true')
    && !rendererSource.includes('Sign in once to unlock search')
    && rendererSource.includes('Add a Roblox account to unlock People'));
  check('Games have favorites and recent-joins',
    rendererSource.includes('function toggleFav(')
    && rendererSource.includes('function recordRecentGame(')
    && rendererSource.includes("case 'toggle-fav':")
    && rendererSource.includes("'__fav'") && rendererSource.includes("'__recent'"));
  check('Clipboard quick-join offers copied game links locally',
    tauriBridgeSource.includes('navigator.clipboard.readText()')
    && rendererSource.includes('function checkClipboardForGameLink(')
    && rendererSource.includes("case 'clip-use':"));
  check('Tauri installer output replaces legacy Electron installer customization',
    tauriConfig.bundle.active === true
    && !fs.existsSync(path.join(__dirname, '..', 'build', 'installer.nsh')));
  check('Keep-alive auto-rejoins crashed clients with cooldown and strike-out',
    rendererSource.includes('function maybeKeepAlive(')
    && rendererSource.includes('KEEPALIVE_COOLDOWN_MS')
    && rendererSource.includes('t.fails >= 3')
    && rendererSource.includes('everInGame')
    && rendererSource.includes("case 'keepalive-off':")
    && rendererSource.includes('session.keepAlive && session.placeId'));
  const accountsSrcEarly = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'accounts.js'), 'utf8');
  check('User-facing source text is free of mojibake marker characters',
    !/[\u00c2\u00c3\u00e2]/.test(rendererSource)
    && !/[\u00c2\u00c3\u00e2]/.test(accountsSrcEarly)
    && !/[\u00c2\u00c3\u00e2]/.test(packageSource));
  check('Manual Roblox path browse uses a native file picker',
    tauriHostSource.includes('System.Windows.Forms.OpenFileDialog')
    && tauriHostSource.includes('Select RobloxPlayerBeta.exe')
    && tauriHostSource.includes('CheckFileExists')
    && !tauriHostSource.includes('async function pickFile() {\n  return null;'));
  check('Roblox path Browse and Re-detect persist the visible textbox value',
    rendererSource.includes('function currentSettingsDraft()')
    && rendererSource.includes("seg.dataset.auto = 'false'")
    && rendererSource.includes('api.settings.save(currentSettingsDraft())')
    && rendererSource.includes('Roblox detected from manual path'));
  check('Portable backend node starts without a visible console window',
    tauriLibSource.includes('CREATE_NO_WINDOW')
    && tauriLibSource.includes('creation_flags(CREATE_NO_WINDOW)'));
  check('Tauri account add captures WebView cookies and stores through the backend',
    tauriLibSource.includes('cookies_for_url')
    && tauriLibSource.includes('.ROBLOSECURITY')
    && tauriLibSource.includes('accounts_add_cookie')
    && accountsSrcEarly.includes('async function addFromCookie(cookie)')
    && rendererSource.includes('Fleet opens a Tauri Roblox sign-in window'));

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

  let clock = 1000000;
  let crashDoc = null;
  const crashStore = {
    readJson: (_name, fallback) => crashDoc ? JSON.parse(JSON.stringify(crashDoc)) : fallback,
    writeJson: (_name, data) => { crashDoc = JSON.parse(JSON.stringify(data)); return true; },
  };
  playtimeMod.configure({ store: crashStore, now: () => clock });
  playtimeMod.clear();
  playtimeMod.observe(333, 'alt3', 'In game', { name: 'Crash Test', placeId: 126 });
  clock += 45000;
  playtimeMod.observe(333, 'alt3', 'In game', { name: 'Crash Test', placeId: 126 });
  playtimeMod.checkpointNow();
  check('live playtime is checkpointed before normal shutdown', crashDoc.active['333'].lastSeen === clock);
  clock += 5000;
  playtimeMod.configure({ store: crashStore, now: () => clock });
  const recoveredOnce = playtimeMod.stats();
  playtimeMod.configure({ store: crashStore, now: () => clock });
  const recoveredTwice = playtimeMod.stats();
  check('force-quit recovery stops at last observation without double counting',
    recoveredOnce.totals.sessions === 1
    && recoveredOnce.totals.totalMs === 45000
    && recoveredOnce.recent[0].recovered === true
    && recoveredTwice.totals.sessions === 1
    && recoveredTwice.totals.totalMs === 45000);

  clock = 2000000;
  crashDoc = null;
  playtimeMod.configure({ store: crashStore, now: () => clock });
  playtimeMod.observe(401, 'one', 'In game', { name: 'Concurrent', placeId: 77 });
  playtimeMod.observe(402, 'two', 'In game', { name: 'Concurrent', placeId: 77 });
  clock += 40000;
  playtimeMod.observe(401, 'one', 'In game', { name: 'Concurrent', placeId: 77 });
  playtimeMod.observe(402, 'two', 'In game', { name: 'Concurrent', placeId: 77 });
  clock += 5000;
  playtimeMod.observe(401, 'one', 'Offline', null);
  playtimeMod.flush();
  const concurrentStats = playtimeMod.stats();
  check('multiple active account sessions persist independently',
    concurrentStats.tracking === 0
    && concurrentStats.totals.sessions === 2
    && concurrentStats.totals.totalMs === 90000
    && concurrentStats.perAccount.length === 2);

  const realPlaytimeDir = path.join(os.tmpdir(), 'fleet-playtime-store-' + Date.now());
  store.configure(realPlaytimeDir, console);
  playtimeMod.configure({ store, logger: console });
  playtimeMod.clear();
  playtimeMod.observe(222, 'alt2', 'In game', { name: 'Long Farm', placeId: 84 });
  const livePersistent = playtimeMod.stats();
  playtimeMod.flush();
  const storedPersistent = playtimeMod.stats();
  check('store exports readJson/writeJson for playtime persistence',
    typeof store.readJson === 'function'
    && typeof store.writeJson === 'function'
    && livePersistent.tracking === 1
    && storedPersistent.tracking === 0
    && fs.existsSync(path.join(realPlaytimeDir, 'playtime.json')));
  try { fs.rmSync(realPlaytimeDir, { recursive: true, force: true }); } catch (_) {}
  check('playtime is wired into the poller, IPC and UI',
    accountsSrcEarly.includes('onObserve(a.userId, a.username, pres.status, game)')
    && fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8').includes('backend_command!(playtime_stats')
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
    { id: 'good', name: '  Night run  ', accountIds: ['a', 'a', 2], placeId: '123', gameId: exactServerId, arrange: true, keepAlive: true },
    { id: 'broken', accountIds: 'not-an-array', placeId: 'bad' },
    null,
  ]);
  check('Saved sessions are normalized before rendering',
    normalizedSessions.length === 1
    && normalizedSessions[0].name === 'Night run'
    && normalizedSessions[0].accountIds.join(',') === 'a,2'
    && normalizedSessions[0].gameId === exactServerId
    && normalizedSessions[0].arrange === true
    && normalizedSessions[0].keepAlive === true);
  check('Theme preferences reject corrupt local values',
    rendererModel.normalizeThemePreference('DARK') === 'dark'
    && rendererModel.normalizeThemePreference('unknown') === 'system');
  const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tauri-backend.js'), 'utf8');
  check('player join no longer requires presence-visible server ids',
    ipcSource.includes('getPersonJoinLaunchInfo(accountIds[i], targetUserId)')
    && ipcSource.includes('return doLaunch({ accountIds, targetUserId });'));

  check('Tauri window is configured with the Fleet desktop dimensions',
    tauriConfig.app.windows.some(w => w.title === 'Fleet' && w.width === 1120 && w.height === 740 && w.minWidth === 900));
  check('startup never opens an account sign-in window automatically',
    rendererSource.includes("case 'add-account':")
    && rendererSource.includes("case 'reauth-account':")
    && rendererSource.includes('Background polling must never open a login window')
    && rendererSource.includes('api.accounts.add(), undefined, 0'));
  const accountsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'accounts.js'), 'utf8');
  check('expired accounts stay saved until the user explicitly signs in again',
    accountsSource.includes('sessionExpired: !!a.sessionExpired')
    && !accountsSource.includes('const remaining = readRaw().filter(x => x.id !== a.id)'));
  check('renderer API calls time out instead of hanging boot', rendererSource.includes('Promise.race([work, timeout])'));
  check('interactive account sign-in is not cut off by the normal API timeout',
    (rendererSource.match(/api\.accounts\.add\(\), undefined, 0/g) || []).length === 2
    && rendererSource.includes('if (!(limit > 0)) return await work;'));

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  check('package scripts build with Tauri and Electron packages are removed',
    manifest.scripts.start === 'tauri dev'
    && manifest.scripts.build.includes('scripts/build-portable.ps1')
    && manifest.scripts.dist.includes('scripts/build-installer.ps1')
    && manifest.devDependencies['@tauri-apps/cli']
    && !manifest.dependencies['electron-updater']
    && !manifest.devDependencies.electron
    && !manifest.devDependencies['electron-builder']);
  check('Tauri bundle is configured for Fleet',
    tauriConfig.productName === 'Fleet'
    && tauriConfig.identifier === 'com.toluwa.fleet'
    && tauriConfig.bundle.active === true);

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

  check('Updater checks GitHub latest.yml and installs FleetInstaller.exe',
    ipcSource.includes('https://github.com/Toluwer/Fleet/releases/latest/download/latest.yml')
    && ipcSource.includes('FleetInstaller.exe')
    && ipcSource.includes("state = 'available'")
    && ipcSource.includes("state = 'installing'"));
  const installerTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'src-tauri', 'fleet-installer.nsi'),
    'utf8',
  );
  const nsisConfig = tauriConfig.bundle.windows.nsis;
  check('Installer is frameless custom NSIS with bundled Node and WebView2 bootstrap',
    tauriConfig.bundle.targets === 'nsis'
    && tauriConfig.bundle.resources.includes('resources/node.exe')
    && tauriConfig.bundle.windows.webviewInstallMode.type === 'downloadBootstrapper'
    && nsisConfig.template === 'fleet-installer.nsi'
    && nsisConfig.installMode === 'currentUser'
    && !Object.prototype.hasOwnProperty.call(nsisConfig, 'installerHooks')
    && installerTemplate.includes('Function FleetCreateTitleBar')
    && installerTemplate.includes('${NSD_RemoveStyle} $HWNDPARENT')
    && installerTemplate.includes('Function FleetPrepareFullCanvas')
    && !installerTemplate.includes('MUI_PAGE_WELCOME')
    && !installerTemplate.includes('MUI_PAGE_DIRECTORY')
    && !installerTemplate.includes('MUI_PAGE_FINISH'));
  check('Installer matches the Fleet app theme with native caption buttons',
    installerTemplate.includes('!define FLEET_ACCENT 0x2563EB')
    && installerTemplate.includes('Segoe MDL2 Assets')
    && installerTemplate.includes('Function FleetHoverPoll')
    && installerTemplate.includes('DarkMode_Explorer')
    && installerTemplate.includes('MUI_CUSTOMFUNCTION_GUIINIT FleetGuiInit'));
  check('Uninstaller uses the same custom Fleet surface instead of the stock wizard',
    installerTemplate.includes('UninstPage custom un.FleetConfirmPage')
    && installerTemplate.includes('Function un.FleetConfirmPage')
    && installerTemplate.includes('Function un.InstFilesShow')
    && !installerTemplate.includes('MUI_UNPAGE_CONFIRM'));

  await section('Resilient people search');
  const response = (status, data, headers) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (headers && headers[String(name).toLowerCase()]) || null },
    json: async () => data,
  });
  let keywordCallsForFullUsername = 0;
  let legacyEndpointTouched = false;
  let keywordCookieAttached = false;
  try {
    global.fetch = async (url, opts) => {
      const href = String(url);
      if (href.includes('/v1/users/search')) {
        legacyEndpointTouched = true;
        return response(500, {});
      }
      if (href.includes('/search-api/omni-search')) {
        keywordCallsForFullUsername++;
        const headers = opts && opts.headers || {};
        keywordCookieAttached = !!(headers.Cookie || headers.cookie);
        return response(200, {
          searchResults: [{ contents: [
            { contentId: 24680, username: 'Exact_User', displayName: 'Exact User' },
            { contentId: 24681, username: 'Exact_UserFan', displayName: 'Exact User Fan' },
          ] }],
          nextPageToken: 'more-exact-users',
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
      && fullUsernameResult.nextPageCursor === 'omni:more-exact-users'
      && keywordCallsForFullUsername === 1
      && keywordCookieAttached === false
      && legacyEndpointTouched === false);
    check('identical searches reuse cached results', cachedFullUsername.ok && cachedFullUsername.cached === true && keywordCallsForFullUsername === 1);

    let keywordCalls = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/search-api/omni-search')) {
        keywordCalls++;
        if (keywordCalls === 1) return response(429, { errors: [{ code: 0, message: '' }] });
        return response(200, { searchResults: [{ contents: [{ contentId: 13579, username: 'DisplayUser', displayName: 'Display Name' }] }], nextPageToken: null });
      }
      if (href.includes('/avatar-headshot')) return response(200, { data: [] });
      if (href.includes('/presence/users')) return response(200, { userPresences: [] });
      throw new Error('Unexpected retry URL: ' + href);
    };
    const retryResult = await people.search('Display Name');
    check('keyword search recovers from one HTTP 429', retryResult.ok && retryResult.people[0].userId === 13579 && keywordCalls === 2);

    let legacyFallbackCalls = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/search-api/omni-search')) return response(403, { errors: [{ code: 0, message: 'Forbidden' }] });
      if (href.includes('/v1/users/search')) {
        legacyFallbackCalls++;
        return response(200, { data: [
          { id: 86420, name: 'Blocked_User', displayName: 'Blocked User' },
          { id: 86421, name: 'Blocked_UserFan', displayName: 'Blocked User Fan' },
        ], nextPageCursor: 'legacy-more' });
      }
      if (href.includes('/avatar-headshot')) return response(200, { data: [] });
      if (href.includes('/presence/users')) return response(200, { userPresences: [] });
      throw new Error('Unexpected fallback URL: ' + href);
    };
    const forbiddenFallback = await people.search('Blocked_User');
    check('HTTP 403 current search falls back to a full ranked legacy result list',
      forbiddenFallback.ok
      && forbiddenFallback.source === 'keyword'
      && forbiddenFallback.people.length === 2
      && forbiddenFallback.nextPageCursor === 'legacy:legacy-more'
      && legacyFallbackCalls === 1);

    let keywordTouched = false;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/v1/users/97531')) return response(200, { id: 97531, name: 'IdUser', displayName: 'ID User' });
      if (href.includes('/search-api/omni-search') || href.includes('/v1/users/search')) { keywordTouched = true; return response(500, {}); }
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
