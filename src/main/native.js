'use strict';

/**
 * native.js — the Win32 layer that makes multi-instance work.
 *
 * Current Roblox enforces a single client with several named kernel objects,
 * all held inside the running RobloxPlayerBeta process:
 *   - Event  ROBLOX_singletonEvent
 *   - Mutex  ROBLOX_singletonMutex
 *   - Mutex  <full exe path with \ -> _>.mtx     (the per-build guard)
 *
 * While any of those exist, a newly launched client detects it and exits.
 * Holding them does NOT help. The reliable method is to **close those handles
 * inside the running process(es)** so the kernel destroys the named objects;
 * the next launch then starts normally. A short guard loop keeps closing them
 * as they reappear, so every launch opens a new instance.
 *
 * Win32 calls: NtQuerySystemInformation(SystemExtendedHandleInformation),
 * NtQueryObject(ObjectNameInformation), OpenProcess(PROCESS_DUP_HANDLE),
 * DuplicateHandle(DUPLICATE_SAME_ACCESS / DUPLICATE_CLOSE_SOURCE), CloseHandle.
 *
 * All wrapped so a koffi failure degrades gracefully rather than crashing.
 */

const EVENT_NAME = 'ROBLOX_singletonEvent';
const MUTEX_NAME = 'ROBLOX_singletonMutex';

const SystemExtendedHandleInformation = 0x40;
const STATUS_SUCCESS = 0x00000000;
const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
const PROCESS_DUP_HANDLE = 0x0040;
const DUPLICATE_CLOSE_SOURCE = 0x1;
const DUPLICATE_SAME_ACCESS = 0x2;
const ObjectNameInformation = 1;
const SYNCHRONIZE = 0x00100000;
const SW_RESTORE = 9;

// Roblox single-instance guards come in two flavours:
//   - GLOBAL  : fixed names shared by every client (ROBLOX_singletonEvent/Mutex)
//   - PERPATH : a mutex named after the exe path (<path>.mtx)
// Path-isolated launches give each instance its own PERPATH mutex, so we only
// ever close the GLOBAL guards (closing a running instance's own PERPATH mutex
// destabilises it).
const RE_GLOBAL = /ROBLOX_singleton(Event|Mutex)/i;
const RE_PERPATH = /RobloxPlayerBeta\.exe\.mtx/i;
function nameIsGuard(name, scope) {
  if (scope === 'global') return RE_GLOBAL.test(name);
  if (scope === 'perpath') return RE_PERPATH.test(name);
  return RE_GLOBAL.test(name) || RE_PERPATH.test(name);
}

let koffi = null;
let available = false;
let loadError = null;
let typeIndices = null; // { event, mutant }

let NtQuerySystemInformation, NtQueryObject;
let OpenProcess, DuplicateHandle, CloseHandle, GetCurrentProcess, CreateEventW, CreateMutexW, OpenEventW, OpenMutexW;
let CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Module32FirstW, Module32NextW, K32GetProcessMemoryInfo, ReadProcessMemory;
let PE32 = null, PE32_SIZE = 0;
let ME32 = null, ME32_SIZE = 0;
let EnumWindows, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SetForegroundWindow, BringWindowToTop, AllowSetForegroundWindow, EnumWindowsProto;
let GetWindowTextW, GetWindowTextLengthW, IsHungAppWindow, SetWindowPos, SystemParametersInfoW;

