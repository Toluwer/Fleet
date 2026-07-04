'use strict';

const { parentPort, workerData } = require('worker_threads');
const people = require('./people');

function send(value) {
  try {
    parentPort.postMessage(value);
  } catch (_) {
    process.exitCode = 1;
  }
}

try {
  const pid = Number(workerData && workerData.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    send({ ok: false, error: 'Invalid Roblox client PID.' });
  } else {
    send(people.__test.readServerPlayersFromPid(pid, workerData && workerData.options));
  }
} catch (err) {
  send({ ok: false, error: (err && err.message) || 'Server player inspection failed.' });
}
