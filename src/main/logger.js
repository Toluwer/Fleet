'use strict';

/**
 * logger.js — append-only file logging plus an in-memory ring buffer that the
 * Diagnostics page reads. Designed to never throw: logging must not be able to
 * crash the app.
 */

const fs = require('fs');
const path = require('path');

let logDir = null;
let logFile = null;
const RING_MAX = 500;
const ring = [];
const listeners = new Set();

function two(n) { return String(n).padStart(2, '0'); }

function stamp(d) {
  return (
    d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
    ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
  );
}

function dayKey(d) {
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

function configure(baseDir) {
  try {
    logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'fleet-' + dayKey(new Date()) + '.log');
  } catch (_) {
    logDir = null;
    logFile = null;
  }
}

function getLogDir() { return logDir; }
function getLogFile() { return logFile; }

function onEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function write(level, message, detail) {
  const entry = {
    time: stamp(new Date()),
    level: String(level || 'info').toLowerCase(),
    message: String(message == null ? '' : message),
    detail: detail == null ? '' : (typeof detail === 'string' ? detail : safeJson(detail)),
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  // File (best-effort, rotates by day)
  try {
    if (logFile) {
      // Roll the file name over at midnight without restarting the app.
      const want = path.join(logDir, 'fleet-' + dayKey(new Date()) + '.log');
      if (want !== logFile) logFile = want;
      const line = `[${entry.time}] ${entry.level.toUpperCase().padEnd(5)} ${entry.message}` +
        (entry.detail ? ` | ${entry.detail}` : '') + '\n';
      fs.appendFile(logFile, line, () => {});
    }
  } catch (_) { /* ignore */ }

  for (const fn of listeners) {
    try { fn(entry); } catch (_) {}
  }
  return entry;
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch (_) { return String(obj); }
}

const info = (m, d) => write('info', m, d);
const warn = (m, d) => write('warn', m, d);
const error = (m, d) => write('error', m, d);

function recent(limit) {
  if (!limit || limit >= ring.length) return ring.slice();
  return ring.slice(ring.length - limit);
}

function clear() {
  ring.length = 0;
}

module.exports = {
  configure, getLogDir, getLogFile, onEntry,
  write, info, warn, error, recent, clear,
};
