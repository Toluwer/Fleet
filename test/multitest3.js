'use strict';
/* Aggressive-close test: hammer the guard-closing around the #2 launch to rule
   out a timing race. Track when #2 dies. */

const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const native = require('../src/main/native');
const roblox = require('../src/main/roblox');

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  native.init();
  const loc = roblox.locate({ autoDetect: true });
  console.log('typeIndices:', JSON.stringify(native.getTypeIndices()));

  console.log('launch #1:', launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await wait(8000);
  let pids = (await processes.list()).map(p => p.pid);
  console.log('after #1, pids:', pids);

  // Aggressive close loop for 8s
  let running = true;
  let closes = 0, calls = 0;
  let pidRefresh = 0, curPids = pids;
  (async function loop() {
    while (running) {
      if (Date.now() - pidRefresh > 400) { curPids = (await processes.list()).map(p => p.pid); pidRefresh = Date.now(); }
      const r = native.closeRobloxSingletonHandles(curPids);
      calls++; closes += r.closed || 0;
      await new Promise(r => setImmediate(r));
    }
  })();

  await wait(800);
  const r2 = launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' });
  console.log('launch #2:', r2);
  const pid2 = r2.pid;

  // Track #2 survival
  for (let s = 1; s <= 10; s++) {
    await wait(1500);
    const live = (await processes.list()).map(p => p.pid);
    const alive2 = live.includes(pid2);
    console.log(`t+${(s * 1.5).toFixed(1)}s | roblox count=${live.length} | #2(${pid2}) alive=${alive2} | closes=${closes} calls=${calls}`);
    if (s === 4) running = false; // stop aggressive closing after ~6.8s
  }
  running = false;

  const list = await processes.list();
  console.log('\nFINAL count =', list.length, '| closes performed =', closes);
  console.log(list.length >= 2 ? '*** SUCCESS ***' : '*** FAIL: home app single-instance is not mutex-based ***');
  await processes.killAllPlayers();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
