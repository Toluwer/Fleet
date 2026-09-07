# Build and run

## Prerequisites

Windows 10/11 x64, Node.js 18+, Rust (MSVC), and Roblox for live testing.

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

The live Roblox harnesses (`test/multitest*.js`, `drive.js`, `inspect.js`) open real clients; run them only when that's OK.

## What `npm run dist` does

1. Builds the portable dist with `tauri build`.
2. Builds the custom Win32 installer in `installer/` (Rust + Win32 API, native controls only, version injected via `FLEET_VERSION`).
3. Appends the zipped payload (portable dist + `uninstall.exe` + WebView2 bootstrapper) to the exe.

The installed layout is the portable layout plus `uninstall.exe`. Installs are per-user: HKCU uninstall entry, Start Menu and optional Desktop shortcuts, silent WebView2 setup if it's missing. `--demo` drives the full flow for automation.

## Publishing a release

The updater reads `latest.yml` from the latest non-draft release and verifies the installer's sha512, so the feed and the installer must come from the same build.

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the lockfiles), and the User-Agent in `src/main/people.js`. It must match `test/selftest.js`.
2. `npm run dist`, then `scripts/make-release.ps1` to produce `dist/latest.yml`.
3. Create a draft release for `v<version>`, upload `FleetInstaller.exe`, `latest.yml` and the portable zip, then publish.

Keep a release in draft until all assets are uploaded: a published release without `latest.yml` breaks update checks. Never ship a bare `Fleet.exe` asset, it needs its bundled runtime.

> When re-uploading assets to an existing release, delete the old `latest.yml` asset first; GitHub rejects duplicate names.

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
