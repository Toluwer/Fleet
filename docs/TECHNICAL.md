# Fleet Technical Notes

## Stack

| Concern | Choice |
|---------|--------|
| Desktop shell | Tauri 2 (Rust, WebView2) |
| Renderer | Vanilla HTML/CSS/JS, talks through `window.fleet` |
| Backend | Rust Tauri commands proxy to Node service layer (`src/main`) |
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

The Rust shell starts the Node host at setup. `node.exe` sits beside `Fleet.exe`; portable and installed layouts are identical (installed adds `uninstall.exe`).

## Multi-instance mechanism

Roblox enforces one client via named kernel objects:

```text
Event/Mutex  \Sessions\N\BaseNamedObjects\ROBLOX_singletonEvent / _Mutex
Mutex        \Sessions\N\BaseNamedObjects\<path-derived>.mtx
```

Fleet's approach:

1. Each client launches through its own junction under `%APPDATA%/fleet/clones/instance-N` → unique path → unique path-derived mutex.
2. `guard.js` closes only the shared `ROBLOX_singleton*` objects as they reappear, leaving per-path mutexes intact.

`native.js` does the Win32 work (enumeration, handle duplication, close) via koffi.

## Accounts

Sign-in opens a Tauri WebView on Roblox's login page; Fleet watches for `.ROBLOSECURITY`, stores records via the backend, and strips cookies from all renderer responses. Launches mint an auth ticket and build the `roblox-player:` deep link.

## Data paths

| Path | Contents |
|------|----------|
| `%APPDATA%/com.toluwa.fleet` | App data root |
| `settings.json`, `accounts.json`, `history.json` | State |
| `logs/fleet-YYYY-MM-DD.log` | Daily logs |
| `clones/instance-N` | Per-instance junctions |

## Known limits

- Windows only.
- Roblox may change its singleton mechanism — updates would land in `native.js` / `guard.js` / `clones.js`.
- Node service layer is transitional; long-term it moves to Rust.
