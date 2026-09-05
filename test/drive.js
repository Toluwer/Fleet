'use strict';
/* Calls a window.fleet.* method on the running Fleet via CDP and prints the
   awaited result. Usage: node test/drive.js "launch.quick" 2   */

const PORT = 9222;
const methodPath = process.argv[2];           // e.g. "launch.quick"
const arg = process.argv[3];                  // optional argument (number or string)

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  return (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const send = cdp(ws);
  await send('Runtime.enable');
  let argExpr = 'undefined';
  if (arg !== undefined) {
    const t = arg.trim();
    if (t.startsWith('{') || t.startsWith('[')) argExpr = t;            // raw JSON object/array
    else argExpr = isNaN(Number(arg)) ? JSON.stringify(arg) : Number(arg);
  }
  const expr = `window.fleet.${methodPath}(${argExpr})`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result.result.value, null, 2));
  ws.close();
}
main().catch(e => { console.error('drive failed:', e.message); process.exit(1); });