function init() {
  if (koffi !== null) return available;
  try {
    koffi = require('koffi');
    const ntdll = koffi.load('ntdll.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');

    NtQuerySystemInformation = ntdll.func('long __stdcall NtQuerySystemInformation(uint SystemInformationClass, void* SystemInformation, uint32 Length, _Out_ uint32* ReturnLength)');
    NtQueryObject = ntdll.func('long __stdcall NtQueryObject(uintptr Handle, uint ObjectInformationClass, void* ObjectInformation, uint32 Length, _Out_ uint32* ReturnLength)');

    OpenProcess = kernel32.func('uintptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
    DuplicateHandle = kernel32.func('int __stdcall DuplicateHandle(uintptr hSourceProcess, uintptr hSourceHandle, uintptr hTargetProcess, void* lpTargetHandle, uint32 dwDesiredAccess, int bInheritHandle, uint32 dwOptions)');
    CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr hObject)');
    GetCurrentProcess = kernel32.func('uintptr __stdcall GetCurrentProcess()');
    CreateEventW = kernel32.func('uintptr __stdcall CreateEventW(void* a, int b, int c, str16 d)');
    CreateMutexW = kernel32.func('uintptr __stdcall CreateMutexW(void* a, int b, str16 c)');
    OpenEventW = kernel32.func('uintptr __stdcall OpenEventW(uint32 a, int b, str16 c)');
    OpenMutexW = kernel32.func('uintptr __stdcall OpenMutexW(uint32 a, int b, str16 c)');

    // Toolhelp + psapi for spawn-free process enumeration (immune to system load,
    // unlike `tasklist`, which stalls while several clients boot at once).
    PE32 = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr', th32ModuleID: 'uint32', cntThreads: 'uint32',
      th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
      szExeFile: koffi.array('char16', 260, 'string'),
    });
    PE32_SIZE = koffi.sizeof(PE32);
    CreateToolhelp32Snapshot = kernel32.func('uintptr __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
    Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');
    Process32NextW = kernel32.func('bool __stdcall Process32NextW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');
    K32GetProcessMemoryInfo = kernel32.func('bool __stdcall K32GetProcessMemoryInfo(uintptr Process, void *counters, uint32 cb)');
    ReadProcessMemory = kernel32.func('bool __stdcall ReadProcessMemory(uintptr hProcess, uintptr lpBaseAddress, void* lpBuffer, uintptr nSize, _Out_ uintptr* lpNumberOfBytesRead)');

    ME32 = koffi.struct('MODULEENTRY32W', {
      dwSize: 'uint32', th32ModuleID: 'uint32', th32ProcessID: 'uint32',
      GlblcntUsage: 'uint32', ProccntUsage: 'uint32', modBaseAddr: 'uintptr',
      modBaseSize: 'uint32', hModule: 'uintptr', szModule: koffi.array('char16', 256, 'string'),
      szExePath: koffi.array('char16', 260, 'string'),
    });
    ME32_SIZE = koffi.sizeof(ME32);
    Module32FirstW = kernel32.func('bool __stdcall Module32FirstW(uintptr hSnapshot, _Inout_ MODULEENTRY32W *lpme)');
    Module32NextW = kernel32.func('bool __stdcall Module32NextW(uintptr hSnapshot, _Inout_ MODULEENTRY32W *lpme)');

    EnumWindowsProto = koffi.proto('bool __stdcall FleetEnumProc(void* hwnd, intptr lparam)');
    EnumWindows = user32.func('bool __stdcall EnumWindows(void* lpEnumFunc, intptr lParam)');
    GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)');
    IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* hWnd)');
    ShowWindow = user32.func('bool __stdcall ShowWindow(void* hWnd, int nCmdShow)');
    SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void* hWnd)');
    BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void* hWnd)');
    AllowSetForegroundWindow = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)');
    GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void* hWnd, void* lpString, int nMaxCount)');
    GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void* hWnd)');
    // IsHungAppWindow is exported by user32 (used by the shell to detect frozen windows).
    try { IsHungAppWindow = user32.func('bool __stdcall IsHungAppWindow(void* hWnd)'); } catch (_) { IsHungAppWindow = null; }
    SetWindowPos = user32.func('bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');
    SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void* pvParam, uint32 fWinIni)');

    available = true;
  } catch (err) {
    available = false;
    loadError = (err && err.message) ? err.message : String(err);
  }
  return available;
}

function isAvailable() { return available; }
function getLoadError() { return loadError; }

/** The per-build mutex name Roblox uses (full exe path, backslashes -> _). */
function exeMutexName(playerPath) {
  if (!playerPath) return null;
  return playerPath.replace(/\\/g, '_') + '.mtx';
}

/** Cheap check: does any single-instance guard currently exist? */
function blockerExists(playerPath, scope) {
  if (!init()) return false;
  const names = [
    { fn: OpenEventW, name: EVENT_NAME },
    { fn: OpenMutexW, name: MUTEX_NAME },
  ];
  if (scope !== 'global') {
    const exe = exeMutexName(playerPath);
    if (exe) names.push({ fn: OpenMutexW, name: exe });
  }
  for (const n of names) {
    try {
      const h = n.fn(SYNCHRONIZE, 0, n.name);
      if (h) { CloseHandle(h); return true; }
    } catch (_) {}
  }
  return false;
}

