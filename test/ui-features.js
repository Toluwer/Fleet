'use strict';

/* Isolated renderer integration test for theme, sessions and server intelligence.
   It starts the Tauri Fleet executable, drives only renderer state through
   WebView2's debugging protocol, never clicks a launch action, and verifies no
   Roblox process was created. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const processes = require('../src/main/processes');

const root = path.join(__dirname, '..');
const executable = process.env.FLEET_TEST_EXE ? path.resolve(process.env.FLEET_TEST_EXE) : null;
const devTauriExe = path.join(root, 'src-tauri', 'target', 'release', 'fleet.exe');
const packaged = !!process.env.FLEET_TEST_EXE;
const profileName = 'fleet-ui-features-' + Date.now();
const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'main', profileName);
const port = 9337;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  return (method, params = {}) => new Promise(resolve => {
    const nextId = ++id;
    pending.set(nextId, resolve);
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });
}

async function waitForPage(child, readStderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      const detail = String(readStderr() || '').trim();
      throw new Error(`Fleet exited before WebView debugging started (code ${child.exitCode})${detail ? `: ${detail}` : '.'}`);
    }
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find(target => target.type === 'page' && (/index\.html/.test(target.url) || /tauri/i.test(target.url))) || targets.find(target => target.type === 'page');
      if (page) return page;
    } catch (_) { /* app is still starting */ }
    await wait(200);
  }
  throw new Error('Fleet renderer did not expose a debugging target.');
}

