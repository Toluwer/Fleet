'use strict';

const readline = require('readline');
const path = require('path');
const { makeBackend } = require('./tauri-backend');

const appVersion = process.argv[2] || '1.5.0';
const userData = process.argv[3] || path.join(process.cwd(), '.fleet-data');

const safeStorage = {
  isEncryptionAvailable() { return false; },
  encryptString(value) { return Buffer.from(String(value || ''), 'utf8'); },
  decryptString(buffer) { return Buffer.from(buffer).toString('utf8'); },
};

async function openPath(target) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('explorer', [String(target)], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

async function openExternal(url) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('cmd', ['/c', 'start', '', String(url)], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

async function pickFile() {
  const { spawn } = require('child_process');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    "$dlg.Title = 'Select RobloxPlayerBeta.exe'",
    "$dlg.Filter = 'RobloxPlayerBeta.exe|RobloxPlayerBeta.exe|Executable files (*.exe)|*.exe|All files (*.*)|*.*'",
    "$dlg.FileName = 'RobloxPlayerBeta.exe'",
    "$dlg.CheckFileExists = $true",
    "$dlg.Multiselect = $false",
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Write-Output $dlg.FileName }',
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const picked = out.trim().split(/\r?\n/).filter(Boolean).pop();
      resolve(picked || null);
    });
  });
}

function emit(event, payload) {
  process.stdout.write(JSON.stringify({ event, payload }) + '\n');
}

const backend = makeBackend({
  appVersion,
  userData,
  emit,
  openPath,
  openExternal,
  pickFile,
  safeStorage,
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON: ' + err.message }) + '\n');
    return;
  }

  const id = msg && msg.id;
  const command = msg && msg.command;
  const payload = msg && msg.payload;

  if (command === 'shutdown') {
    try { await backend.shutdown(); } catch (_) {}
    process.stdout.write(JSON.stringify({ id, ok: true, result: { ok: true } }) + '\n');
    process.exit(0);
    return;
  }

  try {
    const result = await backend.invoke(command, payload || {});
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: (err && err.message) || String(err) }) + '\n');
  }
});

rl.on('close', async () => {
  try { await backend.shutdown(); } catch (_) {}
  process.exit(0);
});
