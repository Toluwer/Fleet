'use strict';

// Robust HTTP(S) download helper for the updater.
//
// Node's global fetch (undici) failed in the field with a bare "fetch failed"
// while downloading the installer: it ignores proxy environment variables,
// caps the body at 300 seconds on slow links, buffers everything in memory,
// never retries, and hides the underlying cause. This module streams with the
// plain http/https modules instead: redirects are followed, stalled (not just
// slow) connections are retried, partial downloads resume via Range, proxy
// env vars are honored, and errors carry the real cause.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const { URL } = require('url');

const DEFAULTS = {
  userAgent: 'Fleet-Updater',
  connectTimeoutMs: 20000,
  stallTimeoutMs: 60000,   // no data at all for this long counts as stalled
  maxRedirects: 5,
  retries: 3,
  retryDelayMs: 400,
};

function proxyFromEnv(env) {
  const e = env || process.env;
  const raw = e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy
    || e.HTTP_PROXY || e.http_proxy || '';
  if (!raw) return null;
  try {
    const u = new URL(/^https?:/i.test(raw) ? raw : 'http://' + raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
  } catch (_) { return null; }
}

/** Walk an error's cause chain into one readable line. */
function describeError(err) {
  const parts = [];
  let e = err;
  for (let depth = 0; e && depth < 5; depth++) {
    let msg = String((e && e.message) || e);
    if (e && e.code && msg.indexOf(e.code) < 0) msg += ' (' + e.code + ')';
    if (parts.indexOf(msg) < 0) parts.push(msg);
    e = (e && e.cause) || null;
  }
  return parts.join(' — caused by: ');
}

/** Open one CONNECT tunnel through an HTTP proxy for an https target. */
function connectTunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    const port = Number(target.port || 443);
    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
    });
    req.setTimeout(DEFAULTS.connectTimeoutMs, () => req.destroy(new Error(`proxy connect timeout (${proxy.host})`)));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT rejected (HTTP ${res.statusCode})`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', (err) => reject(err));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * One GET request (no retries, no redirects at this level).
 * Resolves { status, headers, stream } — stream is the response body.
 */
function requestOnce(urlStr, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    const proxy = target.protocol === 'https:' ? o.proxy : null;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const make = (socket) => {
      const isHttps = target.protocol === 'https:';
      const client = isHttps ? https : http;
      const reqOpts = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers: Object.assign({ 'User-Agent': o.userAgent }, o.headers || {}),
      };
      // Plain-http targets go to the proxy as absolute-URI requests.
      if (o.proxy && !isHttps) {
        reqOpts.hostname = o.proxy.hostname;
        reqOpts.port = Number(o.proxy.port || 80);
        reqOpts.path = urlStr;
      } else if (socket) {
        reqOpts.createConnection = () => socket;
      }
      const req = client.request(reqOpts);
      req.setTimeout(o.connectTimeoutMs, () => req.destroy(new Error('connect/response timeout')));
      req.on('response', (res) => {
        req.setTimeout(0); // stall detection handles the body phase
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
      });
      req.on('error', fail);
      req.end();
    };

    if (proxy) {
      connectTunnel(proxy, target).then(make, fail);
    } else {
      make(null);
    }
  });
}

/** 4xx/5xx as a non-retriable (except 5xx/429) error with a clear status. */
function statusError(status) {
  const err = new Error(`HTTP ${status}`);
  err.noRetry = status < 500 && status !== 429;
  return err;
}

/**
 * GET following redirects. Resolves { status, headers, stream, url }.
 * The stream must be consumed (or destroyed) by the caller.
 */
async function get(urlStr, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  let current = String(urlStr);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const res = await requestOnce(current, o);
    const loc = res.headers.location;
    if (loc && [301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
      res.stream.destroy();
      current = new URL(loc, current).toString();
      continue;
    }
    return Object.assign(res, { url: current });
  }
  throw new Error(`too many redirects (>${o.maxRedirects})`);
}

/** GET a small resource fully into memory (latest.yml). */
async function getToBuffer(urlStr, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  let lastErr = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      const res = await get(urlStr, o);
      if (res.status >= 400) {
        res.stream.destroy();
        throw statusError(res.status);
      }
      const chunks = [];
      await new Promise((resolve, reject) => {
        let stall = null;
        const armStall = () => {
          if (stall) clearTimeout(stall);
          stall = setTimeout(() => res.stream.destroy(new Error('download stalled')), o.stallTimeoutMs);
        };
        res.stream.on('data', (c) => { armStall(); chunks.push(c); });
        res.stream.on('end', () => { if (stall) clearTimeout(stall); resolve(); });
        res.stream.on('error', reject);
        armStall();
      });
      return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), url: res.url };
    } catch (err) {
      lastErr = err;
      if (err && err.noRetry) throw err;
      if (attempt < o.retries) await new Promise(r => setTimeout(r, o.retryDelayMs * (attempt + 1)));
    }
  }
  throw new Error(`GET failed after ${o.retries + 1} attempts: ${describeError(lastErr)}`);
}

/**
 * Stream a download to a file. When the destination already exists, the
 * download resumes from its current size via a Range request; a server that
 * answers 200 instead of 206 restarts the file from zero. onProgress receives
 * { received, total, percent } (total null when unknown).
 */
async function downloadToFile(urlStr, destPath, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  let lastErr = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
      const headers = Object.assign({}, o.headers || {});
      if (existing > 0) headers.Range = `bytes=${existing}-`;
      const res = await get(urlStr, Object.assign({}, o, { headers }));
      // Range beyond the end: the file is already complete.
      if (res.status === 416 && existing > 0) {
        res.stream.destroy();
        const cr = String(res.headers['content-range'] || '');
        const total = Number((cr.match(/\/(\d+)/) || [])[1] || 0);
        if (!total || existing >= total) return { received: existing, total: existing, url: res.url };
      }
      if (res.status >= 400) {
        res.stream.destroy();
        throw statusError(res.status);
      }
      const append = res.status === 206 && existing > 0;
      if (!append && existing > 0) fs.writeFileSync(destPath, Buffer.alloc(0));
      const totalHeader = res.headers['content-length'];
      const total = totalHeader ? Number(totalHeader) + (append ? existing : 0) : null;
      let received = append ? existing : 0;
      let lastEmit = 0;
      await new Promise((resolve, reject) => {
        let stall = null;
        const armStall = () => {
          if (stall) clearTimeout(stall);
          stall = setTimeout(() => res.stream.destroy(new Error('download stalled (no data for '
            + Math.round(o.stallTimeoutMs / 1000) + 's)')), o.stallTimeoutMs);
        };
        const out = fs.createWriteStream(destPath, { flags: append ? 'a' : 'w' });
        out.on('error', reject);
        out.on('finish', () => resolve());
        res.stream.on('data', (c) => {
          armStall();
          received += c.length;
          const now = Date.now();
          if (o.onProgress && (now - lastEmit >= 250 || (total != null && received === total))) {
            lastEmit = now;
            o.onProgress({ received, total, percent: total ? Math.floor(received / total * 100) : null });
          }
        });
        res.stream.on('error', (err) => { if (stall) clearTimeout(stall); out.destroy(); reject(err); });
        res.stream.on('end', () => { if (stall) clearTimeout(stall); });
        res.stream.pipe(out);
        armStall();
      });
      if (total != null && received !== total) throw new Error(`truncated download (${received} of ${total} bytes)`);
      return { received, total, url: res.url };
    } catch (err) {
      lastErr = err;
      if (err && err.noRetry) throw err;
      if (attempt < o.retries) await new Promise(r => setTimeout(r, o.retryDelayMs * (attempt + 1)));
    }
  }
  throw new Error(`download failed after ${o.retries + 1} attempts: ${describeError(lastErr)}`);
}

module.exports = { get, getToBuffer, downloadToFile, proxyFromEnv, describeError, DEFAULTS };
