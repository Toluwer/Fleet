# Antivirus false positives

Fleet is unsigned and open-source, so some engines flag its installer with heuristic `!ml` verdicts (Wacatac, Sabsik, HackTool). These are false positives — heuristic scores, not detections of real malicious code.

## Why it happens

- **No code-signing certificate** — unsigned installers from unknown publishers score poorly.
- **Downloads WebView2** from Microsoft's official link when missing.
- **Bundles node.exe** for the transitional JS backend.
- **Win32 API use** — process enumeration, window focus, mutex cleanup, junctions. No file, browser, or credential access, but behavioral engines weigh it.

## What Fleet already changed

- **No process-memory reading, ever** — the old experimental Server roster was removed entirely.
- **No `cmd.exe` children** — junctions use `fs.symlinkSync`.
- **Updater verifies sha512** of every download before running it.
- **Plain-file persistence only** — no autorun, service, driver, or scheduled task.

## What you can do

1. **Build from source** — everything ships from this repo, no binary blobs (`npm install && npm run dist`).
2. **Submit a false-positive report** — <https://www.microsoft.com/wdsi/filesubmission> (usually cleared within days) or the vendor's portal.
3. **Add an exclusion** — Windows Security → Exclusions → your Fleet folder.
