<div align="center">

<img src="assets/icon.png" width="92" alt="Fleet" />

# Fleet

**A clean, minimalist multi-instance launcher and account manager for Roblox.**

Run several Roblox clients at once — signed into different accounts or signed out — and manage them all from one polished, native Windows app.

[**Download FleetInstaller.exe**](https://github.com/Toluwer/Fleet/releases/latest/download/FleetInstaller.exe) — the permanent official installer name. Install once; Fleet checks, downloads, and installs newer releases automatically.

</div>

---

## What it does

Roblox normally lets you run only **one** client at a time. Fleet works around that automatically and gives you a proper control panel for every client on your PC.

- **Launch multiple Roblox clients** — they open as real, separate clients and stay side by side.
- **Account manager + Smart Launch** — sign in once in a real Roblox login window; Fleet stores each login **encrypted on your PC** (Windows DPAPI). Launch several accounts at once using a Place ID, a Roblox game URL, or an exact-server deep link.
- **Saved launch sessions** — save an account group, game/server target, and optional auto-arrange setting, then relaunch the whole setup with one click. Session metadata stays on this PC and never contains login cookies.
- **Games browser** — browse/search experiences, sort by players/rating/name, hide empty games, open or copy Place IDs, browse public servers, and rank servers by best match, lowest ping, or most available space.
- **People explorer** — search users or merge friends across saved accounts, filter by live status, sort by live status/name, inspect detailed public profiles, copy user IDs, and **Join** when Roblox exposes a joinable presence. Background checks patch only the person whose status changed; the page is never continuously refreshed.
- **Live instance manager** — every running client (whether Fleet started it or not) with status dot, PID, window title, memory and start time, refreshed live and reliably even while many clients boot at once.
- **Per-instance tools** — Focus the window, Restart, or End a client; right-click for a context menu (+ Copy PID). Bulk **End all** and **Cleanup** (also clears leftover Roblox crash-handler processes).
- **Automatic Roblox detection** — registry + filesystem, with a manual override + Browse picker.
- **Light, dark, or system theme** — including matching native Windows window controls and readable semantic status colors in both palettes.
- **Launch history**, **Diagnostics** with a live log, **Settings** that persist, and a built-in **Help** page.

A clean custom top bar with the **native** Windows minimize / maximize / close buttons (no title-bar icon), an animated intro splash, smooth transitions, refined typography, and a light/dark monochrome aesthetic throughout.

## How multi-instance actually works

Current Roblox enforces a single client with several named Windows kernel objects: a shared `ROBLOX_singletonEvent` / `ROBLOX_singletonMutex`, **plus a mutex named after the client's exact program path**. Simply "holding the mutex" (the old trick) no longer works — the first client becomes the owner that closes later launches.

Fleet does two things instead:

1. **Path isolation** — it launches each client through its own directory **junction** to the real Roblox version folder. Every instance gets a *unique* program path, so the per-path mutexes never collide. Junctions are reparse points: created instantly, **no files copied**.
2. **A lightweight guard** — closes only the *shared* `ROBLOX_singleton*` objects as they reappear (leaving each instance's own per-path mutex intact, since closing that would destabilise a running client).

See [docs/TECHNICAL.md](docs/TECHNICAL.md) for the full story and the experiments behind it.

## Quick start

```bash
npm install      # installs Electron + koffi
npm start        # run Fleet from source
```

Build a standalone, correctly-named **`Fleet.exe`**:

```bash
npm run build    # -> dist\Fleet\Fleet.exe (portable; run or zip it)
```

Build the branded permanent-name installer:

```bash
npm run dist     # -> dist\FleetInstaller.exe
```

Then: open **Accounts -> Add account** and sign in, go to **Instances**, choose **With account**, select one or more accounts, and click **Launch**. (Or switch to **Signed out** and pick a number.)

Full instructions: [docs/BUILD.md](docs/BUILD.md) · User guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md) · Technical: [docs/TECHNICAL.md](docs/TECHNICAL.md) · Testing: [docs/TESTING.md](docs/TESTING.md)

## Requirements

- **Windows 10 or 11** (x64)
- **Node.js 18+** and npm (to build/run from source)
- **Roblox** installed (`RobloxPlayerBeta.exe`)

## Tech

Electron (native-framed window) · vanilla HTML/CSS/JS renderer · [koffi](https://koffi.dev) FFI for the Win32 calls. Clean main / preload / renderer separation — all OS and auth access lives in the main process and is reached only through a small, explicit `window.fleet` bridge (context isolation on, no Node in the renderer).

## Responsible use

Account sessions are encrypted with Windows DPAPI and stored only on your machine; they never leave it and are never shown in the UI. Run only as many clients as your PC can handle, and follow Roblox's Terms of Use.

## License

MIT