function querySystemHandles() {
  let size = 1 << 21;
  for (let tries = 0; tries < 14; tries++) {
    const buf = Buffer.alloc(size);
    const ret = [0];
    const status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, size, ret) >>> 0;
    if (status === STATUS_INFO_LENGTH_MISMATCH) { size = Math.max(size * 2, (ret[0] || 0) + (1 << 20)); continue; }
    if (status === STATUS_SUCCESS) return { buf, count: Number(buf.readBigUInt64LE(0)) };
    return null;
  }
  return null;
}

function typeIndexOf(handle) {
  const target = BigInt(handle);
  const me = BigInt(process.pid);
  const res = querySystemHandles();
  if (!res) return null;
  for (let i = 0; i < res.count; i++) {
    const off = 16 + i * 40;
    if (off + 40 > res.buf.length) break;
    if (res.buf.readBigUInt64LE(off + 8) === me && res.buf.readBigUInt64LE(off + 16) === target) {
      return res.buf.readUInt16LE(off + 30);
    }
  }
  return null;
}

/** Determine kernel object-type indices for Event and Mutant on this OS. */
function getTypeIndices() {
  if (typeIndices) return typeIndices;
  let event = null, mutant = null;
  try {
    const e = CreateEventW(null, 0, 0, null); if (e) { event = typeIndexOf(e); CloseHandle(e); }
    const m = CreateMutexW(null, 0, null); if (m) { mutant = typeIndexOf(m); CloseHandle(m); }
  } catch (_) {}
  typeIndices = { event, mutant };
  return typeIndices;
}

/**
 * Close every Roblox single-instance guard handle (event + mutexes) inside the
 * given PIDs, so the kernel destroys the named objects.
 * @returns {{ok:boolean, closed:number, scanned:number, reason?:string}}
 */
function closeRobloxSingletonHandles(pids, scope) {
  if (!init()) return { ok: false, closed: 0, scanned: 0, reason: loadError || 'FFI unavailable' };
  scope = scope || 'all';
  const targets = new Set((pids || []).map(p => BigInt(p)));
  if (targets.size === 0) return { ok: true, closed: 0, scanned: 0 };

  const idx = getTypeIndices();
  const res = querySystemHandles();
  if (!res) return { ok: false, closed: 0, scanned: 0, reason: 'NtQuerySystemInformation failed' };

  const cur = GetCurrentProcess();
  const procs = new Map();
  const openProc = (pid) => {
    if (procs.has(pid)) return procs.get(pid);
    let h = 0;
    try { h = OpenProcess(PROCESS_DUP_HANDLE, 0, Number(pid)); } catch (_) {}
    procs.set(pid, h);
    return h;
  };

  const dupOut = Buffer.alloc(8);
  const nameBuf = Buffer.alloc(2048);
  let closed = 0, scanned = 0;

  try {
    for (let i = 0; i < res.count; i++) {
      const off = 16 + i * 40;
      if (off + 40 > res.buf.length) break;
      const pid = res.buf.readBigUInt64LE(off + 8);
      if (!targets.has(pid)) continue;
      const ti = res.buf.readUInt16LE(off + 30);
      // Only inspect Event/Mutant handles (avoids hang-prone handle types).
      if (idx.event != null && idx.mutant != null && ti !== idx.event && ti !== idx.mutant) continue;

      const src = openProc(pid);
      if (!src) continue;
      const hv = res.buf.readBigUInt64LE(off + 16);
      scanned++;

      dupOut.writeBigUInt64LE(0n, 0);
      let ok = 0;
      try { ok = DuplicateHandle(src, hv, cur, dupOut, 0, 0, DUPLICATE_SAME_ACCESS); } catch (_) { ok = 0; }
      if (!ok) continue;
      const dup = dupOut.readBigUInt64LE(0);

      let isGuard = false;
      try {
        const rl = [0];
        const st = NtQueryObject(dup, ObjectNameInformation, nameBuf, nameBuf.length, rl) >>> 0;
        if (st === STATUS_SUCCESS) {
          const name = nameBuf.subarray(0, rl[0] || nameBuf.length).toString('utf16le');
          if (nameIsGuard(name, scope)) isGuard = true;
        }
      } catch (_) {}
      try { CloseHandle(dup); } catch (_) {}

      if (isGuard) {
        try { if (DuplicateHandle(src, hv, 0, null, 0, 0, DUPLICATE_CLOSE_SOURCE)) closed++; } catch (_) {}
      }
    }
  } finally {
    for (const h of procs.values()) { if (h) { try { CloseHandle(h); } catch (_) {} } }
  }
  return { ok: true, closed, scanned };
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
const TH32CS_SNAPPROCESS = 0x2;
const TH32CS_SNAPMODULE = 0x8;
const TH32CS_SNAPMODULE32 = 0x10;

function workingSetOf(pid) {
  let h = 0;
  try {
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) return 0;
    const buf = Buffer.alloc(72);
    buf.writeUInt32LE(72, 0); // cb
    if (K32GetProcessMemoryInfo(h, buf, 72)) return Number(buf.readBigUInt64LE(16)); // WorkingSetSize
  } catch (_) {} finally {
    if (h) { try { CloseHandle(h); } catch (_) {} }
  }
  return 0;
}

