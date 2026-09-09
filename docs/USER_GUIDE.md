# Fleet user guide

> All of this is also in the app's Help page.

## Instances

Start here. The **Roblox detected** banner confirms setup; if it's missing, see [Troubleshooting](#troubleshooting).

To launch clients:

- With an account: pick one or more accounts, optionally a Place ID, game URL or server link, then Launch. Tick **Keep alive** to hand those accounts to the watchdog (see below).
- Signed out: choose a count and Launch.

Each client shows up in Running clients with status, PID, memory and start time. Hover a row for Focus, Restart and End, right-click to copy the PID or stop that account's auto-rejoin. The top toolbar has Refresh, End all, and Cleanup (which also clears leftover crash handlers).

## Accounts

Add account opens Roblox's real login page, 2FA included. Sessions are encrypted and stay on this PC.

Create account builds a brand-new Roblox account instead: fill in the username, password, birthday and profile field, and Fleet opens Roblox's real signup form already filled in — it even clicks Continue and Add password for you. Roblox then asks its one human check (that's Roblox's, and no tool is allowed to do it for you); the account is saved, signed in. Fleet keeps the same browser identity between sign-ups, which usually keeps Roblox's checks short. Usernames are checked against Roblox while you type, taken names get one-click available alternatives, the dice button generates a strong password for you, and your birthday and profile-field choices are remembered for the next account.

Make several set the count above 1: Fleet lines up that many usernames (the exact base plus numbered variants, each verified against Roblox) and then opens one signup window per account — solve each human check and the next window appears automatically, until the whole batch lands. The password and birthday are shared across the batch, a progress banner tracks which account is up (account 2 of 5, say), and closing a signup window stops the rest of the batch cleanly. A taken base name only ever stops a single create; in a batch the accounts simply all ride verified variants.

Each card has Launch, Refresh, Remove and Select (for multi-launch). Expired sessions offer Sign in again.

## Sessions

After picking accounts and a target, Save current setup lets you relaunch the whole thing with one click. A session can also auto-arrange the windows after launch and arm the watchdog for every account in it.

## Watchdog (auto-rejoin)

Tick **Keep alive** when launching (or on a session, or in Fill) and Fleet watches those accounts in the background. When a client crashes, disconnects or gets kicked, that account goes straight back into the same server.

A few details worth knowing:

- Every rejoin mints a fresh login ticket, so it keeps working long after the original launch.
- Retries back off (10 s doubling, capped at 5 min) and give up after five straight tries with no five-minute stable run. A healthy stretch resets the counter.
- Ending a client, End all, Cleanup or restarting disarms that watch, so the watchdog never relaunches something you closed on purpose.
- Armed watches survive a Fleet restart but stay dormant until the account is seen in game again — reopening Fleet never launches anything on its own.
- The chip next to Running clients shows what's armed; its Stop button disarms everything. Settings has the knobs: rejoin delay, give-up count, and an optional restart for clients stuck not responding.

## Games

Browse popular games or search, then Join from a card. Fleet uses your selected account so you join signed in. Random Game joins one from the current list.

Open a game's server list to pick an exact server, or press **Fill** to let Fleet scan and pack the selected accounts into the emptiest servers — all in one server when it fits everyone, or spread across the least crowded ones. Fill can arm the watchdog for the whole crew in the same click.

## People

Friends across your accounts, merged. Search users, filter by status, open profiles, and Join where Roblox allows it. Requires at least one account.

## History

Every launch with time, account, result and PID. Clear history wipes it.

## Settings

Roblox location (auto-detected or manual path), theme, confirm-before-bulk-actions, refresh interval, launch delay, instance warning threshold, history size, and the watchdog: auto-rejoin delay, give-up count, and how long a client may be stuck before Fleet relaunches it.

## Diagnostics

Environment info and a live log with level filters. Copy diagnostics when reporting a problem.

## Keyboard

- `Ctrl+1` through `Ctrl+9` switch sections
- `/` focuses search on Games and People
- `Esc` closes any dialog or menu

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Roblox not found | Install Roblox, or set the path manually in Settings (usually `%LOCALAPPDATA%\Roblox\Versions\version-...\RobloxPlayerBeta.exe`). |
| New client closes after seconds | Raise Delay between launches in Settings. |
| Watchdog gave up on an account | The account's joins kept failing. Sign in again if the session expired, then relaunch it with Keep alive. |
| "Multi-instance is unavailable" | Reinstall Fleet (the native helper failed to load). |
| Focus doesn't raise the window | Windows blocks foreground changes; click the taskbar button. |
| PC slows down | Each client takes roughly 0.5-1 GB of RAM. Run only as many as you can handle. |
