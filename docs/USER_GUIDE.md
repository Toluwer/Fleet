# Fleet user guide

> All of this is also in the app's Help page.

## Instances

Start here. The **Roblox detected** banner confirms setup; if it's missing, see [Troubleshooting](#troubleshooting).

To launch clients:

- With an account: pick one or more accounts, optionally a Place ID, game URL or server link, then Launch.
- Signed out: choose a count and Launch.

Each client shows up in Running clients with status, PID, memory and start time. Hover a row for Focus, Restart and End, right-click to copy the PID. The top toolbar has Refresh, End all, and Cleanup (which also clears leftover crash handlers).

## Accounts

Add account opens Roblox's real login page, 2FA included. Sessions are encrypted and stay on this PC.

Each card has Launch, Refresh, Remove and Select (for multi-launch). Expired sessions offer Sign in again.

## Sessions

After picking accounts and a target, Save current setup lets you relaunch the whole thing with one click.

## Games

Browse popular games or search, then Join from a card. Fleet uses your selected account so you join signed in. Random Game joins one from the current list.

## People

Friends across your accounts, merged. Search users, filter by status, open profiles, and Join where Roblox allows it. Requires at least one account.

## History

Every launch with time, account, result and PID. Clear history wipes it.

## Settings

Roblox location (auto-detected or manual path), theme, confirm-before-bulk-actions, refresh interval, launch delay, instance warning threshold, history size.

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
| "Multi-instance is unavailable" | Reinstall Fleet (the native helper failed to load). |
| Focus doesn't raise the window | Windows blocks foreground changes; click the taskbar button. |
| PC slows down | Each client takes roughly 0.5-1 GB of RAM. Run only as many as you can handle. |
