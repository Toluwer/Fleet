# Fleet — Technical Documentation

## Goals & constraints

- Production-quality Windows desktop app to launch and manage **multiple Roblox clients**.
- White, minimalist UI; **native** title bar and window buttons.
- Clean architecture, robust error handling, no orphaned processes, no memory leaks.
- Every advertised feature actually works — no placeholders.

## Stack & rationale

| Concern | Choice | Why |
|--------|--------|-----|
| Shell | **Electron** (`frame: true`) | Native OS title bar + min/max/close for free; best fit for a white, minimalist, typographic UI; matches the rest of the toolbox. |
| Win32 access | **koffi** FFI | The multi-instance mechanism needs `NtQuerySystemInformation`, `DuplicateHandle`, etc. koffi ships prebuilt N-API binaries — no node-gyp, ABI-stable across Electron versions. |
| Process listing | **koffi** Toolhelp32 + psapi (in-process) | Spawn-free, ~90 ms even with many clients. `tasklist /V` was replaced — it blocks for *seconds* while clients boot (it queries every window) and timed out with 4+ clients, blanking the list. Window title + responding status come from `GetWindowTextW` / `IsHungAppWindow`, which don't block on other processes. |
| Termination | `taskkill /F /T` | Reliable tree kill. |
| Detection | `reg query` + filesystem scan | Registry protocol handler first, then `%LOCALAPPDATA%`/Program Files version folders. |
| Accounts | Electron login window + Roblox web API | User signs in; Fleet captures `.ROBLOSECURITY`, encrypts it with `safeStorage` (DPAPI), and mints single-use auth tickets to launch signed in. |
| Storage | JSON via Node `fs` | Atomic writes (temp + rename); tolerant reads. Cookies encrypted at rest. |

## Architecture

Strict separation of concerns across three layers:

```
┌─────────────────────────────────────────────────────────────┐
│ renderer/  (pure UI — no Node, contextIsolation on)          │
│   index.html · styles.css · app.js                           │
│   talks ONLY through window.fleet (preload bridge)           │
└───────────────▲─────────────────────────────────────────────┘
                │ ipcRenderer.invoke / on   (preload/preload.js)
┌───────────────┴─────────────────────────────────────────────┐
│ main/  (all OS access, the "domain")                         │
│   ipc.js     — wraps every request in try/catch (safe())     │
│   ├ roblox.js     detect the player exe                      │
│   ├ native.js     koffi: enum + handle-closing + win focus   │
│   ├ clones.js     per-instance directory junctions           │
│   ├ guard.js      background singleton-clearing loop         │
│   ├ launcher.js   spawn clients (detached + unref)           │
│   ├ accounts.js   Roblox login, encrypted sessions, tickets  │
│   ├ games.js      browse / search experiences (public APIs)  │
│   ├ processes.js  in-process enumeration / taskkill          │
│   ├ monitor.js    live instance snapshots (EventEmitter)     │
│   ├ store.js      settings / history (atomic)                │
│   └ logger.js     file log + in-memory ring buffer           │
└──────────────────────────────────────────────────────────────┘
```

**Security:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer can reach nothing but the explicit `window.fleet` API. CSP restricts `script-src` to `'self'`. The renderer never touches the filesystem, processes, or FFI.

**Robustness:** every IPC handler is wrapped by `safe()` so a thrown error becomes a structured `{ ok: false, error }` instead of an unhandled rejection. `process.on('uncaughtException'|'unhandledRejection')` log instead of crash. JSON reads fall back to defaults (and back up a corrupt file). Logging can never throw.

**No orphans / leaks:** launched clients are `spawn(..., { detached: true }).unref()` — Fleet holds no handle, so closing Fleet never kills or orphans a client. The monitor prunes per-PID state every poll (bounded by a grace period for just-launched PIDs). The log ring buffer is capped at 500 entries.

---

## The multi-instance mechanism (the hard part)

This was solved empirically against the Roblox build on the test machine (`version-1a951716f19e4638`). The journey matters because the "obvious" approaches **don't work** on current Roblox.

### What Roblox uses

A running `RobloxPlayerBeta.exe` holds three relevant **named kernel objects** (confirmed by enumerating its handles):

```
Event  \Sessions\N\BaseNamedObjects\ROBLOX_singletonEvent
Mutex  \Sessions\N\BaseNamedObjects\ROBLOX_singletonMutex
Mutex  \Sessions\N\BaseNamedObjects\C:_Users_..._RobloxPlayerBeta.exe.mtx
```