/** Return the base address of the first module matching `moduleName`. */
function moduleBaseOf(pid, moduleName) {
  if (!init()) return 0;
  let snap = 0;
  try {
    snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (!snap) return 0;
    const me = { dwSize: ME32_SIZE };
    const wanted = String(moduleName || '').toLowerCase();
    let ok = Module32FirstW(snap, me);
    while (ok) {
      const mod = String(me.szModule || '').toLowerCase();
      const path = String(me.szExePath || '').toLowerCase();
      if (!wanted || mod === wanted || path.endsWith('\\' + wanted) || path.endsWith('/' + wanted)) {
        return Number(me.modBaseAddr) || 0;
      }
      ok = Module32NextW(snap, me);
    }
  } catch (_) {
    return 0;
  } finally {
    if (snap) { try { CloseHandle(snap); } catch (_) {} }
  }
  return 0;
}

/** Read raw process memory. Returns a Buffer slice or null on failure. */
function readMemory(pid, address, size) {
  if (!init()) return null;
  if (!pid || !address || !size) return null;
  let h = 0;
  try {
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
    if (!h) return null;
    const buf = Buffer.alloc(size);
    const read = [0];
    const ok = ReadProcessMemory(h, Number(address), buf, size, read);
    if (!ok || !read[0]) return null;
    return buf.subarray(0, Number(read[0]));
  } catch (_) {
    return null;
  } finally {
    if (h) { try { CloseHandle(h); } catch (_) {} }
  }
}

/**
 * Spawn-free process enumeration via Toolhelp32. Returns an array of
 * { pid, memBytes } for processes whose image name matches `imageName`, or
 * null if the FFI/snapshot is unavailable (so callers can fall back).
 */
function listProcesses(imageName) {
  if (!init()) return null;
  const re = new RegExp('^' + imageName.replace(/[.]/g, '\\.') + '$', 'i');
  let snap = 0;
  const out = [];
  try {
    snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    const e = { dwSize: PE32_SIZE };
    let ok = Process32FirstW(snap, e);
    if (!ok) return null; // invalid snapshot
    while (ok) {
      if (re.test(e.szExeFile || '')) out.push({ pid: e.th32ProcessID, memBytes: workingSetOf(e.th32ProcessID) });
      ok = Process32NextW(snap, e);
    }
  } catch (_) {
    return null;
  } finally {
    if (snap) { try { CloseHandle(snap); } catch (_) {} }
  }
  return out;
}

/**
 * For the given PIDs, return Map(pid -> { title, responding }) by enumerating
 * top-level windows once. GetWindowTextW does NOT send WM_GETTEXT to other
 * processes, so this never blocks on a busy/loading Roblox client (unlike
 * `tasklist /V`).
 */
function windowInfoForPids(pids) {
  const out = new Map();
  if (!init()) return out;
  const targets = new Set((pids || []).map(p => Number(p)));
  if (targets.size === 0) return out;
  const buf = Buffer.alloc(1024); // up to 511 UTF-16 chars
  let cb = null;
  try {
    const enumProc = (hwnd) => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const pidOut = [0];
        GetWindowThreadProcessId(hwnd, pidOut);
        const pid = pidOut[0];
        if (!targets.has(pid)) return true;
        const n = GetWindowTextW(hwnd, buf, 511);
        if (n > 0) {
          const title = buf.subarray(0, n * 2).toString('utf16le');
          const responding = IsHungAppWindow ? !IsHungAppWindow(hwnd) : true;
          const prev = out.get(pid);
          // Prefer a window that actually has a caption.
          if (!prev || (!prev.title && title)) out.set(pid, { title, responding });
        } else if (!out.has(pid)) {
          out.set(pid, { title: '', responding: true });
        }
      } catch (_) {}
      return true;
    };
    cb = koffi.register(enumProc, koffi.pointer(EnumWindowsProto));
    EnumWindows(cb, 0);
  } catch (_) {
  } finally {
    if (cb) { try { koffi.unregister(cb); } catch (_) {} }
  }
  return out;
}

