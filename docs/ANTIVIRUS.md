# Antivirus false positives

Fleet is unsigned and open-source, so some engines flag its installer with heuristic `!ml` verdicts (Wacatac, Sabsik, HackTool). These are false positives — heuristic scores, not detections of real malicious code.

## Why it happens

- **No code-signing certificate** — unsigned installers from unknown publishers score poorly.
- **Self-extracting layout** — a zip payload appended to the exe looks like a packer.
- **Bundles node.exe** for the JS backend, plus the WebView2 bootstrapper from Microsoft's official link.
- **Win32 API use** — process enumeration, window focus, registry uninstall entries. No file, browser, or credential access.

## What Fleet already changed (v1.5.10)

- **VERSIONINFO resource** — real product/company/file-version metadata instead of an anonymous binary.
- **Nothing executes from %TEMP%** — the WebView2 bootstrapper runs from the install folder and is removed right after.
- **No `cmd.exe` children** — the uninstaller no longer spawns a `cmd /c ping & del` helper (a known malware heuristic); it renames itself away instead.
- **No process-memory reading, ever** — the old experimental Server roster was removed entirely.
- **Updater verifies sha512** of every download before running it.
- **Plain-file persistence only** — no autorun, service, driver, or scheduled task.

## What you can do

1. **Verify the download** — each release ships `checksums.txt`; compare with `Get-FileHash FleetInstaller.exe` (SHA-256).
2. **Build from source** — everything ships from this repo, no binary blobs (`npm install && npm run dist`).
3. **Report the false positive** — <https://www.microsoft.com/wdsi/filesubmission> (analyst-reviewed, usually cleared within days; fixes it for everyone).
4. **Allow it locally** — SmartScreen: "More info" → "Run anyway"; Defender: Virus & threat protection → Protection history → Allow.
5. **Code signing is the real fix** — add `CODESIGNING_PFX` (base64) + `CODESIGNING_PFX_PASSWORD` repo secrets and CI signs every installer automatically. SignPath offers free certificates to open-source projects.
