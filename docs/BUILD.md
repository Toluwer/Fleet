# Build & Run

## Prerequisites

Windows 10/11 x64 · Node.js 18+ · Rust (MSVC) · Roblox for live testing.

## Commands

```powershell
npm install        # deps
npm start          # run from source (tauri dev)
npm run build      # portable folder -> dist/Fleet (zip it to distribute)
npm run dist       # installer -> dist/FleetInstaller.exe
npm run make-icon  # regenerate icons
npm run selftest
npm run test:ui
```

Live Roblox harnesses (`test/multitest*.js`, `drive.js`, `inspect.js`) launch real clients — run only when that's OK.

## What `npm run dist` does

1. Builds the portable dist via `tauri build`.
2. Builds the custom Win32 installer in `installer/` (Rust + Win32 API, native controls only, version injected via `FLEET_VERSION`).
3. Appends the zipped payload (portable dist + `uninstall.exe` + WebView2 bootstrapper) to the exe.

Installed layout = portable layout + `uninstall.exe`. Installs per-user (HKCU uninstall entry, Start Menu + optional Desktop shortcuts, silent WebView2 setup if missing). `--demo` drives the full flow for automation.

## Publishing a release

The updater reads `latest.yml` from the latest non-draft release and verifies the installer's sha512 — so the feed and the installer must come from the same build.

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`), and the User-Agent in `src/main/people.js` (must match `test/selftest.js`).
2. `npm run dist`, then `scripts/make-release.ps1` → `dist/latest.yml`.
3. Create a draft release for `v<version>`, upload `FleetInstaller.exe` + `latest.yml` (+ portable zip), then publish.

Keep releases in draft until all assets are uploaded — a published release without `latest.yml` breaks update checks. Never ship a bare `Fleet.exe` asset (needs its bundled runtime).

> If re-uploading assets to an existing release, delete the old `latest.yml` asset first — GitHub rejects duplicate names.

CI: `.github/workflows/build-installer.yml` builds everything on a Windows runner if you have no Windows machine.

## Ignored build output

```text
build/  dist/  src-tauri/target/  src-tauri/resources/node.exe
```

## Project layout

```text
package.json        npm scripts
assets/             logo/icon sources
scripts/            build helpers
src/main/           Node service layer
src/renderer/       UI (HTML/CSS/JS)
src-tauri/          Rust Tauri shell
installer/          custom Win32 installer app
docs/ test/         documentation / tests
```
