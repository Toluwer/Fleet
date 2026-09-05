'use strict';
/* Make-or-break test: can Fleet's handle-closing produce TWO coexisting clients?
   Sequence: launch #1 -> wait for its singleton event -> close it -> launch #2.
   Cleans up everything it starts. */

const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const native = require('../src/main/native');
const roblox = require('../src/main/roblox');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, timeout, iv = 200) {
  const t = Date.now();
  while (Date.now() - t < timeout) { if (pred()) return true; await wait(iv); }
  return pred();
}
const pids = async () => (await processes.list()).map(p => p.pid);

(async () => {
  native.init();
  console.log('FFI available:', native.isAvailable(), '| eventTypeIndex:', native.getEventTypeIndex());
  const loc = roblox.locate({ autoDetect: true });
  if (!loc.found) { console.log('Roblox not found'); process.exit(2); }

  console.log('singletonExists at start:', native.singletonExists());

  console.log('\n--- launch #1 ---');
  console.log(launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await until(() => native.singletonExists(), 15000);
  console.log('after #1: singletonExists =', native.singletonExists(), '| roblox count =', (await pids()).length);

  console.log('\n--- close singleton handles ---');
  const p1 = await pids();
  console.log('closing in pids', p1, '->', native.closeRobloxSingletonHandles(p1));
  await until(() => !native.singletonExists(), 5000);
  console.log('after close: singletonExists =', native.singletonExists());

  console.log('\n--- launch #2 ---');
  console.log(launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await wait(14000);

  const list = await processes.list();
  console.log('\nFINAL roblox count =', list.length);
  list.forEach(p => console.log('  PID ' + p.pid + ' | ' + Math.round(p.memBytes / 1048576) + 'MB | win="' + p.windowTitle + '"'));
  console.log(list.length >= 2 ? '\n*** SUCCESS: multiple instances coexist ***' : '\n*** FAIL: still single instance ***');

  // cleanup
  await processes.killAllPlayers();
  process.exit(list.length >= 2 ? 0 : 1);
})().catch(e => { console.error('crashed:', e); process.exit(3); });
