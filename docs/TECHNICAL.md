# Fleet Technical Notes

## Goals

- Launch and manage multiple Roblox desktop clients on Windows.
- Keep the renderer simple, local, and Node-free.
- Keep OS access behind a narrow backend API.
- Ship portable and installed builds from the same source tree.

## Stack

| Concern | Choice | Notes |
|---------|--------|-------|
| Desktop shell | Tauri 2 | Rust app shell, native WebView2 renderer. |
| Renderer | Vanilla HTML/CSS/JS | Loaded from `src/renderer`; talks through `window.fleet`. |
| Backend bridge | Rust Tauri commands | Commands in `src-tauri/src/lib.rs` proxy requests to the Node service host. |
| Transitional service layer | Node.js | Existing service modules live in `src/main`. |
| Win32 access | `koffi` | FFI for handle enumeration, process listing, and window focus. |
| Storage | JSON files | Atomic writes through the Node service layer. |

## Runtime Architecture

```text
src/renderer
  index.html
  app.js
  model.js
  styles.css
  tauri-bridge.js
      |
      | window.__TAURI__.core.invoke(...)
      v
src-tauri/src/lib.rs
  Tauri commands
  NodeBackend RPC client
      |
      | newline-delimited JSON over child stdin/stdout
      v
src/main/tauri-node-host.js
  tauri-backend.js
  accounts.js / launcher.js / native.js / processes.js / ...
```

The Rust shell starts the Node host during Tauri setup. The host is loaded from `src/main` next to `Fleet.exe` - the portable and installed layouts are identical (the custom installer extracts the portable distribution as-is). `node.exe` sits side-by-side with `Fleet.exe`.

## Packaging Layouts

Portable build:

```text
Fleet.exe
node.exe
src/main/tauri-node-host.js
node_modules/koffi/...
```

Installed build (identical to portable - the custom installer extracts the
portable distribution as-is, plus `uninstall.exe`):

```text
Fleet.exe
node.exe
src/main/tauri-node-host.js
node_modules/koffi/...
uninstall.exe
```

The app must keep this layout working until the remaining Node service layer is ported to Rust.

## Multi-Instance Mechanism

Roblox enforces a single client with named Windows kernel objects:

```text
Event  \Sessions\N\BaseNamedObjects\ROBLOX_singletonEvent
Mutex  \Sessions\N\BaseNamedObjects\ROBLOX_singletonMutex
Mutex  \Sessions\N\BaseNamedObjects\<path-derived>.mtx
```

The path-derived mutex is the important modern guard. Fleet uses two complementary techniques:

1. Path isolation: each client launches through its own directory junction under `%APPDATA%/fleet/clones/instance-N`, pointing at the real Roblox version folder. Each instance therefore has a unique executable path and a unique path-derived mutex.
2. Global guard cleanup: `guard.js` closes only the shared `ROBLOX_singletonEvent` and `ROBLOX_singletonMutex` handles as they reappear. It leaves each client's path-derived mutex alone.

`native.js` handles the Win32 work through `koffi`: process enumeration, object type discovery, handle duplication, object-name reads, and targeted close operations.

## Accounts

Account sign-in opens a Tauri WebView pointed at Roblox's official login page. Fleet watches that isolated WebView for `.ROBLOSECURITY`, stores account records through the backend, and strips secret cookie data from all renderer responses.

Launches mint a short-lived Roblox authentication ticket and build the `roblox-player:` deep link for the selected place/server. Multiple accounts still use the same path-isolation mechanism as signed-out clients.

## Renderer Bridge

The renderer calls `window.fleet`, defined by `src/renderer/tauri-bridge.js`. The bridge wraps Tauri command invocation and exposes stable domains:

```text
app
roblox
launch
accounts
games
people
instances
playtime
history
settings
logs
diag
```

Backend events are emitted from Rust to the WebView and surfaced to the renderer through the same bridge.

## Data Paths

| Path | Contents |
|------|----------|
| `%APPDATA%/com.toluwa.fleet` | Tauri app data root. |
| backend user data arg | Passed from Rust into `tauri-node-host.js`. |
| `settings.json` | Settings. |
| `accounts.json` | Saved account records. |
| `history.json` | Launch history. |
| `logs/fleet-YYYY-MM-DD.log` | Daily log files. |
| `clones/instance-N` | Per-instance Roblox junctions. |

## Failure Handling

- Tauri commands return structured `{ ok: false, error }` values through the Node backend where possible.
- The renderer uses API timeouts so app boot cannot hang forever on a backend call.
- `native.js` degrades when `koffi` cannot load; single-client launch paths remain usable.
- Generated build folders are disposable and ignored by Git.

## Known Limits

- Windows only.
- Roblox can change its singleton mechanism, which would require updates in `native.js`, `guard.js`, or `clones.js`.
- The Node service layer is transitional. The long-term cleanup path is moving service modules into Rust and removing bundled `node.exe`.
