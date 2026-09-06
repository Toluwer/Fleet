# Antivirus false positives

Fleet is an unsigned, open-source Windows application, and some antivirus
engines occasionally flag its installer (`FleetInstaller.exe`) or binaries with
heuristic / machine-learning verdicts such as *Trojan:Win32/Wacatac.B!ml*,
*Sabsik!ml*, or *HackTool*. These are **false positives** — heuristic scores,
not detections of actual malicious code. This page explains why they happen,
what Fleet has already done to reduce them, and what you can do if your
antivirus blocks a file.

## Why it happens

1. **No code-signing certificate.** Fleet is a free, personal project. A
   code-signing certificate (especially an EV certificate, which gets instant
   SmartScreen reputation) costs hundreds to thousands of dollars per year.
   Unsigned custom installers get scrutinised far more heavily than signed
   ones, and "unsigned installer + unknown publisher" alone raises an engine's
   suspicion score.
2. **The installer downloads and runs the WebView2 runtime** from Microsoft's
   official link (`go.microsoft.com/fwlink/...`) when the runtime is missing —
   the same behaviour as hundreds of legitimate Electron/Tauri apps, but
   "download + execute" is also what droppers do, so heuristics score it.
3. **The bundled Node runtime.** While the backend is being ported to Rust,
   Fleet ships `node.exe` next to the app executable and runs its JavaScript
   service layer with it. Malware occasionally side-loads `node.exe`, so an
   "exe that drops another exe and runs scripts" scores poorly in ML models.
4. **What Fleet does at runtime.** Multi-instance launching requires
   Win32 API work: enumerating processes, focusing/tiling windows, closing
   Roblox's shared single-instance mutexes in running clients, and creating
   directory junctions for path isolation. None of it touches your files,
   browser, or credentials — but process and handle manipulation is also part
   of many malware toolsets, so behavioural engines weigh it.

## What Fleet has already changed to reduce detections

- **No process-memory reading, ever.** An earlier experimental "Server roster"
  feature read the player list out of the running Roblox client's memory.
  That is a textbook external-cheat pattern (and the single biggest reason
  builds of that era were flagged as HackTool/Trojan), so it was removed
  entirely: no `ReadProcessMemory`, no module enumeration of other processes,
  no memory offsets, no scan worker. The People view now relies only on
  Roblox's public web APIs.
- **No `cmd.exe` child processes for junctions.** Path-isolation junctions
  are created with Node's own filesystem API (`fs.symlinkSync(..., 'junction')`)
  instead of spawning `cmd /c mklink`.
- **The updater verifies every download.** `latest.yml` publishes a SHA-512
  digest; Fleet recomputes it and refuses to write or run an installer that
  does not match. An unverified "download and execute" pattern is both a
  security bug and an AV red flag — now it cannot happen.
- **Plain-file persistence only.** Settings, accounts and logs are ordinary
  JSON/log files under your own AppData folder. There is no autorun entry,
  no service, no driver, no scheduled task, no browser helper, and the
  installer never touches anything outside its own folders.

## What you can do

1. **Check the source.** Everything Fleet ships is built from
   https://github.com/Toluwer/Fleet — no binary blobs. You can build the
   installer yourself with `npm install && npm run dist`.
2. **Submit a false-positive report** (takes a few minutes, usually fixed
   within days):
   - Microsoft: <https://www.microsoft.com/wdsi/filesubmission> — choose
     "Software developer" and attach the file. Microsoft also whitelists
     hashes after review, which clears Defender and SmartScreen globally.
   - Other vendors: most have a submission portal (Avast/AVG, Kaspersky,
     Bitdefender, Trend Micro, McAfee "GetSusp", VirusTotal's "dispute"
     comment for the maintainers of engines).
3. **Add an exclusion** if you trust the build: Windows Security →
   Virus & threat protection → Manage settings → Exclusions → add the
   Fleet install folder (typically
   `%LOCALAPPDATA%\Programs\Fleet` or the portable folder you unzipped).
4. **Use the source build.** A `Fleet.exe` you compiled locally is unlikely
   to match any cached bad hash, and building from source lets you verify
   nothing else slipped in.

## For maintainers

- Re-check every release on VirusTotal before publishing, and submit any
  new detection to the affected vendor immediately — early submissions keep
  the app's reputation clean.
- The long-term fix for both detection and SmartScreen friction is finishing
  the Rust migration (removing the bundled Node runtime) and eventually a
  code-signing certificate. Both are tracked in the project's issue tracker.
