<div align="center">

<img src="assets/icon.png" width="92" alt="Fleet" />

# Fleet

**A minimalist multi-instance launcher and account manager for Roblox.**

[**Download FleetInstaller.exe**](https://github.com/Toluwer/Fleet/releases/latest/download/FleetInstaller.exe) · [**Portable zip**](https://github.com/Toluwer/Fleet/releases/latest)

</div>

---

## Features

- **Multi-instance launching** — run several Roblox clients at once, signed into different accounts or signed out.
- **Account manager** — sign in through Roblox's official login page, then launch multiple accounts at once via Place ID, game URL, or server link.
- **Saved sessions** — relaunch a whole account group + game setup with one click.
- **Games browser** — search experiences, scan servers, sort/filter by ping, players, FPS.
- **People explorer** — friends across accounts, live status, profiles, join.
- **Instance manager** — live list of every running client with focus / restart / end tools.
- **Themes** — light, dark, or system.
- **History, diagnostics, settings, help pages.**

## How multi-instance works

Roblox blocks multiple clients using a shared mutex plus a per-path mutex. Fleet launches each client through its own directory junction (unique path, no mutex collision) and clears the shared mutex as it reappears. Details: [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Quick start

```bash
npm install
npm start        # run from source
npm run build    # portable folder -> dist\Fleet
npm run dist     # installer -> dist\FleetInstaller.exe
```

**Requirements:** Windows 10/11 x64 · Node.js 18+ · Roblox installed

Docs: [User guide](docs/USER_GUIDE.md) · [Build](docs/BUILD.md) · [Technical](docs/TECHNICAL.md) · [Testing](docs/TESTING.md)

## Antivirus false positives

Fleet is unsigned, so some engines flag it with heuristic `!ml` verdicts. It contains no memory reading. See [docs/ANTIVIRUS.md](docs/ANTIVIRUS.md) if yours blocks it.

## License

MIT
