'use strict';
/* Full recipe: path-isolation junctions + gentle GLOBAL-only singleton closing.
   Each instance keeps its own per-path mutex; only the shared ROBLOX_singleton*
   objects are neutralised. Observe 25s for stable coexistence. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const native = require('../src/main/native');
const roblox = require('../src/main/roblox');

const wait = ms => new Promise(r => setTimeout(r, ms));
function makeJunction(link, target) {
  try { execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'ignore' }); } catch (_) {}
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
}
function removeJunction(link) { try { execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'ignore' }); } catch (_) {} }

(async () => {
  native.init();
  const loc = roblox.locate({ autoDetect: true });
  const realDir = path.dirname(loc.playerPath);
  const root = path.join(os.tmpdir(), 'fleet-clones-test');
  fs.mkdirSync(root, { recursive: true });
  const links = [path.join(root, 'i1'), path.join(root, 'i2'), path.join(root, 'i3')];
  links.forEach(l => makeJunction(l, realDir));
  const exe = i => path.join(links[i], 'RobloxPlayerBeta.exe');

  // Gentle GLOBAL-only guard
  let closed = 0, pidCache = [], pidT = 0;
  const guard = setInterval(async () => {
    if (!native.blockerExists(loc.playerPath, 'global')) return;
    if (Date.now() - pidT > 700) { pidCache = (await processes.list()).map(p => p.pid); pidT = Date.now(); }
    const r = native.closeRobloxSingletonHandles(pidCache, 'global');
    closed += r.closed || 0;
  }, 200);

  for (let i = 0; i < 2; i++) {
    console.log(`launch #${i + 1} via junction:`, launcher.launchInstance({ playerPath: exe(i), mode: 'client' }));
    await wait(7000);
    console.log(`  after #${i + 1}: count=${(await processes.list()).length} | globalClosed=${closed}`);
  }

  console.log('\nObserving persistence...');
  for (let s = 1; s <= 10; s++) {
    await wait(1500);
    const live = await processes.list();
    console.log(`t+${(s * 1.5).toFixed(1)}s | count=${live.length} | pids=${live.map(p => p.pid).join(',')}`);
  }

  clearInterval(guard);
  const list = await processes.list();
  console.log('\nFINAL count =', list.length, '| globalClosed total =', closed);
  list.forEach(p => console.log('  PID ' + p.pid + ' | ' + Math.round(p.memBytes / 1048576) + 'MB | win="' + p.windowTitle + '"'));
  console.log(list.length >= 2 ? '*** SUCCESS: multiple instances stable ***' : '*** FAIL ***');

  await processes.killAllPlayers();
  await wait(1000);
  links.forEach(removeJunction);
  process.exit(list.length >= 2 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
