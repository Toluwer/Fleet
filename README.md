<div align="center">

<img src="assets/icon.png" width="92" alt="Fleet" />

# Fleet

A multi-instance launcher and account manager for Roblox.

[Download FleetInstaller.exe](https://github.com/Toluwer/Fleet/releases/latest/download/FleetInstaller.exe) · [Portable zip](https://github.com/Toluwer/Fleet/releases/latest)

</div>

## Features

- Launch multiple Roblox clients at once, each signed into a different account or signed out
- Sign in through Roblox's real login page, keep several accounts saved, launch them together by Place ID, game URL or server link
- Create new accounts without leaving Fleet: enter the username, password, birthday and profile field, Fleet fills Roblox's signup (whichever layout Roblox serves), clicks through to Roblox's one human check, and imports the account when it's done — with a strong-password generator, one-click fixes for taken usernames, and remembered defaults
- Update in place: the updater swaps the new version in while Fleet is running (no installer window, no helper script), and old installer exes always fetch and install the newest release
- A single-page installer in Fleet's own dark look — logo, folder picker, progress and done in one window, native controls, no setup wizard
- Save an account group plus game setup as a session and relaunch it with one click
- Watchdog: when a client crashes, disconnects or gets kicked, Fleet puts that account straight back into the same server, with a fresh login ticket and a retry backoff that gives up instead of looping forever
- Fill: scan a game's servers and pack your whole account group into the emptiest ones, together or spread out
- Browse and search games, scan servers, filter by ping, players and FPS; sort by players, rating or your own tracked playtime, with live counts, ratings, lifetime visits and your hours played on every card
- See friends across all accounts with live status, open profiles, join their server; filter the page by name and see at a glance who's in game
- Stats: a 14-day playtime chart, per-game and per-account totals, recent sessions and averages — tracked locally while your accounts play
- Manage running clients: focus, restart or end any of them
- Light, dark and system themes

## How multiple instances work

Roblox blocks a second client with a shared mutex plus a second mutex derived from the exe path. Fleet launches each client through its own directory junction, so every client gets a unique path and its own mutex, and clears the shared mutex as it reappears. Details in [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Running from source

```bash
npm install
npm start        # run from source
npm run build    # portable folder -> dist\Fleet
npm run dist     # installer -> dist\FleetInstaller.exe
```

Requires Windows 10/11 x64, Node.js 18+ and Roblox installed.

Docs: [User guide](docs/USER_GUIDE.md), [Build](docs/BUILD.md), [Technical notes](docs/TECHNICAL.md), [Testing](docs/TESTING.md)

## Antivirus false positives

Fleet is unsigned, so some engines flag it with heuristic `!ml` verdicts. It doesn't read process memory. See [docs/ANTIVIRUS.md](docs/ANTIVIRUS.md) if yours blocks it.

## License

MIT
