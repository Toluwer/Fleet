'use strict';
/* Test the CONTINUOUS guard: keep closing ROBLOX_singletonEvent whenever it
   reappears, so no client retains ownership. Launch 2 clients; expect 2 alive. */

const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const native = require('../src/main/native');
const roblox = require('../src/main/roblox');

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  native.init();
  const loc = roblox.locate({ autoDetect: true });
  console.log('FFI:', native.isAvailable(), '| typeIndices:', JSON.stringify(native.getTypeIndices()));

  // Continuous guard: gated by the cheap existence check; only enumerates when needed.
  let guardClosed = 0, guardTicks = 0;
  let lastPids = [];
  let pidRefresh = 0;
  const guard = setInterval(async () => {
    guardTicks++;
    if (!native.blockerExists(loc.playerPath)) return;
    // refresh roblox pids at most ~ every 1s
    if (Date.now() - pidRefresh > 800) { lastPids = (await processes.list()).map(p => p.pid); pidRefresh = Date.now(); }
    const r = native.closeRobloxSingletonHandles(lastPids);
    if (r.closed) { guardClosed += r.closed; }
  }, 150);

  console.log('\n--- launch #1 ---', launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await wait(7000);
  console.log('after #1: count =', (await processes.list()).length, '| guardClosed so far =', guardClosed);

  console.log('\n--- launch #2 ---', launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await wait(13000);

  clearInterval(guard);
  const list = await processes.list();
  console.log('\nguard ticks =', guardTicks, '| total handles closed =', guardClosed);
  console.log('FINAL roblox count =', list.length);
  list.forEach(p => console.log('  PID ' + p.pid + ' | ' + Math.round(p.memBytes / 1048576) + 'MB | win="' + p.windowTitle + '"'));
  console.log(list.length >= 2 ? '\n*** SUCCESS: multiple instances coexist ***' : '\n*** FAIL: still single ***');

  await processes.killAllPlayers();
  process.exit(list.length >= 2 ? 0 : 1);
})().catch(e => { console.error('crashed:', e); process.exit(3); });
