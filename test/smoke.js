'use strict';
/* Non-disruptive UI smoke test. Attaches to a Fleet instance launched with
   --remote-debugging-port=9222 (use an isolated --user-data-dir so it does not
   collide with an installed Fleet). Verifies:
     1. Games category chips render with "All" default + counts
     2. Server modal sort chips actually reorder the list on switch
     3. Tooltip stays inside the viewport near the right edge (no clip)
   Prints JSON facts. Does not click Join or launch Roblox. */
const PORT = 9222;
const wait = ms => new Promise(r => setTimeout(r, ms));

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise(res => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const send = cdp(ws);
  await send('Runtime.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };

  const facts = {};

  // ---- 1. Games category filter ----
  await evalJs(`document.querySelector('#nav button[data-view="games"]').click()`);
  // wait for browse() to populate
  for (let i = 0; i < 40; i++) { if (await evalJs(`(state.games.list||[]).length > 0`)) break; await wait(400); }
  await wait(300);
  facts.games = await evalJs(`(() => {
    const chips = [...document.querySelectorAll('#games-cats .cat-chip')].map(c => ({
      label: c.textContent.replace(/\\s+/g,' ').trim(), on: c.classList.contains('on'), cat: c.dataset.cat }));
    return { total: state.games.list.length, category: state.games.category, chips };
  })()`);
  // switch to the 2nd category and confirm the grid count changes to that category's count
  facts.gamesSwitch = await evalJs(`(() => {
    const g = state.games; const cats = g.categories || [];
    if (cats.length < 1) return { skipped: 'no categories' };
    const allCount = document.querySelectorAll('#games-grid .game').length;
    const target = cats[0];
    document.querySelector('#games-cats .cat-chip[data-cat="'+CSS.escape(target)+'"]').click();
    const afterCount = document.querySelectorAll('#games-grid .game').length;
    const expected = g.list.filter(x => (x.categories||[]).includes(target)).length;
    // reset to All
    document.querySelector('#games-cats .cat-chip[data-cat="All"]').click();
    return { target, allCount, afterCount, expected, matches: afterCount === expected, backToAll: document.querySelectorAll('#games-grid .game').length };
  })()`);

  // ---- 2. Server modal sort reorders ----
  const placeId = await evalJs(`(() => { const g = (state.games.list||[])[0]; return g ? String(g.placeId) : null; })()`);
  if (placeId) {
    await evalJs(`openServersModal(${JSON.stringify(placeId)}, 'Smoke Test')`);
    for (let i = 0; i < 40; i++) { if (await evalJs(`!!(state.servers && state.servers.list && state.servers.list.length)`)) break; await wait(400); }
    await wait(300);
    facts.servers = await evalJs(`(() => {
      const sv = state.servers; if (!sv) return { skipped: 'no servers state' };
      const topFor = mode => { const el = document.querySelector('.seg-chip[data-sort="'+mode+'"]'); if (el) el.click();
        const row = document.querySelector('.server-row'); return row ? row.querySelector('.server-fill strong').textContent + ' | ' + row.querySelector('.server-meta').textContent.trim() : null; };
      const best = topFor('best'); const ping = topFor('ping'); const space = topFor('space'); const players = topFor('players'); const fps = topFor('fps');
      const uniq = new Set([best, ping, space, players, fps].filter(Boolean)).size;
      return { count: sv.list.length, best, ping, space, players, fps, distinctTops: uniq,
        summary: (document.querySelector('.server-summary')||{}).textContent || null,
        hasRefresh: !!document.querySelector('[data-action="servers-refresh"]'),
        hasJoinBest: !!document.querySelector('[data-action="join-best"]') };
    })()`);
  } else {
    facts.servers = { skipped: 'no placeId' };
  }

  // ---- 3. Tooltip does not clip at the right edge ----
  facts.tooltip = await evalJs(`(() => {
    // put a data-tip button flush against the right edge and hover it
    const b = document.createElement('button');
    b.setAttribute('data-tip', 'Copy place ID');
    b.style.cssText = 'position:fixed;top:120px;right:0;width:30px;height:30px;z-index:5';
    document.body.appendChild(b);
    b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tip = document.querySelector('.tip');
    const r = tip ? tip.getBoundingClientRect() : null;
    const res = { shown: tip ? tip.classList.contains('show') : false, text: tip ? tip.textContent : null,
      right: r ? Math.round(r.right) : null, viewport: window.innerWidth,
      insideViewport: r ? (r.left >= 0 && r.right <= window.innerWidth) : null };
    b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    b.remove();
    return res;
  })()`);

  facts.jsErrors = await evalJs(`window.__err || null`);
  console.log(JSON.stringify(facts, null, 2));
  ws.close();
}
main().catch(e => { console.error('smoke failed:', e.message); process.exit(1); });
