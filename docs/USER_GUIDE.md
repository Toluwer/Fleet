# Fleet — User Guide

> Everything here is also in the app's **Help** page.

## Instances

Start here. The **Roblox detected** banner confirms setup; if not, see [Troubleshooting](#troubleshooting).

**Launch clients:**
- **With account** — pick one or more accounts, optionally a Place ID / game URL / server link, then **Launch**.
- **Signed out** — choose a count and **Launch**.

Each client appears in **Running clients** with status, PID, memory, and start time. Hover for actions, right-click for Copy PID. Row actions: **Focus**, **Restart**, **End**. Top toolbar: **Refresh**, **End all**, **Cleanup** (also clears leftover crash handlers).

## Accounts

**Add account** opens Roblox's real login page (2FA included). Sessions are encrypted and stay on this PC.

Card actions: **Launch**, **Refresh**, **Remove**, **Select** (for multi-launch). **Session expired** cards offer **Sign in again**.

## Sessions

After picking accounts + a target, **Save current setup** to relaunch it all with one click.

## Games

Browse popular games or search, then **Join** a card. Fleet uses your selected account so you join signed in. **Random Game** joins one from the list.

## People

Friends across your accounts, merged. Search users, filter by status, open profiles, **Join** when Roblox allows it. Requires an account.

## History

Every launch with time, account, result, and PID. **Clear history** wipes it.

## Settings

- **Roblox location** — auto-detect or manual path.
- **Theme** — system / light / dark.
- **Confirm before bulk actions**, **refresh interval**, **launch delay**, **instance warning threshold**, **history size**.

## Diagnostics

Environment info and a live log with level filters. **Copy diagnostics** when reporting problems.

## Keyboard

- `Ctrl+1–9` — switch sections
- `/` — focus search (Games, People)
- `Esc` — close any dialog or menu

## Troubleshooting

| Problem | Fix |
|---------|-----|
| **Roblox not found** | Install Roblox, or set the path manually in Settings (usually `%LOCALAPPDATA%\Roblox\Versions\version-…\RobloxPlayerBeta.exe`). |
| **New client closes after seconds** | Raise **Settings → Delay between launches**. |
| **"Multi-instance is unavailable"** | Reinstall Fleet (native helper failed to load). |
| **Focus doesn't raise the window** | Windows blocks foreground changes — click the taskbar button. |
| **PC slows down** | Each client uses ~0.5–1 GB RAM. Run only as many as you can handle. |
