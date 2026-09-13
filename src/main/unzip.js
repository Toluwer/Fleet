'use strict';

// Minimal, dependency-free ZIP extractor for the in-app self-update.
//
// It exists because the updater must unpack the portable distribution
// (FleetPortable_x.y.z_x64.zip, produced by PowerShell Compress-Archive)
// without shelling out to an external archiver. Compress-Archive has two
// quirks the reader has to tolerate:
//   * entry names use backslashes ("Fleet\src\main\x.js"), not forward slashes
//   * local file headers carry zero sizes with a data-descriptor flag set;
//     the central directory holds the authoritative sizes
// Only the two compression methods Compress-Archive can emit are supported:
// stored (0) and deflate (8).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;
const EOCD_SEARCH = 65536 + 22; // max EOCD tail (64 KB comment) + fixed part

function fail(message) {
  const err = new Error(message);
  err.code = 'EBADZIP';
  throw err;
}

/** Finds the End-Of-Central-Directory record and returns { entryCount, cenOffset, cenSize }. */
function locateEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_SEARCH);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const entryCount = buf.readUInt16LE(i + 10);
    const cenSize = buf.readUInt32LE(i + 12);
    const cenOffset = buf.readUInt32LE(i + 16);
    if (i - cenSize < 0) fail('ZIP central directory is misplaced.');
    return { entryCount, cenOffset, cenSize };
  }
  fail('This file is not a ZIP archive (no end record found).');
}

/** Reads one central-directory entry at `pos`; returns the entry plus the next position. */
function readCentralEntry(buf, pos) {
  if (buf.readUInt32LE(pos) !== CEN_SIGNATURE) fail('ZIP central directory is corrupt.');
  const method = buf.readUInt16LE(pos + 10);
  const flags = buf.readUInt16LE(pos + 12);
  const crc32 = buf.readUInt32LE(pos + 16);
  const compressedSize = buf.readUInt32LE(pos + 20);
  const uncompressedSize = buf.readUInt32LE(pos + 24);
  const nameLen = buf.readUInt16LE(pos + 28);
  const extraLen = buf.readUInt16LE(pos + 30);
  const commentLen = buf.readUInt16LE(pos + 32);
  const externalAttrs = buf.readUInt32LE(pos + 38);
  const localOffset = buf.readUInt32LE(pos + 42);
  const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
  return {
    method, flags, crc32, compressedSize, uncompressedSize, externalAttrs, localOffset, name,
    next: pos + 46 + nameLen + extraLen + commentLen,
  };
}

/** Skips a local file header; returns the offset where the file data starts. */
function localDataOffset(buf, entry) {
  const pos = entry.localOffset;
  if (buf.readUInt32LE(pos) !== LOC_SIGNATURE) fail('ZIP local header is corrupt.');
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  return pos + 30 + nameLen + extraLen;
}

/** Directory detection: trailing separator, MS-DOS directory bit, or a Unix
 *  mode with the directory flag set in the external attributes. */
function isDirectoryEntry(entry) {
  const name = entry.name;
  if (name.endsWith('/') || name.endsWith('\\')) return true;
  const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
  const dosAttrs = entry.externalAttrs & 0xff;
  return (unixMode & 0x4000) !== 0 || (dosAttrs & 0x10) !== 0;
}

/** Normalizes an entry name to a safe relative path, or null when it must be skipped.
 *  Rejects path traversal (".."), absolute paths and drive letters outright. */
function safeRelativePath(rawName) {
  const normalized = String(rawName || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  if (!normalized || normalized.endsWith('/')) return null; // directory marker
  const parts = normalized.split('/').filter(p => p.length > 0 && p !== '.');
  if (parts.some(p => p === '..')) fail(`Refusing to extract a path that escapes the target folder: ${rawName}`);
  const joined = parts.join('/');
  if (/^[a-zA-Z]:/.test(joined) || joined.startsWith('/')) fail(`Refusing to extract an absolute path: ${rawName}`);
  return joined;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Decompresses one entry's payload using central-directory sizes. */
function readEntryData(buf, entry) {
  const start = localDataOffset(buf, entry);
  const end = start + entry.compressedSize;
  if (end > buf.length) fail(`ZIP entry is truncated: ${entry.name}`);
  const raw = buf.slice(start, end);
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  fail(`Unsupported compression method ${entry.method} for ${entry.name}.`);
}

/** Lists entry names (forward-slash normalized) without touching the disk. */
function listEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = locateEocd(buf);
  const names = [];
  let pos = eocd.cenOffset;
  for (let i = 0; i < eocd.entryCount; i++) {
    const entry = readCentralEntry(buf, pos);
    names.push(entry.name);
    pos = entry.next;
  }
  return names;
}

/**
 * Extracts `zipPath` into `destDir`.
 *
 * Options:
 *   stripRoot <string>  when every file lives under one root folder
 *                       ("Fleet/..."), pass it to drop that prefix
 *   onEntry    <fn>     called with (relativePath, bytes) for each file
 *                       before it is written (test hook)
 * Returns the list of written relative paths.
 */
function extractZip(zipPath, destDir, options) {
  const opts = options || {};
  const buf = fs.readFileSync(zipPath);
  const eocd = locateEocd(buf);
  const written = [];
  fs.mkdirSync(destDir, { recursive: true });

  let pos = eocd.cenOffset;
  for (let i = 0; i < eocd.entryCount; i++) {
    const entry = readCentralEntry(buf, pos);
    pos = entry.next;
    if (isDirectoryEntry(entry)) continue;

    let relative = safeRelativePath(entry.name);
    if (relative == null) continue;
    if (opts.stripRoot) {
      const prefix = String(opts.stripRoot).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      if (relative === prefix.slice(0, -1)) continue;
      if (!relative.startsWith(prefix)) continue; // outside the root we were told to take
      relative = relative.slice(prefix.length);
    }
    if (!relative) continue;

    let data;
    try {
      data = readEntryData(buf, entry);
    } catch (err) {
      if (err && err.code === 'EBADZIP') throw err;
      fail(`Could not decompress ${entry.name}: ${err.message}`);
    }
    if (entry.crc32 && crc32(data) !== entry.crc32) {
      fail(`Checksum mismatch for ${entry.name} - the update file is corrupt.`);
    }
    if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
      fail(`Size mismatch for ${entry.name} - the update file is corrupt.`);
    }

    const target = path.join(destDir, relative.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (opts.onEntry) {
      try { opts.onEntry(relative, data); } catch (_) { /* test hook only */ }
    }
    fs.writeFileSync(target, data);
    written.push(relative);
  }

  if (!written.length) fail('The archive contains no files.');
  return written;
}

module.exports = { extractZip, listEntries, safeRelativePath, locateEocd, crc32 };
