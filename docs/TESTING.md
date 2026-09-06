# Fleet Testing

## Baseline

```text
npm run selftest
RESULT: 123 passed, 0 failed, 123 total
```

## Commands

```powershell
npm run selftest
npm run test:ui
node test/multitest6.js   # live Roblox harnesses — open real clients
node test/drive.js
node test/inspect.js
```

## Self-test coverage

Detection, native layer (koffi/mutex/focus), store, launcher, accounts, people, games, instances, UI contract, packaging.

## Multi-instance recipe

1. Per-instance junction to the Roblox version folder.
2. Launch each client through its own junction.
3. Guard clears only shared `ROBLOX_singleton*` objects.
4. Per-path `.mtx` mutexes stay intact.

## Layout checks

Portable: `dist/Fleet/` with `Fleet.exe`, `node.exe`, `src/main/`.
Installed: same + `uninstall.exe`. Both must start the Node backend.
