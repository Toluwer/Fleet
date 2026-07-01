# Build & Run

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Windows     | 10 or 11 (x64) | Fleet is Windows-only (uses Win32 APIs). |
| Node.js     | 18 or newer | Ships with npm. Tested on Node 24. |
| npm         | 9+ | Comes with Node. |
| Roblox      | any recent | The desktop player (`RobloxPlayerBeta.exe`) must be installed to launch/test. |

Internet access is needed for the first `npm install` (it downloads Electron and the koffi prebuilt binary).

## Dependencies

Runtime:

- **koffi** `^2.9` — modern, prebuilt FFI used to call the Win32 APIs (handle enumeration, `DuplicateHandle`, window focus). No native compilation/node-gyp required.

Build / dev:

- **electron** `^33` — the desktop runtime (provides the native-framed window).
- **electron-builder** `^25` — packages the NSIS installer.

There are **no other production dependencies**. Process enumeration, the multi-instance handle work and window focus all go through koffi; registry read uses `reg`, termination uses `taskkill`, path isolation uses `cmd mklink /J`, and account sessions use Electron's built-in `safeStorage` (DPAPI) + `fetch`. Storage is plain JSON via Node `fs`.

## Install

```bash
git clone <repo>  # or copy the folder
cd Fleet
npm install
```

> If Electron's binary fails to download (a partial/corrupt cache), clear it and retry:
> ```bash
> # PowerShell
> Remove-Item "$env:LOCALAPPDATA\electron\Cache" -Recurse -Force
> Remove-Item node_modules\electron\dist -Recurse -Force
> node node_modules\electron\install.js
> ```

## Run from source

```bash
npm start
```

This launches `electron .` which loads `src/main/main.js`.

To see renderer console output in the terminal, set `ELECTRON_ENABLE_LOGGING=1` before `npm start`.

## Regenerate the icon / logo

The app icon (`build/icon.ico`) and PNG (`assets/icon.png`) are generated from the Fleet "stacked clients" mark with GDI+:

```bash
npm run make-icon
```

(`scripts/make-icon.ps1` renders a master 256×256 bitmap, downscales to 16/24/32/48/64/128/256, and assembles a multi-resolution `.ico` with PNG frames.)

## Build a standalone Fleet.exe (recommended)

```bash
npm run build     # -> dist\Fleet\Fleet.exe  (portable; run or zip the folder)
```

`scripts/build-portable.ps1` copies the Electron runtime, renames the binary to **`Fleet.exe`**, stages the app (`src`, `build`, and the single runtime dep `koffi`) into `resources\app`, and applies the icon + version metadata with `rcedit`. The result is a self-contained, correctly-named app — running it shows up as **`Fleet.exe`** in Task Manager (not `electron.exe`).

## Package the official installer

```bash
npm run dist      # branded NSIS installer -> dist\FleetInstaller.exe
npm run pack      # unpacked app only    -> dist\win-unpacked\
```

`FleetInstaller.exe` is intentionally versionless: every GitHub release uses the same asset name, so the permanent latest-download URL stays stable. The installed app reads `latest.yml`, downloads updates in the background, and installs a ready update on restart/exit.

electron-builder settings live in the `build` block of `package.json` (`appId: com.toluwa.fleet`, `productName: Fleet`, `executableName: Fleet`, branded NSIS per-user target with Fleet icons/shortcuts, GitHub auto-update metadata, and `asarUnpack` so koffi's native `.node` loads at runtime).

> **Note:** electron-builder downloads a `winCodeSign` helper and extracts macOS symlinks, which fails on Windows without **Developer Mode** or an **elevated** shell ("A required privilege is not held by the client"). If `npm run dist`/`pack` fails there, either enable Developer Mode (Settings → For developers) / run elevated, or just use `npm run build` above — it needs no signing helper.

## Run the tests

```bash
npm run selftest                 # headless functional tests of the service layer
FLEET_LIVE=1 npm run selftest    # also launches + cleans up one real client
```

See [TESTING.md](TESTING.md) for the multi-instance harnesses (`test/multitest*.js`) and the CDP-based UI inspector (`test/inspect.js`).

## Project layout

```
Fleet/
  package.json          app manifest + electron-builder config
  build/icon.ico        app icon (generated)
  assets/               logo.svg, icon.png
  scripts/make-icon.ps1 icon generator
  src/
    main/               Electron main process (all OS access)
      main.js           lifecycle, splash + main window, wiring
      native.js         koffi Win32 layer (enumeration, handle-closing, focus)
      clones.js         per-instance directory junctions (path isolation)
      guard.js          background loop that clears shared singletons
      launcher.js       spawns clients (detached, unref'd)
      accounts.js       Roblox login, encrypted sessions, auth tickets
      processes.js      in-process client enumeration / taskkill
      monitor.js        live instance tracking
      roblox.js         Roblox path detection
      store.js          settings / history (atomic JSON)
      logger.js         file log + ring buffer
      ipc.js            wires renderer requests to services
    preload/preload.js  the only renderer<->main bridge (contextBridge)
    renderer/           pure UI (splash.html, index.html, styles.css, app.js)
  docs/                 this documentation
  test/                 selftest + multi-instance harnesses + UI inspector
```