The third is a **mutex named after the client's full exe path** (backslashes → underscores, `+ ".mtx"`). This is the modern guard the legacy tricks miss.

### What does NOT work (and why)

1. **Hold `ROBLOX_singletonEvent` open** (the classic trick). *Tested:* the first client launches, but it also opens the event and becomes the "owner"; the second client sees it and exits. Holding the object keeps it alive — which actively **prevents** new launches.
2. **Close the event handle once, then launch.** *Tested:* the close succeeds (object destroyed), but the first client **re-creates** it, so the next launch sees it again and exits.
3. **Continuously close `ROBLOX_singletonEvent` (+ mutex).** *Tested:* two clients coexist for ~3 s, then **both** die — because the per-path `.mtx` mutex is the real blocker, and aggressively closing a running client's *own* per-path mutex makes it exit a few seconds later.

### What works

Two complementary techniques, verified to keep multiple clients alive indefinitely:

1. **Path isolation (`clones.js`).** Each client is launched through its own **directory junction** that points at the real Roblox version folder:

   ```
   %APPDATA%\fleet\clones\instance-1\  ──▶  …\Roblox\Versions\version-…\
   %APPDATA%\fleet\clones\instance-2\  ──▶  (same target)
   ```

   The process's image path is then `…\instance-N\RobloxPlayerBeta.exe`, so its **per-path mutex name is unique** and never collides with another instance's. A junction is an NTFS reparse point — created instantly, sharing the original files, **zero copying**. Junctions are removed with a plain `rmdir` (never `/s`), so the target is never touched.

2. **Global-only guard (`guard.js`).** A background loop closes **only** the shared `ROBLOX_singleton*` objects as they reappear, leaving each instance's own per-path mutex intact. It is paced — fast (~250 ms) for 30 s after a launch, then gentle (~1.5 s) in steady state — and gated by a cheap `OpenEvent`/`OpenMutex` existence check so it does no heavy work when there's nothing to clear.

The handle-closing itself (`native.closeRobloxSingletonHandles`):

1. `NtQuerySystemInformation(SystemExtendedHandleInformation)` → all system handles.
2. Filter to the target PIDs and to Event/Mutant object types (type indices resolved at runtime by creating a throwaway event/mutex and reading their entries).
3. For each, `OpenProcess(PROCESS_DUP_HANDLE)` + `DuplicateHandle(DUPLICATE_SAME_ACCESS)` + `NtQueryObject(ObjectNameInformation)` to read the name.
4. If the name matches `ROBLOX_singleton(Event|Mutex)`, `DuplicateHandle(… DUPLICATE_CLOSE_SOURCE)` closes it in the owning process; the kernel then destroys the named object.

Filtering to Event/Mutant types avoids the handle types that can hang `NtQueryObject`.

### Scope & honesty

- This produces multiple independent **clients** via the unmodified Roblox player (launched through a junction) plus closing Windows kernel handles. Fleet does not patch Roblox files.
- If koffi can't load, multi-instance is reported **unavailable** and Fleet still launches a single client and manages whatever is running.

---

## Accounts (`accounts.js`)

A full Roblox account manager, built on the official login + web APIs — no credentials are ever entered by Fleet.

1. **Add account.** Fleet opens an Electron `BrowserWindow` on `https://www.roblox.com/login` using a *fresh, isolated session partition* (so it always starts signed out). The user signs in themselves (2FA/captcha included). Fleet polls that session's cookies for `.ROBLOSECURITY`; once present and validated against `users/authenticated`, it captures it and closes the window.
2. **Store.** The cookie is encrypted with `safeStorage.encryptString` (Windows DPAPI) and written to `accounts.json`. The plaintext cookie **never leaves the main process and is never sent to the renderer** — `sanitize()` strips it from everything the UI sees.
3. **Enrich.** Username/displayName (`users/authenticated`), avatar headshot (thumbnails API, fetched and cached as a `data:` URL so the renderer needs no network or relaxed CSP), and presence (`presence/users`).
4. **Launch signed in.** At launch time Fleet mints a **single-use authentication ticket** (`auth/v1/authentication-ticket`, two-step with the `x-csrf-token`) and builds a `roblox-player:1+launchmode:app+gameinfo:<ticket>+...` deep link (or `launchmode:play` + `placelauncherurl` when a Place ID is given). The client is then launched **path-isolated** like any other instance, so multiple accounts coexist.

