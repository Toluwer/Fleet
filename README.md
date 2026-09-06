<div align="center">

<img src="assets/icon.png" width="92" alt="Fleet" />

# Fleet

**A clean, minimalist multi-instance launcher and account manager for Roblox.**

Run several Roblox clients at once — signed into different accounts or signed out — and manage them all from one polished, native Windows app.

[**Download FleetInstaller.exe**](https://github.com/Toluwer/Fleet/releases/latest/download/FleetInstaller.exe) — the permanent official installer name. Prefer a no-install copy? Grab [**FleetPortable zip**](https://github.com/Toluwer/Fleet/releases/latest) from the latest release and extract it anywhere (it bundles its own runtime, so it runs without installing).

> The standalone `Fleet.exe` asset was removed from releases — it needs the bundled runtime beside it and only works inside the portable zip or an installed copy.

</div>

---

## What it does

Roblox normally lets you run only **one** client at a time. Fleet works around that automatically and gives you a proper control panel for every client on your PC.

- **Launch multiple Roblox clients** — they open as real, separate clients and stay side by side.
- **Account manager + Smart Launch** — sign in through Fleet's Tauri Roblox login window, then launch several accounts at once using a Place ID, a Roblox game URL, or an exact-server deep link.
- **Saved launch sessions** — save an account group, game/server target, and optional auto-arrange setting, then relaunch the whole setup with one click. Session metadata stays on this PC and never contains login cookies.
- **Games browser + Server Intelligence** — browse/search experiences, sort and filter them, then deep-scan public server pages for genuinely busy joinable servers. Rank by best match, ping, space, players, or FPS; combine occupancy/ping/FPS/free-slot filters; inspect quality scores and live analytics; copy exact server IDs; or opt into a 30-second live refresh for only the open server panel.
- **People explorer** — search users or merge friends across saved accounts, filter by live status, sort by live status/name, inspect detailed public profiles, copy user IDs, and **Join** when Roblox exposes a joinable presence. Background checks patch only the person whose status changed; the page is never continuously refreshed.
- **Live instance manager** — every running client (whether Fleet started it or not) with status dot, PID, window title, memory and start time, refreshed live and reliably even while many clients boot at once.
- **Per-instance tools** — Focus the window, Restart, or End a client; right-click for a context menu (+ Copy PID). Bulk **End all** and **Cleanup** (also clears leftover Roblox crash-handler processes).
- **Automatic Roblox detection** — registry + filesystem, with a manual override + Browse picker.
- **Light, dark, or system theme** — including matching native Windows window controls and readable semantic status colors in both palettes.
- **Launch history**, **Diagnostics** with a live log, **Settings** that persist, and a built-in **Help** page.

A clean custom top bar with the **native** Windows minimize / maximize / close buttons (no title-bar logo), an animated intro splash, smooth transitions, refined typography, and a light/dark monochrome aesthetic throughout.

The installer is Fleet's own app too: it says **Hello!**, fades away, asks *where Fleet should live*, and installs with a real progress bar - all with genuine native Windows controls. No wizard pages, no fake drawn buttons.

## How multi-instance actually works

Current Roblox enforces a single client with several named Windows kernel objects: a shared `ROBLOX_singletonEvent` / `ROBLOX_singletonMutex`, **plus a mutex named after the client's exact program path**. Simply "holding the mutex" (the old trick) no longer works — the first client becomes the owner that closes later launches.

Fleet does two things instead:

1. **Path isolation** — it launches each client through its own directory **junction** to the real Roblox version folder. Every instance gets a *unique* program path, so the per-path mutexes never collide. Junctions are reparse points: created instantly, **no files copied**.
2. **A lightweight guard** — closes only the *shared* `ROBLOX_singleton*` objects as they reappear (leaving each instance's own per-path mutex intact, since closing that would destabilise a running client).

See [docs/TECHNICAL.md](docs/TECHNICAL.md) for the full story and the experiments behind it.

## Quick start

```bash
npm install      # installs Tauri CLI/API + koffi
npm start        # run Fleet from source
```

Build the portable distribution folder (requires the `dist` bundle step's Tauri build):

```bash
npm run build    # -> dist\Fleet (portable folder: Fleet.exe + node.exe + resources; zip it for distribution)
```

Build the custom installer (a real Win32 app, not a wizard):

```bash
npm run dist     # -> dist\FleetInstaller.exe (self-extracting, built from installer/)
```

Then: open **Accounts -> Add account** and sign in, go to **Instances**, choose **With account**, select one or more accounts, and click **Launch**. Or switch to **Signed out** and pick a number.

Full instructions: [docs/BUILD.md](docs/BUILD.md) · User guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md) · Technical: [docs/TECHNICAL.md](docs/TECHNICAL.md) · Testing: [docs/TESTING.md](docs/TESTING.md)

## Requirements

- **Windows 10 or 11** (x64)
- **Node.js 18+** and npm (to build/run from source)
- **Roblox** installed (`RobloxPlayerBeta.exe`)

## Tech

Tauri desktop shell · vanilla HTML/CSS/JS renderer · [koffi](https://koffi.dev) FFI for the Win32 calls while the native backend migration continues. The renderer stays Node-free and talks only through the explicit `window.fleet` bridge.

## Responsible use

Existing account sessions remain stored only on your machine and are never shown in the UI. Run only as many clients as your PC can handle, and follow Roblox's Terms of Use.

## Antivirus false positives

Fleet is unsigned open-source software, so some antivirus engines occasionally score its installer with heuristic ("!ml") verdicts. Fleet contains **no process-memory reading** — the old experimental in-memory server roster was removed precisely because that pattern reads like a cheat tool to antivirus engines. If your antivirus blocks a Fleet file, see [docs/ANTIVIRUS.md](docs/ANTIVIRUS.md) for why it happens and how to submit a false-positive report (Microsoft usually clears these within a few days of submission).

## License

MIT
