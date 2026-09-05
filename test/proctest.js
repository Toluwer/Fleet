'use strict';
/* Validate in-process Roblox enumeration via koffi (Toolhelp32 + psapi),
   so we never spawn tasklist (which stalls under heavy multi-client boot). */

const koffi = require('koffi');
const k32 = koffi.load('kernel32.dll');

const PE32 = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr', th32ModuleID: 'uint32', cntThreads: 'uint32',
  th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: koffi.array('char16', 260, 'string'),
});

const CreateToolhelp32Snapshot = k32.func('uintptr __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
const Process32FirstW = k32.func('bool __stdcall Process32FirstW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');
const Process32NextW = k32.func('bool __stdcall Process32NextW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');
const CloseHandle = k32.func('int __stdcall CloseHandle(uintptr h)');
const OpenProcess = k32.func('uintptr __stdcall OpenProcess(uint32 a, int b, uint32 c)');
const K32GetProcessMemoryInfo = k32.func('bool __stdcall K32GetProcessMemoryInfo(uintptr Process, void *counters, uint32 cb)');

console.log('sizeof PE32 =', koffi.sizeof(PE32));

function memOf(pid) {
  const h = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return 0;
  const buf = Buffer.alloc(72); buf.writeUInt32LE(72, 0);
  let ws = 0;
  try { if (K32GetProcessMemoryInfo(h, buf, 72)) ws = Number(buf.readBigUInt64LE(16)); } catch (_) {}
  CloseHandle(h);
  return ws;
}

const t = Date.now();
const snap = CreateToolhelp32Snapshot(0x2, 0);
const e = { dwSize: koffi.sizeof(PE32) };
let ok = Process32FirstW(snap, e);
let total = 0;
const roblox = [];
while (ok) {
  total++;
  const name = e.szExeFile;
  if (/^robloxplayerbeta\.exe$/i.test(name)) roblox.push({ pid: e.th32ProcessID, name });
  ok = Process32NextW(snap, e);
}
CloseHandle(snap);
console.log('enumerated', total, 'processes in', Date.now() - t, 'ms');
roblox.forEach(r => console.log('  Roblox pid', r.pid, '| mem', Math.round(memOf(r.pid) / 1048576), 'MB | name', r.name));
console.log('total time', Date.now() - t, 'ms');