Tickets are minted per launch (they expire in seconds). Sessions naturally expire; a failed ticket surfaces "Session expired — sign in again".

**Presence.** Per-account online/offline/in-game/in-studio comes from the Presence API (`presence/users`). The status field is `userPresenceType` (0 Offline / 1 Online / 2 In game / 3 In Studio) — an earlier bug read `presenceType`, which is always undefined, so everything showed Offline. The call handles the CSRF (403) challenge and 429 rate-limits and returns `{status, error}` so failures surface instead of silently reading as Offline; the Accounts page polls it lightly (presence only) on open and every 45 s.

---

## Games browser (`games.js`)

All via public, no-auth Roblox APIs:

- **Browse** (popular): `explore-api/v1/get-sorts?sessionId=<uuid>` — the per-sort game arrays are flattened (each sort exposes its games under a key whose items carry `universeId`/`rootPlaceId`), deduped, sorted by live player count.
- **Search**: `search-api/omni-search?searchQuery=&sessionId=&pageType=Games&pageToken=` — carries `nextPageToken`, driving infinite scroll.
- **Thumbnails**: `thumbnails-api/v1/games/multiget/thumbnails` (768×432). The renderer loads the rbxcdn URLs directly (CSP allows `https://*.rbxcdn.com`) with `loading="lazy"`.

Each game carries its **`rootPlaceId`** — joining always uses that, never the universeId. **Join** runs `launch:accounts([selected || first account], rootPlaceId)` (authenticated, path-isolated); **Random Game** picks one from the loaded list.

---

## Window chrome

The title bar uses `titleBarStyle: 'hidden'` + `titleBarOverlay` (Window Controls Overlay): the native minimize/maximize/close buttons are drawn by Windows at the top-right, with **no title-bar icon or text**. A 44 px custom strip (`-webkit-app-region: drag`) shows the "Fleet" wordmark and provides the drag region. Verified at runtime via `navigator.windowControlsOverlay.visible`.

---

## The >2-client fix (process enumeration)

Early on, launching 3+ clients made the running-clients list go blank. Root cause: `tasklist /V` queries each window and **stalls for 5–6 s while several clients boot**, exceeding the poll timeout and returning nothing. The fix replaced it with **spawn-free, in-process enumeration** via koffi (`CreateToolhelp32Snapshot` + `K32GetProcessMemoryInfo` for PID/memory; `GetWindowTextW` + `IsHungAppWindow` for title/status). It runs in ~90 ms regardless of system load, so the list stays accurate no matter how many clients launch at once. A `tasklist` fallback remains for the (rare) case where koffi is unavailable.

---

## Data & files

| Path | Contents |
|------|----------|
| `%APPDATA%\fleet\settings.json` | user settings |
| `%APPDATA%\fleet\accounts.json` | accounts (cookies **encrypted** via DPAPI) |
| `%APPDATA%\fleet\history.json` | launch history (capped) |
| `%APPDATA%\fleet\logs\fleet-YYYY-MM-DD.log` | daily rolling log |
| `%APPDATA%\fleet\clones\instance-N\` | per-instance junctions (cleaned on quit) |

## IPC surface

All channels are request/response via `ipcRenderer.invoke`, plus two pushes (`instances:update`, `log:entry`). Channel list (preload ↔ ipc verified 1:1): `app:status`, `roblox:detect`, `launch:quick`, `launch:accounts`, `accounts:list|add|remove|refresh`, `games:browse|search`, `instances:get`, `instance:focus|kill|restart`, `instances:killAll|cleanup`, `history:get|clear`, `settings:get|save|reset|browse`, `logs:get|clear|openFolder`, `diag:get`, `app:openExternal|openUserData`.

## Known limitations

- Windows-only by design (Win32 APIs).
- Multi-instance is verified against current Roblox; a future Roblox change to its single-instance scheme could require updating `native.js` / `clones.js`. The Diagnostics page surfaces the object names and type indices to aid that.
- Account launches depend on Roblox's auth-ticket flow; if Roblox changes it, ticket minting in `accounts.js` may need updating.
- Code signing is omitted (no certificate); `npm run build` produces an unsigned, portable `Fleet.exe`.
