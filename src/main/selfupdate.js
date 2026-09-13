'use strict';

// In-app self-update mechanics (the pieces that are testable on any OS):
//
//   resolveInstallDir  where the running Fleet lives (node.exe sits in the
//                      install folder next to Fleet.exe)
//   applyUpdate        swaps the staged new version over the install folder
//                      WHILE FLEET IS STILL RUNNING, then writes a result
//                      file the new version reads on its next start
//   readResultFile     that handshake (survives the restart, unlike a toast)
//
// There is deliberately NO detached helper process anymore. The previous
// design armed a hidden script interpreter and closed the window; when
// security software or policy killed that helper — its signature is "a
// script host running a script out of AppData" — the app was already
// gone and the update silently did nothing. The VS Code / Chrome technique
// used here needs no helper: Windows will not let you overwrite a file it
// holds open, but it happily lets you RENAME it. Every in-use file
// (Fleet.exe, node.exe, loaded native modules) is renamed aside to
// "<name>.fleet-old" and the new copy takes its place immediately; the
// retired files are deleted by the new version at startup, once the
// processes holding them are gone.
//
// Because the whole swap runs inside the app, every failure is an error the
// renderer can show while the window is still alive — and by the time Fleet
// restarts, the files on disk are already the new version, so an interrupted
// restart can never wedge the app on the old one.

const fs = require('fs');
const path = require('path');

const RETIRED_SUFFIX = '.fleet-old';
const STAGED_SUFFIX = '.fleet-new';
// Kept across updates: written by the installer, not part of the portable
// package, and Add/Remove Programs points at it.
const PRESERVED_FILES = new Set(['uninstall.exe'].map((n) => n.toLowerCase()));

function resolveInstallDir(execPath) {
  const dir = path.dirname(String(execPath || ''));
  if (!dir) return { ok: false, error: 'Could not determine the install folder.' };
  const exe = path.join(dir, 'Fleet.exe');
  if (!fs.existsSync(exe)) {
    return {
      ok: false,
      error: 'Automatic updates only work in an installed (or portable) copy of Fleet - this build runs from a development folder.',
    };
  }
  return { ok: true, dir };
}

/* ------------------------- file tree utilities ------------------------- */

/** Recursive file list of `dir`, as Map<lowercased relative path, absolute>. */
function listTree(dir) {
  const out = new Map();
  const walk = (current, prefix) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? prefix + path.sep + entry.name : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.set(rel.toLowerCase(), { abs, rel });
    }
  };
  walk(dir, '');
  return out;
}

function isRetiredOrStaged(name) {
  return name.endsWith(RETIRED_SUFFIX) || name.endsWith(STAGED_SUFFIX);
}

/**
 * The heart of the updater: swap the staged tree over the install folder
 * while Fleet is running — in three phases:
 *
 *   A. STAGE: every new file is copied beside its destination as
 *      "<name>.fleet-new". Any failure here (disk full, permissions)
 *      aborts with the install folder completely untouched.
 *   B. COMMIT: per file, the old name is renamed aside to
 *      "<name>.fleet-old" (renaming a file Windows holds open is allowed,
 *      so running exes and loaded modules step aside instead of blocking)
 *      and the staged copy takes the real name. Renames inside one folder
 *      essentially never fail, so the commit is effectively atomic.
 *   C. SWEEP: files that only existed in the old version are removed
 *      (except the uninstaller and retired/staged leftovers), Fleet.exe is
 *      sanity-checked, and everything else is left for the Rust startup
 *      sweep, which deletes the retired files once nothing holds them.
 *
 * Returns { ok, copied, retired: [names], removed, error? }.
 */
function applyStaged(stageDir, installDir) {
  const staged = listTree(stageDir);
  if (!staged.size) return { ok: false, error: 'The staged update is empty - nothing to install.' };
  if (!staged.has('fleet.exe')) {
    return { ok: false, error: 'The staged update does not contain Fleet.exe - refusing to touch the install.' };
  }
  if (!fs.existsSync(path.join(installDir, 'Fleet.exe'))) {
    return { ok: false, error: `Fleet.exe was not found in ${installDir} - the install looks broken.` };
  }

  // Phase A - stage everything before touching anything.
  const plan = [];
  for (const { abs, rel } of staged.values()) {
    const dest = path.join(installDir, rel);
    const beside = dest + STAGED_SUFFIX;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, beside);
      plan.push({ rel, dest, beside });
    } catch (err) {
      for (const item of plan) {
        try { fs.rmSync(item.beside, { force: true }); } catch (_) { /* best effort */ }
      }
      return { ok: false, error: `Could not prepare ${rel} for the update: ${err.message}` };
    }
  }

  // Phase B - commit: retire the old names, promote the staged ones.
  let copied = 0;
  const retired = [];
  let firstError = null;
  for (const item of plan) {
    try {
      const aside = item.dest + RETIRED_SUFFIX;
      try { fs.rmSync(aside, { force: true }); } catch (_) { /* stale retire */ }
      try {
        fs.renameSync(item.dest, aside);
        retired.push(item.rel + RETIRED_SUFFIX);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      fs.renameSync(item.beside, item.dest);
      copied++;
    } catch (err) {
      if (!firstError) firstError = `Could not replace ${item.rel}: ${err.message}`;
      try { fs.rmSync(item.beside, { force: true }); } catch (_) { /* best effort */ }
    }
  }
  if (firstError) {
    return { ok: false, error: `${firstError} (${copied} of ${plan.length} files were installed - the rest is untouched).`, copied, retired };
  }

  // Phase C - sweep: remove files the new version no longer has.
  let removed = 0;
  const existing = listTree(installDir);
  for (const { abs, rel } of existing.values()) {
    const base = path.basename(rel).toLowerCase();
    if (PRESERVED_FILES.has(base)) continue;
    if (isRetiredOrStaged(base)) continue;
    if (staged.has(rel.toLowerCase())) continue;
    try {
      fs.rmSync(abs, { force: true });
      removed++;
    } catch (_) { /* locked: leave it; it disappears on the next sweep */ }
  }
  // Best-effort prune of directories the new version no longer has.
  try { pruneEmptyDirs(installDir, staged); } catch (_) { /* cosmetic */ }

  // Verify the swap landed before anyone restarts into it.
  try {
    const st = fs.statSync(path.join(installDir, 'Fleet.exe'));
    if (st.size < 500 * 1024) {
      return { ok: false, error: 'The new Fleet.exe looks truncated (size check failed) - the update was not completed.' };
    }
  } catch (err) {
    return { ok: false, error: `Fleet.exe is missing after the swap: ${err.message}` };
  }

  return { ok: true, copied, retired, removed };
}

