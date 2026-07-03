'use strict';

/* Isolated renderer integration test for theme, sessions and server intelligence.
   It starts Fleet with a temporary user-data directory, drives only renderer
   state through Chromium's debugging protocol, never clicks a launch action,
   and verifies no Roblox process was created. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const processes = require('../src/main/processes');

const root = path.join(__dirname, '..');
const devElectronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
const executable = process.env.FLEET_TEST_EXE ? path.resolve(process.env.FLEET_TEST_EXE) : null;
const devElectronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const packaged = !!process.env.FLEET_TEST_EXE;
const profile = path.join(os.tmpdir(), 'fleet-ui-features-' + Date.now());
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

async function waitForPage() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find(target => target.type === 'page' && /index\.html/.test(target.url));
      if (page) return page;
    } catch (_) { /* app is still starting */ }
    await wait(200);
  }
  throw new Error('Fleet renderer did not expose a debugging target.');
}

async function main() {
  if (packaged && !fs.existsSync(executable)) throw new Error(`Fleet test executable was not found: ${executable}`);
  if (!packaged && !fs.existsSync(devElectronExe) && !fs.existsSync(devElectronCli)) throw new Error(`Electron executable was not found: ${devElectronExe}`);
  const before = new Set((await processes.list()).map(item => item.pid));
  const args = packaged
    ? [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
    ]
    : [
      root,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
    ];
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(packaged ? executable : devElectronExe, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  let ws;
  try {
    const page = await waitForPage();
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

    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(`!!document.querySelector('[data-view="instances"]') && typeof views === 'object'`)) break;
      await wait(150);
    }

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
        body: getComputedStyle(document.body).backgroundColor,
        surface: getComputedStyle(document.querySelector('.card')).backgroundColor,
        primaryText: getComputedStyle(document.querySelector('.btn.primary')).color,
        unselectedChipText: getComputedStyle(document.querySelector('.chip:not(.on)')).color,
        errorToastText,
        interactiveNoTimeout: interactiveNoTimeout && interactiveNoTimeout.ok,
      };
      setThemePref('light');
      const light = {
        theme: document.documentElement.dataset.theme,
        body: getComputedStyle(document.body).backgroundColor,
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
      views.settings();
      const updateDescription = [...document.querySelectorAll('.s-desc')].find(el => /Update feed unavailable/.test(el.textContent));
      const updaterUi = {
        text: updateDescription ? updateDescription.textContent : '',
        overflowWrap: updateDescription ? getComputedStyle(updateDescription).overflowWrap : '',
      };
      state.view = 'instances';
      views.instances();

      const serverId = '12345678-abcd-4abc-8abc-1234567890ab';
      const placeInput = document.querySelector('#lp-place');
      placeInput.value = 'https://www.roblox.com/games/987654/Test?gameInstanceId=' + serverId;
      document.querySelector('[data-action="session-save"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const draft = Object.assign({}, state.sessionDraft);
      document.querySelector('#session-name').value = 'Night crew';
      document.querySelector('#session-arrange').checked = true;
      document.querySelector('[data-action="session-save-confirm"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const saved = JSON.parse(localStorage.getItem('fleet-sessions') || '[]');
      const rowText = (document.querySelector('#sessions-list') || {}).innerText || '';

      const invalidInput = document.querySelector('#lp-place');
      invalidInput.value = 'https://www.roblox.com/share?code=unresolved';
      document.querySelector('[data-action="session-save"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const invalidRejected = !document.querySelector('#modal-back').classList.contains('open')
        && [...document.querySelectorAll('.toast')].some(item => /Could not read a place ID/.test(item.textContent));

      localStorage.setItem('fleet-sessions', JSON.stringify([{ id: 'bad', accountIds: 'broken' }, null]));
      views.instances();
      const corruptSafe = document.querySelectorAll('#sessions-list .setting').length === 0
        && /No sessions yet/.test(document.querySelector('#sessions-list').textContent);

      return { dark, light, serverIntel, updaterUi, draft, saved, rowText, invalidRejected, corruptSafe };
    })()`);

    if (facts.dark.theme !== 'dark' || facts.dark.body === facts.light.body || facts.dark.surface === facts.light.surface
      || facts.dark.unselectedChipText !== 'rgb(242, 243, 245)'
      || facts.dark.errorToastText !== 'rgb(255, 255, 255)'
      || !facts.dark.interactiveNoTimeout) {
      throw new Error('Theme switching did not change the rendered palette: ' + JSON.stringify(facts));
    }
    if (!facts.saved.length || facts.saved[0].name !== 'Night crew' || !facts.saved[0].arrange) {
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

    console.log(JSON.stringify({ ok: true, packaged, facts, rendererExceptions: exceptions, newRobloxProcesses: unexpectedRoblox.length }, null, 2));
    send('Browser.close').catch(() => {});
  } finally {
    if (ws) try { ws.close(); } catch (_) {}
    await wait(500);
    if (!child.killed) try { child.kill(); } catch (_) {}
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  if (stderr && /uncaught|fatal|error/i.test(stderr)) console.error(stderr.trim());
}

main().catch(error => {
  console.error('UI feature test failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
