# Antivirus false positives

Fleet is unsigned and open source, so some engines flag the installer with heuristic `!ml` verdicts (Wacatac, Sabsik, HackTool). These are heuristic scores, not detections of anything real.

## Why it happens

- No code-signing certificate: unsigned installers from unknown publishers score poorly.
- Self-extracting layout: a zip payload appended to the exe looks like a packer.
- Bundles `node.exe` for the JS backend, plus Microsoft's official WebView2 bootstrapper.
- Win32 API use: process enumeration, window focus, registry uninstall entries. No file, browser or credential access.

## What Fleet changed (1.5.10)

- Real VERSIONINFO resource with product, company and version metadata.
- Nothing executes from %TEMP%: the WebView2 bootstrapper runs from the install folder and is removed afterwards.
- No `cmd.exe` children: the uninstaller renames itself out of the folder instead of spawning a `cmd /c ping & del` helper, a known malware pattern.
- No process-memory reading, ever. The old experimental server roster was removed entirely.
- The updater verifies the sha512 of every download before running it.
- Plain-file persistence only: no autorun, service, driver or scheduled task.

## What you can do

1. Verify the download: each release ships `checksums.txt`; compare against `Get-FileHash FleetInstaller.exe` (SHA-256).
2. Build from source: everything ships from this repo, no binary blobs (`npm install && npm run dist`).
3. Report the false positive at <https://www.microsoft.com/wdsi/filesubmission>. Analyst-reviewed reports usually clear within days and fix it for everyone.
4. Allow it locally: SmartScreen ("More info" then "Run anyway"), or Defender (Virus & threat protection, Protection history, Allow).
5. Code signing is the real fix: add `CODESIGNING_PFX` (base64) and `CODESIGNING_PFX_PASSWORD` repo secrets and CI signs every installer automatically. SignPath offers free certificates to open-source projects.
