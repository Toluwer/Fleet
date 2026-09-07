# Fleet technical notes

## Stack

| Layer | Choice |
|---------|--------|
| Desktop shell | Tauri 2 (Rust, WebView2) |
| Renderer | Plain HTML/CSS/JS, talks through `window.fleet` |
| Backend | Rust Tauri commands proxying to a Node service layer (`src/main`) |
| Win32 access | `koffi` FFI |
| Storage | JSON files, atomic writes |

## Architecture

```text
src/renderer  --window.__TAURI__.core.invoke-->  src-tauri/src/lib.rs
                                                  |
                                                  | newline JSON over stdio
                                                  v
                                            src/main/tauri-node-host.js
                                            accounts / launcher / native / processes / ...
```

The Rust shell starts the Node host at setup. `node.exe` sits beside `Fleet.exe`; portable and installed layouts are identical, the installed copy just adds `uninstall.exe`.

## Multiple-instance mechanism

Roblox enforces one client with named kernel objects:

```text
Event/Mutex  \Sessions\N\BaseNamedObjects\ROBLOX_singletonEvent / _Mutex
Mutex        \Sessions\N\BaseNamedObjects\<path-derived>.mtx
```

Fleet's approach:

1. Each client launches through its own junction under `%APPDATA%/fleet/clones/instance-N`, so each gets a unique path and a unique path-derived mutex.
2. `guard.js` closes only the shared `ROBLOX_singleton*` objects as they reappear and leaves the per-path mutexes alone.

`native.js` does the Win32 work (enumeration, handle duplication, close) via koffi.

## Accounts

Sign-in opens a Tauri WebView on Roblox's login page. Fleet watches for `.ROBLOSECURITY`, stores records through the backend, and strips cookies from all renderer responses. Launches mint an auth ticket and build the `roblox-player:` deep link.

## Watchdog (auto-rejoin)

`src/main/keeper.js` watches armed accounts with two signals: the process monitor's snapshot (a fleet-launched pid carries its `accountId`) and the 12 s account presence sweep as a fallback for pid-less watches after a Fleet restart. A dead pid schedules a rejoin that mints a **fresh** auth ticket — replaying the original deep link would fail because tickets expire minutes after issue. Retries back off exponentially (10 s doubling, 5 min cap) and stop after N straight tries without a five-minute stable run. Manual kills disarm or blind the affected watch, and armed records persist to `keeper.json`, coming back **paused** after a restart so Fleet only adopts clients it sees running, never launches new ones. `settings.json` holds the knobs (`autoRejoinDelaySec`, `autoRejoinMaxAttempts`, `autoRestartHungSec`).

## Server fill

`launch_auto_fill` in `tauri-backend.js` scans the place's public servers, sorts by free slots (ping as tiebreak), and packs the selected accounts greedily — all into one server when it has room, otherwise filling the emptiest servers first. Each account gets its own freshly minted ticket into its assigned server, spaced by the usual launch delay, and the whole group can be handed to the watchdog in the same call.

## Data paths

| Path | Contents |
|------|----------|
| `%APPDATA%/com.toluwa.fleet` | App data root |
| `settings.json`, `accounts.json`, `history.json`, `keeper.json` | State |
| `logs/fleet-YYYY-MM-DD.log` | Daily logs |
| `clones/instance-N` | Per-instance junctions |

## Known limits

- Windows only.
- Roblox may change its singleton mechanism; the fix would land in `native.js`, `guard.js` or `clones.js`.
- The Node service layer is transitional and moves to Rust eventually.
