# Fleet testing

## Baseline

```text
npm run selftest
RESULT: 123 passed, 0 failed, 123 total
```

## Commands

```powershell
npm run selftest
npm run test:ui
node test/multitest6.js   # live Roblox harness, opens real clients
node test/drive.js
node test/inspect.js
```

## Selftest coverage

Detection, the native layer (koffi/mutex/focus), store, launcher, accounts, people, games, instances, the UI contract, and packaging.

## Multiple-instance recipe

1. Create a per-instance junction to the Roblox version folder.
2. Launch each client through its own junction.
3. Guard clears only the shared `ROBLOX_singleton*` objects.
4. Per-path `.mtx` mutexes stay intact.

## Layout checks

Portable: `dist/Fleet/` with `Fleet.exe`, `node.exe` and `src/main/`.
Installed: the same plus `uninstall.exe`. Both must start the Node backend.
