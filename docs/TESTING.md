# Fleet Testing

## Current Baseline

Last verified locally:

```text
npm run selftest
RESULT: 111 passed, 0 failed, 111 total
```

The suite covers the backend service layer, renderer-facing API shape, installer invariants, account/session logic, game and people search behavior, playtime tracking, and Tauri packaging expectations.

## Test Commands

```powershell
npm run selftest
npm run test:ui
```

Live Roblox harnesses:

```powershell
node test/multitest6.js
node test/drive.js
node test/inspect.js
```

The live harnesses launch real Roblox clients. Run them only when it is acceptable for the test machine to open and close Roblox.

## Self-Test Areas

| Area | Coverage |
|------|----------|
| Roblox detection | Registry/filesystem detection, manual path parsing, invalid path rejection. |
| Native layer | `koffi` init, object type discovery, mutex naming, focus and singleton cleanup safety. |
| Store | Settings defaults, clamping, profiles, history, and corrupt preference handling. |
| Launcher | Bad-path behavior, deep-link parsing, account-less install messaging. |
| Accounts | Saved account lifecycle, session expiration behavior, account data normalization. |
| People | Search, profile normalization, presence updates, join action routing. |
| Games | Browse/search, category filtering, advanced server sorting, deep scan behavior. |
| Instances | Process listing, focus/kill/restart API shape, keep-alive behavior. |
| UI contract | Tauri bridge loading, theme behavior, saved sessions, text/markup checks. |
| Packaging | Electron packages removed, Tauri bundle configured, NSIS installer bootstrap configured. |

## Multi-Instance Recipe

The shipped recipe is:

1. Create a per-instance directory junction to the Roblox version folder.
2. Launch each client through its own junction path.
3. Run the global guard to clear only shared `ROBLOX_singleton*` objects.
4. Preserve each client's path-derived `.mtx` mutex.

Older harnesses in `test/multitest*.js` document failed approaches and regression coverage for the working approach.

## Packaging Smoke Checks

Portable layout:

```text
dist/Fleet/Fleet.exe
dist/Fleet/node.exe
dist/Fleet/src/main/...
```

Installer layout:

```text
Fleet.exe
resources/node.exe
_up_/src/main/...
```

Both layouts must start the Node backend successfully.
