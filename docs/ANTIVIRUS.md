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

## What Fleet changed (1.7.1)

- The self-updater is transactional now: the new Fleet.exe is verified on disk before the "installed version" registry entry is touched, the file copy retries when something holds a lock, and a failed update leaves a plain result file the app reads on the next start - no more silent close-and-nothing-happened.
- The installer reads the installed version straight off Fleet.exe instead of trusting the registry, so a half-finished update can no longer make it say "already up to date".
- Still no packing, no UPX, no execution from %TEMP%, no obfuscated anything - every step is plain, logged, and reproducible from this repo.

## What Fleet changed (1.8.2)

- **No script host during updates.** The updater used to arm a hidden PowerShell script and close the app - a "script interpreter running a script from AppData" pattern that heuristic engines (and some policies) kill, which orphaned updates. The updater now swaps files in place from inside the running app, exactly like VS Code: in-use files are renamed aside and cleaned up by the next start. Nothing is spawned, nothing runs from %TEMP%.
- **The installer fetches releases through WinHTTP** - the same Windows component Windows Update uses - instead of shipping a networking stack, and it installs the newest published release rather than whatever is baked into the exe.
- Every downloaded release is still sha512-verified before a single file is written.

## What you can do

1. Verify the download: each release ships `checksums.txt`; compare against `Get-FileHash FleetInstaller.exe` (SHA-256).
2. Build from source: everything ships from this repo, no binary blobs (`npm install && npm run dist`).
3. Report the false positive at <https://www.microsoft.com/wdsi/filesubmission>. Analyst-reviewed reports usually clear within days and fix it for everyone.
4. Allow it locally: SmartScreen ("More info" then "Run anyway"), or Defender (Virus & threat protection, Protection history, Allow).
5. Code signing is the real fix: add `CODESIGNING_PFX` (base64) and `CODESIGNING_PFX_PASSWORD` repo secrets and CI signs every installer automatically. SignPath offers free certificates to open-source projects.