/** Remove empty directories below `root` that the new manifest does not have. */
function pruneEmptyDirs(root, manifest) {
  const keep = new Set();
  for (const rel of manifest.keys()) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.') { keep.add(dir.toLowerCase()); dir = path.dirname(dir); }
  }
  const dirs = [];
  const walk = (current, prefix) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isRetiredOrStaged(entry.name.toLowerCase())) continue;
      const rel = prefix ? prefix + path.sep + entry.name : entry.name;
      dirs.push({ abs: path.join(current, entry.name), rel });
      walk(path.join(current, entry.name), rel);
    }
  };
  walk(root, '');
  for (const { abs, rel } of dirs.sort((a, b) => b.rel.length - a.rel.length)) {
    if (keep.has(rel.toLowerCase())) continue;
    try { fs.rmdirSync(abs); } catch (_) { /* not empty / locked */ }
  }
}

/** Unpacks the verified portable zip into `stageDir`, tolerating both zip
 *  layouts (a single "Fleet/" root, or files at the top level) and refusing
 *  anything that does not look like a Fleet distribution. */
function stageZip(zipPath, stageDir) {
  const unzip = require('./unzip');
  let names;
  try {
    names = unzip.listEntries(zipPath);
  } catch (err) {
    return { ok: false, error: `The downloaded update is not a valid archive: ${err.message}` };
  }
  const files = names.filter(n => !n.endsWith('/') && !n.endsWith('\\'));
  if (!files.length) return { ok: false, error: 'The downloaded update archive is empty.' };
  const normalized = files.map(n => n.replace(/\\/g, '/'));
  const hasRoot = normalized.every(n => n === 'Fleet' || n.startsWith('Fleet/'));
  const strip = hasRoot ? 'Fleet' : null;
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    unzip.extractZip(zipPath, stageDir, strip ? { stripRoot: strip } : {});
  } catch (err) {
    return { ok: false, error: `Could not unpack the update: ${err.message}` };
  }
  if (!fs.existsSync(path.join(stageDir, 'Fleet.exe'))) {
    return { ok: false, error: 'The downloaded update does not contain Fleet.exe - it may be a corrupt download. Try again.' };
  }
  return { ok: true, stageDir, strip };
}

/**
 * Applies a staged update: swap the files (Fleet still running), then write
 * the result file the next start reads. Returns { ok, retired?, error? }.
 *
 * Options: { installDir, stageDir, resultPath, version }.
 */
function applyUpdate(opts) {
  const options = opts || {};
  const installDir = String(options.installDir || '');
  const stageDir = String(options.stageDir || '');
  const resultPath = String(options.resultPath || '');
  const version = String(options.version || '');
  if (!installDir || !stageDir) {
    return { ok: false, error: 'The updater needs the install and staging folders.' };
  }

  const applied = applyStaged(stageDir, installDir);
  if (!applied.ok) return applied;

  if (resultPath) {
    try {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: true,
        to: version,
        at: new Date().toISOString(),
        how: 'in-place',
        retired: applied.retired.length,
      }) + '\n', 'utf8');
    } catch (err) {
      // The toast is best-effort; the swap itself already succeeded.
      require('./logger').warn('Could not write the update result file', err && err.message);
    }
  }
  return applied;
}

/** Reads (and deletes) the result file. Returns the parsed result
 *  ({ ok, to, at, error }) or null when there is nothing to report. */
function readResultFile(resultPath) {
  try {
    if (!fs.existsSync(resultPath)) return null;
    const raw = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      fs.unlinkSync(resultPath);
      return parsed;
    }
    fs.unlinkSync(resultPath);
  } catch (_) { /* unreadable result is not fatal */ }
  return null;
}

module.exports = {
  resolveInstallDir,
  applyStaged,
  applyUpdate,
  stageZip,
  readResultFile,
  // exported for tests
  _internals: { listTree, RETIRED_SUFFIX, STAGED_SUFFIX, isRetiredOrStaged, pruneEmptyDirs },
};