async function main() {
  const fleetExe = packaged ? executable : devTauriExe;
  if (!fs.existsSync(fleetExe)) throw new Error(`Fleet Tauri executable was not found: ${fleetExe}. Run npm run build first.`);
  const before = new Set((await processes.list()).map(item => item.pid));
  const args = [];
  const env = Object.assign({}, process.env);
  env.FLEET_UI_TEST_BROWSER_ARGS = `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`;
  env.FLEET_UI_TEST_DATA_DIRECTORY = profileName;
  const child = spawn(fleetExe, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  let ws;
  try {
    const page = await waitForPage(child, () => stderr);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const send = cdp(ws);
    const exceptions = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text || 'Renderer exception');
    });
    await send('Runtime.enable');

    const evaluate = async expression => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.result && reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
      return reply.result.result.value;
    };

    let booted = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      booted = await evaluate(`!!document.querySelector('[data-view="instances"]') && typeof views === 'object'
        && state.status !== null && renderedView === 'instances' && !!document.querySelector('#ilist')`);
      if (booted) break;
      await wait(150);
    }
    if (!booted) throw new Error('Fleet renderer did not finish booting before the test deadline.');

    const facts = await evaluate(`(async () => {
      localStorage.removeItem('fleet-sessions');
      state.status = { robloxFound: true, version: 'test', source: 'test', ffiAvailable: true };
      state.accounts = [
        { id: 'acct-1', username: 'Tester', displayName: 'Test Account', presence: 'Offline' },
        { id: 'acct-2', username: 'Unselected', displayName: 'Unselected Account', presence: 'Offline' },
      ];
      state.selected = new Set(['acct-1']);
      state.launchMode = 'account';
      state.sessionDraft = null;
      state.view = 'instances';
      views.instances();

      setThemePref('dark');
      toast('Dark error', 'bad');
      const errorToastText = getComputedStyle(document.querySelector('.toast.bad')).color;
      document.querySelector('.toast.bad').remove();
      const interactiveNoTimeout = await call(
        () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 25)),
        undefined,
        0,
      );
      const dark = {
        theme: document.documentElement.dataset.theme,
        body: getComputedStyle(document.querySelector('.window-shell')).backgroundColor,
        html: getComputedStyle(document.documentElement).backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        surface: getComputedStyle(document.querySelector('.card')).backgroundColor,
        primaryText: getComputedStyle(document.querySelector('.btn.primary')).color,
        unselectedChipText: getComputedStyle(document.querySelector('.chip:not(.on)')).color,
        errorToastText,
        interactiveNoTimeout: interactiveNoTimeout && interactiveNoTimeout.ok,
      };
      const chrome = {
        titlebar: !!document.querySelector('#titlebar-drag'),
        titlebarMark: !!document.querySelector('.tb-mark'),
        titlebarBrand: !!document.querySelector('.tb-brand'),
        statusCard: !!document.querySelector('#lockchip'),
        controls: document.querySelectorAll('[data-window-action]').length,
        bodyRadius: getComputedStyle(document.querySelector('.window-shell')).borderRadius,
        htmlRadius: getComputedStyle(document.documentElement).borderRadius,
        titlebarBackground: getComputedStyle(document.querySelector('.titlebar')).backgroundColor,
        nativeApi: !!(api.ui && api.ui.window && api.ui.window.toggleMaximize && api.ui.window.startDragging),
      };
      const maximizedBefore = await api.ui.window.isMaximized();
      await api.ui.window.toggleMaximize();
      await new Promise(resolve => setTimeout(resolve, 120));
      const maximizedAfter = await api.ui.window.isMaximized();
      const maximizedClassAfter = document.documentElement.classList.contains('window-maximized');
      await api.ui.window.toggleMaximize();
      await new Promise(resolve => setTimeout(resolve, 120));
      const maximizedRestored = await api.ui.window.isMaximized();
      const maximizedClassRestored = document.documentElement.classList.contains('window-maximized');
      chrome.maximizeRoundTrip = maximizedAfter !== maximizedBefore && maximizedRestored === maximizedBefore;
      chrome.maximizedClassSync = maximizedClassAfter === maximizedAfter && maximizedClassRestored === maximizedRestored;
      setThemePref('light');
      const light = {
        theme: document.documentElement.dataset.theme,
        body: getComputedStyle(document.querySelector('.window-shell')).backgroundColor,
        surface: getComputedStyle(document.querySelector('.card')).backgroundColor,
      };

      state.servers = {
        placeId: '4924922222', name: 'Server test',
        list: [
          { id: 'quiet', playing: 1, maxPlayers: 28, ping: 8, fps: 60 },
          { id: 'busy', playing: 27, maxPlayers: 28, ping: 65, fps: 58 },
          { id: 'middle', playing: 14, maxPlayers: 28, ping: 45, fps: 50 },
        ],
        nextPageCursor: null, loading: false, scanning: false, deepScanned: true,
        scan: { pagesScanned: 4, examined: 210 }, error: null, sort: 'players',
        filters: { occupancy: 50, maxPing: 100, minFps: 45, freeSlots: 1 },
        autoRefresh: false, refreshTimer: null, requestId: 0,
      };
      renderServersModal();
      const serverRows = [...document.querySelectorAll('.server-row')];
      const serverIntel = {
        modalClass: document.querySelector('#modal').className,
        firstRow: serverRows[0] ? serverRows[0].innerText : '',
        visibleRows: serverRows.length,
        analytics: (document.querySelector('.server-intel') || {}).innerText || '',
        hasFilters: document.querySelectorAll('[data-server-filter]').length,
        hasDeepScan: !!document.querySelector('[data-action="servers-scan"]'),
        hasLiveRefresh: !!document.querySelector('[data-action="servers-auto-refresh"]'),
      };
      closeModal();
      state.servers = null;

      state.updater = { state: 'error', error: 'Update feed unavailable (HTTP 404). The GitHub release source is private or cannot be reached.' };
      state.view = 'settings';
      await views.settings();
      const updateDescription = [...document.querySelectorAll('.s-desc')].find(el => /Update feed unavailable/.test(el.textContent));
      const updaterUi = {
        text: updateDescription ? updateDescription.textContent : '',
        overflowWrap: updateDescription ? getComputedStyle(updateDescription).overflowWrap : '',
      };
      state.view = 'instances';
      state.accounts = [
        { id: 'acct-1', username: 'Tester', displayName: 'Test Account', presence: 'Offline' },
        { id: 'acct-2', username: 'Unselected', displayName: 'Unselected Account', presence: 'Offline' },
      ];
      state.selected = new Set(['acct-1']);
      state.launchMode = 'account';
      views.instances();
      await new Promise(resolve => setTimeout(resolve, 50));

      const serverId = '12345678-abcd-4abc-8abc-1234567890ab';
      const placeInput = document.querySelector('#lp-place');
      if (!placeInput) throw new Error('Launch target input missing after returning to Instances');
      placeInput.value = 'https://www.roblox.com/games/987654/Test?gameInstanceId=' + serverId;
      const saveButton = document.querySelector('[data-action="session-save"]');
      saveButton.click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const draft = Object.assign({}, state.sessionDraft);
      const sessionName = document.querySelector('#session-name');
      const sessionArrange = document.querySelector('#session-arrange');
      const sessionKeepAlive = document.querySelector('#session-keepalive');
      if (!sessionName || !sessionArrange || !sessionKeepAlive) {
        throw new Error('Save session modal did not open: ' + JSON.stringify({
          saveDisabled: !!(saveButton && saveButton.disabled),
          draft: state.sessionDraft,
          modalOpen: !!(document.querySelector('#modal-back') && document.querySelector('#modal-back').classList.contains('open')),
          toasts: [...document.querySelectorAll('.toast')].map(item => item.textContent),
          target: parseRobloxTarget(placeInput.value),
        }));
      }
      sessionName.value = 'Night crew';
      sessionArrange.checked = true;
      sessionKeepAlive.checked = true;
      if (!sessionKeepAlive.checked) throw new Error('Session keep-alive checkbox did not accept checked state');
      document.querySelector('[data-action="session-save-confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const saved = JSON.parse(localStorage.getItem('fleet-sessions') || '[]');
      const normalizedSaved = normalizeSessions(saved);
      const rowText = (document.querySelector('#sessions-list') || {}).innerText || '';

      const invalidInput = document.querySelector('#lp-place');
      if (!invalidInput) throw new Error('Launch target input missing before invalid target check');
      invalidInput.value = 'https://www.roblox.com/share?code=unresolved';
      document.querySelector('[data-action="session-save"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const invalidRejected = !document.querySelector('#modal-back').classList.contains('open')
        && [...document.querySelectorAll('.toast')].some(item => /Could not read a place ID/.test(item.textContent));

      localStorage.setItem('fleet-sessions', JSON.stringify([{ id: 'bad', accountIds: 'broken' }, null]));
      views.instances();
      const corruptSafe = document.querySelectorAll('#sessions-list .setting').length === 0
        && /No sessions yet/.test(document.querySelector('#sessions-list').textContent);

      const rapidStart = performance.now();
      for (let i = 0; i < 40; i++) setView(i % 2 ? 'help' : 'instances');
      const rapidNavMs = performance.now() - rapidStart;
      return { dark, light, chrome, rapidNavMs, serverIntel, updaterUi, draft, saved, normalizedSaved, rowText, invalidRejected, corruptSafe };
    })()`);

    const scaling = [];
    for (const factor of [1, 1.25, 1.5]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 740, deviceScaleFactor: factor, mobile: false });
      await wait(80);
      scaling.push(await evaluate(`({
        factor: window.devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        overflowX: document.body.scrollWidth > innerWidth,
        overflowY: document.body.scrollHeight > innerHeight,
        titlebarHeight: Math.round(document.querySelector('.titlebar').getBoundingClientRect().height),
        closeWidth: Math.round(document.querySelector('[data-window-action="close"]').getBoundingClientRect().width),
      })`));
    }
    await send('Emulation.clearDeviceMetricsOverride');

    if (facts.dark.theme !== 'dark' || facts.dark.body === facts.light.body || facts.dark.surface === facts.light.surface
      || facts.dark.html !== 'rgba(0, 0, 0, 0)' || facts.dark.accent !== '#2563eb'
      || facts.dark.unselectedChipText !== 'rgb(244, 240, 241)'
      || facts.dark.errorToastText !== 'rgb(255, 255, 255)'
      || !facts.dark.interactiveNoTimeout) {
      throw new Error('Theme switching did not change the rendered palette: ' + JSON.stringify(facts));
    }
    if (!facts.chrome.titlebar || facts.chrome.titlebarMark || facts.chrome.titlebarBrand || facts.chrome.statusCard || facts.chrome.controls !== 3
      || facts.chrome.bodyRadius !== '16px' || facts.chrome.htmlRadius !== '0px'
      || facts.chrome.titlebarBackground !== 'rgba(0, 0, 0, 0)' || !facts.chrome.nativeApi
      || !facts.chrome.maximizeRoundTrip || !facts.chrome.maximizedClassSync || facts.rapidNavMs > 2000) {
      throw new Error('Integrated window chrome or rapid navigation failed: ' + JSON.stringify(facts));
    }
    if (scaling.some(item => item.overflowX || item.overflowY || item.titlebarHeight !== 44 || item.closeWidth !== 46)) {
      throw new Error('Window layout failed at a tested display scale: ' + JSON.stringify(scaling));
    }
    if (!facts.normalizedSaved.length || facts.normalizedSaved[0].name !== 'Night crew' || !facts.normalizedSaved[0].arrange) {
      throw new Error('Session was not saved correctly: ' + JSON.stringify(facts));
    }
    if (facts.draft.placeId !== '987654' || facts.saved[0].gameId !== '12345678-abcd-4abc-8abc-1234567890ab') {
      throw new Error('Exact-server target was not preserved: ' + JSON.stringify(facts));
    }
    if (!/Night crew/.test(facts.rowText) || !facts.invalidRejected || !facts.corruptSafe) {
      throw new Error('Session UI validation failed: ' + JSON.stringify(facts));
    }
    if (!facts.serverIntel.modalClass.includes('server-modal')
      || !/^27\/28/.test(facts.serverIntel.firstRow)
      || facts.serverIntel.visibleRows !== 2
      || facts.serverIntel.hasFilters !== 4
      || !facts.serverIntel.hasDeepScan
      || !facts.serverIntel.hasLiveRefresh
      || !/2\s+VISIBLE/i.test(facts.serverIntel.analytics)) {
      throw new Error('Server Intelligence UI failed: ' + JSON.stringify(facts.serverIntel));
    }
    if (!/HTTP 404/.test(facts.updaterUi.text) || facts.updaterUi.overflowWrap !== 'anywhere') {
      throw new Error('Updater error UI is not concise and wrap-safe: ' + JSON.stringify(facts.updaterUi));
    }
    if (exceptions.length) throw new Error('Renderer exceptions: ' + exceptions.join('; '));

    const after = await processes.list();
    const unexpectedRoblox = after.filter(item => !before.has(item.pid));
    if (unexpectedRoblox.length) throw new Error('Fleet unexpectedly launched Roblox during UI testing.');

    console.log(JSON.stringify({ ok: true, packaged, facts, scaling, rendererExceptions: exceptions, newRobloxProcesses: unexpectedRoblox.length }, null, 2));
    const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
    const closeAccepted = await evaluate(`(api.ui.window.close(), true)`);
    const closed = await Promise.race([exited, wait(5000).then(() => false)]);
    if (!closeAccepted || !closed) throw new Error('Native close control did not terminate Fleet cleanly.');
  } finally {
    if (ws) try { ws.close(); } catch (_) {}
    await wait(500);
    if (child.exitCode === null && !child.killed) try { child.kill(); } catch (_) {}
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  if (stderr && /uncaught|fatal|error/i.test(stderr)) console.error(stderr.trim());
}

main().catch(error => {
  console.error('UI feature test failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
