# Build & Run

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Windows | 10 or 11 x64 | Fleet is Windows-only because it uses Win32 APIs. |
| Node.js | 18 or newer | Needed for npm scripts and the transitional backend host. |
| npm | 9+ | Comes with Node.js. |
| Rust | stable MSVC toolchain | Required by Tauri. |
| Roblox | current desktop player | Needed for live launch testing. |

Internet access is needed for the first `npm install` and for the Tauri/WebView2 installer bootstrap path.

## Dependencies

Runtime:

- `@tauri-apps/api` for the renderer bridge.
- `koffi` for Win32 FFI while the service layer still runs in Node.

Build/dev:

- `@tauri-apps/cli` for dev, release, and portable builds.
- Rust (cargo) for the custom installer app in `installer/`.
- Rust/Cargo for the Tauri shell.

The app no longer uses Electron or electron-builder.

## Install

```powershell
npm install
```

## Run From Source

```powershell
npm start
```

This runs `tauri dev`. Tauri loads `src/renderer` directly and starts the Rust shell in `src-tauri`. The Rust shell spawns `src/main/tauri-node-host.js` as the transitional backend.

## Regenerate Icons

```powershell
npm run make-icon
```

This updates `assets/icon.png` and `build/icon.ico`. The generated `build` directory is ignored because Tauri uses the committed icons in `src-tauri/icons`.

## Build Portable

```powershell
npm run build
```

Output:

```text
dist/Fleet/Fleet.exe
dist/Fleet/node.exe
dist/Fleet/src/main/...
dist/Fleet/node_modules/...
```

The portable build copies the release Tauri executable, the local Node runtime, the Node service layer, and production dependencies. Zip `dist/Fleet` when distributing a portable build.

## Build Installer

```powershell
npm run dist
```

Output:

```text
dist/FleetInstaller.exe
```

The installer is a custom Win32 application (see `installer/`), not an NSIS
wizard. It is built with plain Rust + the Win32 API and every control on it is
a real native Windows control (BUTTON / EDIT / STATIC / progress bar) with
comctl32 v6 visual styles - nothing is owner-drawn and no chrome is faked.

The flow it shows:

```text
Hello! (fades away) -> Where should Fleet live? [path box + Browse]
-> Confirm -> Ready to install [Install Fleet] -> progress -> done
```

`npm run dist` does three things:

1. Builds the portable distribution (`dist/Fleet`) via `tauri build`.
2. Builds the installer app: `cargo build --release` in `installer/`
   (the Fleet version is injected through `FLEET_VERSION`).
3. Packs the payload - the portable dist plus a payload-less
   `uninstall.exe` and the WebView2 bootstrapper - into a zip and appends it
   to the installer executable (`FLEETSTP` magic + offset trailer).

Installed layout (same as portable, all in one folder):

```text
Fleet.exe
node.exe
src/main/...
node_modules/koffi/...
uninstall.exe
```

The installer writes the standard per-user uninstall entry
(HKCU `...\Uninstall\Fleet`), Start Menu + optional Desktop shortcuts, and
runs the WebView2 bootstrapper silently only when the runtime is missing, so
installing never stalls on a bootstrapper download. `uninstall.exe` is the
same app without a payload: it asks "Remove Fleet?", deletes the program
files (optionally the saved accounts/settings), and cleans the registry.

A `--demo` flag drives the whole flow automatically (used by the CI audit);
`--path=` presets the install folder for automation.

## Publish a Release

Releases live at `https://github.com/Toluwer/Fleet/releases`. The in-app updater
reads `latest.yml` from the **latest non-draft release** and downloads the
`FleetInstaller.exe` asset from it. Because the updater verifies the `sha512`
published in `latest.yml` before running anything it downloads, the feed file
and the installer must be generated from the exact same build.

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (and `Cargo.lock`), and the `User-Agent` string in
   `src/main/people.js` so it matches `test/selftest.js`.
2. Build the installer: `npm run dist`.
3. Generate the update feed: `powershell scripts/make-release.ps1`
   (writes `dist/latest.yml` with the installer's sha512 and size).
4. Create a draft GitHub release for tag `v<version>`, upload
   `FleetInstaller.exe` and `latest.yml` (plus the optional portable zip),
   then publish the release. Publishing promotes it to `releases/latest`,
   which is what existing clients poll. Do not ship a bare `Fleet.exe` asset -
   it needs `node.exe` and the bundled resources beside it, so it only works
   inside the portable zip or an installed copy.

Keep a release in draft until both assets are uploaded: a published release
without `latest.yml` breaks the update check in currently installed clients.

> **v1.5.3 note:** this release was published early (at the maintainer's
> request) with a *transitional* `latest.yml` copied from the 1.5.2 feed, so
> installed 1.5.2 clients kept reporting "up to date" until the real installer
> arrived. The real assets (built by CI) are now attached, and the same
> placeholder-swap rule applies to any future early publish: **delete the
> existing `latest.yml` asset first** (GitHub rejects duplicate asset names),
> then upload the freshly generated `latest.yml` and `FleetInstaller.exe`
> together.

## Building in CI

`.github/workflows/build-installer.yml` builds the same Windows artifacts on a
GitHub-hosted Windows runner (Actions tab → "Build Windows installer" → Run
workflow). It runs the selftest, `npm run dist`, `scripts/make-release.ps1`,
and the portable build, then uploads `FleetInstaller.exe`, `latest.yml`,
and `FleetPortable_<version>_x64.zip` as a workflow artifact.
Download the artifact, verify the `latest.yml` sha512 against the installer,
and attach the files to the GitHub release as described above. This is useful
when no Windows machine is available locally.

## Clean Generated Output

The following paths are generated and ignored:

```text
build/
dist/
src-tauri/target/
src-tauri/resources/node.exe
```

They can be deleted at any time. Rebuild scripts recreate them.

## Tests

```powershell
npm run selftest
npm run test:ui
```

Live Roblox harnesses are available under `test/multitest*.js`; they launch real Roblox clients and clean up what they start.

## Project Layout

```text
Fleet/
  package.json              npm scripts and Tauri dependencies
  assets/                   source logo/icon assets
  scripts/                  build and icon helper scripts
  src/
    main/                   transitional Node service layer
    renderer/               HTML/CSS/JS UI loaded by Tauri
  src-tauri/
    src/                    Rust Tauri shell and command bridge
    icons/                  committed Tauri app icons
    tauri.conf.json         Tauri build configuration
  installer/                the custom Win32 installer app (cargo)
  docs/                     project documentation
  test/                     selftest, UI test, and live harnesses
```
