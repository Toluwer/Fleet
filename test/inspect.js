'use strict';
/* Drives a running Fleet (launched with --remote-debugging-port=9222):
   reports rendered-DOM facts, can reload / navigate / click / scroll, and
   saves a real PNG screenshot of the page. Uses Node's built-in fetch + WebSocket.

   Flags:
     --reload          reload the page first (pick up CSS/JS edits)
     --view=NAME       click the nav button for a view (instances|profiles|...)
     --click=ACTION    click an element with [data-action="ACTION"]
     --scroll=N        set .content scrollTop to N before the screenshot
     --out=name.png    screenshot filename (default shot.png)
*/

const fs = require('fs');
const path = require('path');

const PORT = 9222;
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const a = args.find(x => x.startsWith('--' + name));
  if (!a) return dflt;
  const eq = a.indexOf('=');
  return eq === -1 ? true : a.slice(eq + 1);
};
const doReload = !!flag('reload', false);
const view = flag('view', null);
const click = flag('click', null);
const scroll = flag('scroll', null);
const out = flag('out', 'shot.png');

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
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const send = cdp(ws);
  await send('Runtime.enable');
  await send('Page.enable');

  if (doReload) { await send('Page.reload', { ignoreCache: true }); await wait(1600); }
  if (view) {
    await send('Runtime.evaluate', { expression: `document.querySelector('#nav button[data-view="${view}"]').click()`, returnByValue: true });
    await wait(700);
  }
  if (click) {
    await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector('[data-action="${click}"]'); if(el)el.click(); return !!el;})()`, returnByValue: true });
    await wait(1200);
  }
  if (scroll != null && scroll !== false) {
    await send('Runtime.evaluate', { expression: `document.querySelector('.content').scrollTop=${parseInt(scroll, 10) || 0}`, returnByValue: true });
    await wait(250);
  }

  const expr = `(() => {
    const q = s => document.querySelector(s);
    const row = q('.irow');
    return {
      title: document.title,
      h1: (q('.page-head h1') || {}).textContent || null,
      activeView: q('#nav button.active') ? q('#nav button.active').getAttribute('data-view') : null,
      lock: (q('#lock-text') || {}).textContent,
      navCount: (q('#nav-count') || {}).textContent,
      instanceRows: document.querySelectorAll('.irow').length,
      firstRow: row ? row.innerText.replace(/\\s+/g,' ').trim().slice(0,120) : null,
      profileCards: document.querySelectorAll('.pcard').length,
      settingRows: document.querySelectorAll('.setting').length,
      logLines: document.querySelectorAll('.logline').length,
      jsErrors: window.__err || null
    };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('FACTS ' + (view || 'instances') + ':\n' + JSON.stringify(r.result.result.value, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    const p = path.join(__dirname, out);
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log('Saved: ' + p);
  }
  ws.close();
}
main().catch(e => { console.error('inspect failed:', e.message); process.exit(1); });