/** Bring the main visible window of the given PID to the foreground. */
function focusByPid(targetPid) {
  if (!init()) return { ok: false, reason: loadError || 'FFI unavailable' };
  let foundHwnd = null;
  let cb = null;
  try {
    const enumProc = (hwnd) => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const pidOut = [0];
        GetWindowThreadProcessId(hwnd, pidOut);
        if (pidOut[0] === targetPid) { foundHwnd = hwnd; return false; }
      } catch (_) {}
      return true;
    };
    cb = koffi.register(enumProc, koffi.pointer(EnumWindowsProto));
    EnumWindows(cb, 0);
    if (!foundHwnd) return { ok: false, reason: 'No visible window found for PID ' + targetPid };
    try { AllowSetForegroundWindow(0xffffffff); } catch (_) {}
    ShowWindow(foundHwnd, SW_RESTORE);
    BringWindowToTop(foundHwnd);
    const fg = SetForegroundWindow(foundHwnd);
    return { ok: true, foreground: !!fg };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  } finally {
    if (cb) { try { koffi.unregister(cb); } catch (_) {} }
  }
}

/**
 * Tile the main windows of the given PIDs into an even grid across the desktop
 * work area (screen minus taskbar). Great for multi-boxing several clients.
 * @returns {{ok:boolean, tiled:number, cols?:number, rows?:number, reason?:string}}
 */
function tileWindows(pids) {
  if (!init()) return { ok: false, tiled: 0, reason: loadError || 'FFI unavailable' };
  const targets = new Set((pids || []).map(p => Number(p)));
  if (targets.size === 0) return { ok: false, tiled: 0, reason: 'No windows to arrange' };

  const hwndByPid = new Map();
  const buf = Buffer.alloc(512);
  let cb = null;
  try {
    const enumProc = (hwnd) => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const pidOut = [0];
        GetWindowThreadProcessId(hwnd, pidOut);
        const pid = pidOut[0];
        if (!targets.has(pid)) return true;
        const titled = GetWindowTextW(hwnd, buf, 200) > 0;
        const prev = hwndByPid.get(pid);
        // Prefer the captioned (main) window over splash/tool windows.
        if (!prev || (titled && !prev.titled)) hwndByPid.set(pid, { hwnd, titled });
      } catch (_) {}
      return true;
    };
    cb = koffi.register(enumProc, koffi.pointer(EnumWindowsProto));
    EnumWindows(cb, 0);
  } catch (err) {
    return { ok: false, tiled: 0, reason: err.message || String(err) };
  } finally {
    if (cb) { try { koffi.unregister(cb); } catch (_) {} }
  }

  const windows = Array.from(hwndByPid.values()).map(w => w.hwnd);
  const n = windows.length;
  if (!n) return { ok: false, tiled: 0, reason: 'No visible Roblox windows found' };

  // Work area (excludes the taskbar). SPI_GETWORKAREA = 0x0030.
  let left = 0, top = 0, right = 1920, bottom = 1080;
  try {
    const rect = Buffer.alloc(16);
    if (SystemParametersInfoW(0x0030, 0, rect, 0)) {
      left = rect.readInt32LE(0); top = rect.readInt32LE(4);
      right = rect.readInt32LE(8); bottom = rect.readInt32LE(12);
    }
  } catch (_) {}
  const W = Math.max(200, right - left), H = Math.max(200, bottom - top);

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  const FLAGS = 0x4 | 0x10 | 0x40; // NOZORDER | NOACTIVATE | SHOWWINDOW

  let tiled = 0;
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    try {
      ShowWindow(windows[i], SW_RESTORE);
      SetWindowPos(windows[i], 0, left + c * cw, top + r * ch, cw, ch, FLAGS);
      tiled++;
    } catch (_) {}
  }
  return { ok: tiled > 0, tiled, cols, rows };
}

module.exports = {
  EVENT_NAME, MUTEX_NAME,
  init, isAvailable, getLoadError,
  exeMutexName, blockerExists,
  closeRobloxSingletonHandles,
  getTypeIndices,
  listProcesses,
  windowInfoForPids,
  focusByPid,
  tileWindows,
  moduleBaseOf,
  readMemory,
};
