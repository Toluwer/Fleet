'use strict';
/* Minimal-close test: close guards only briefly around each launch, then STOP,
   so running instances are not destabilized. Expect 2 to survive. */

const processes = require('../src/main/processes');
const launcher = require('../src/main/launcher');
const native = require('../src/main/native');
const roblox = require('../src/main/roblox');

const wait = ms => new Promise(r => setTimeout(r, ms));

// Close guards repeatedly for `durationMs`, then resolve.
async function clearFor(getPids, durationMs, intervalMs) {
  const end = Date.now() + durationMs;
  let total = 0;
  while (Date.now() < end) {
    const r = native.closeRobloxSingletonHandles(getPids());
    total += r.closed || 0;
    await wait(intervalMs);
  }
  return total;
}

(async () => {
  native.init();
  const loc = roblox.locate({ autoDetect: true });
  let pidCache = [];
  const refreshPids = async () => { pidCache = (await processes.list()).map(p => p.pid); return pidCache; };

  console.log('launch #1:', launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' }));
  await wait(8000);
  await refreshPids();
  console.log('after #1 boot:', pidCache);

  // Briefly clear guards so #2 can pass its startup check, then STOP.
  console.log('launch #2 + brief clear...');
  launcher.launchInstance({ playerPath: loc.playerPath, mode: 'client' });
  // refresh pids in background during the clear
  const refresher = setInterval(refreshPids, 400);
  const closed = await clearFor(() => pidCache, 3500, 120); // ~3.5s of gentle closing
  clearInterval(refresher);
  console.log('clearing done, handles closed =', closed);

  // Now observe survival WITHOUT any further closing
  for (let s = 1; s <= 8; s++) {
    await wait(1500);
    const live = (await processes.list());
    console.log(`t+${(s * 1.5).toFixed(1)}s | count=${live.length} | pids=${live.map(p => p.pid).join(',')}`);
  }
  const list = await processes.list();
  console.log('\nFINAL count =', list.length);
  list.forEach(p => console.log('  PID ' + p.pid + ' | ' + Math.round(p.memBytes / 1048576) + 'MB | win="' + p.windowTitle + '"'));
  console.log(list.length >= 2 ? '*** SUCCESS: multiple instances coexist & persist ***' : '*** FAIL ***');
  await processes.killAllPlayers();
  process.exit(list.length >= 2 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
