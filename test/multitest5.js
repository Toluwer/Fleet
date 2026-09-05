'use strict';
/* Path-isolation test: launch each instance via its own directory JUNCTION to
   the real Roblox version folder, so the per-build "<path>.mtx" mutex names
   differ and no longer collide. Junctions are reparse points (no file copy). */

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

  const c1 = path.join(root, 'i1');
  const c2 = path.join(root, 'i2');
  makeJunction(c1, realDir);
  makeJunction(c2, realDir);
  const exe1 = path.join(c1, 'RobloxPlayerBeta.exe');
  const exe2 = path.join(c2, 'RobloxPlayerBeta.exe');
  console.log('junctions created:\n ', exe1, '\n ', exe2);

  console.log('\nlaunch #1 via junction i1:', launcher.launchInstance({ playerPath: exe1, mode: 'client' }));
  await wait(8000);
  console.log('after #1:', (await processes.list()).map(p => p.pid));

  console.log('\nlaunch #2 via junction i2:', launcher.launchInstance({ playerPath: exe2, mode: 'client' }));

  for (let s = 1; s <= 10; s++) {
    await wait(1500);
    const live = await processes.list();
    console.log(`t+${(s * 1.5).toFixed(1)}s | count=${live.length} | pids=${live.map(p => p.pid).join(',')}`);
  }

  const list = await processes.list();
  console.log('\nFINAL count =', list.length);
  list.forEach(p => console.log('  PID ' + p.pid + ' | ' + Math.round(p.memBytes / 1048576) + 'MB | win="' + p.windowTitle + '"'));
  console.log(list.length >= 2 ? '*** SUCCESS: path isolation works ***' : '*** FAIL ***');

  await processes.killAllPlayers();
  await wait(1000);
  removeJunction(c1); removeJunction(c2);
  process.exit(list.length >= 2 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
