# Telegram & Discord Channel Setup

autonomOS spawns Claude Code sessions with the `--channels` flag so agents
can receive and reply to messages from Telegram, Discord, or the built-in
`server:autonomos` gateway. This guide walks through enabling the
Telegram and Discord channels from scratch.

## Prerequisites

- **Claude Code ≥ 2.1.80** — `claude --version`
- **claude.ai login** — required for official channel plugins
- Plugin-level `channelsEnabled` not set to `false` (only relevant on
  Team/Enterprise plans; admins can gate this at the org level)

## 1. Install the plugin on the host

From inside any Claude Code session:

```
/plugin install telegram@claude-plugins-official
/plugin install discord@claude-plugins-official
/reload-plugins
```

`claude plugin list` (from a terminal) should now show both plugins with
`Status: ✔ enabled`. The autonomOS dashboard reads the same list to
populate the Channels section.

## 2. Configure the bot credentials

### Telegram

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram,
   run `/newbot`, and copy the bot token.
2. Start a Claude Code session anywhere on the host and run:
   ```
   /telegram:configure <bot-token>
   ```
3. The plugin writes credentials to `~/.claude/channels/telegram/.env`.

### Discord

1. Create a bot application at
   [Discord Developer Portal](https://discord.com/developers/applications),
   note the bot token, enable the **MESSAGE CONTENT INTENT**.
2. Invite the bot to your server with the `bot` scope and the permissions
   the plugin documents (typically `Send Messages`, `Read Message History`).
3. In any Claude Code session:
   ```
   /discord:configure <bot-token>
   ```
4. Credentials land in `~/.claude/channels/discord/.env`.

Credentials persist across autonomOS restarts — they live on the host,
not inside the dashboard settings.

## 3. Enable the channel in autonomOS

1. Open the dashboard (`make dev` on `:3101`, `make prod` on `:3100`).
2. Click the gear icon in the status bar → scroll to **Channels**.
3. Toggle the desired channel(s) on. Click **Save changes**.

Once saved, `settings.channels` gets the new identifier. Every
subsequent session spawn (including `claude --resume`) will receive the
`--channels plugin:telegram@claude-plugins-official` flag.

### What the UI shows

- **✓ green** — plugin installed, enabled, selectable.
- **🔒 greyed out + "Not installed"** — the plugin is missing. The tooltip
  shows the exact `/plugin install ...` command to fix it. You
  can't toggle ON until you install it (the server rejects the save too).
- **🔒 greyed out + "Disabled"** — the plugin is present but disabled via
  `/plugin disable ...`. Tooltip shows the same `/plugin install ...`
  command — it re-enables the plugin in one step (no separate `enable`
  command to remember).
- **"Status unknown"** — the subprocess probe failed. Toggle stays
  interactive so a flaky environment doesn't lock you out of settings.

## 4. Pair the bot

Official plugins gate inbound messages on a sender allowlist. To pair:

1. From your personal Telegram/Discord account, DM the bot.
2. The plugin emits a pairing code in the terminal of any running
   autonomOS-spawned session. Find the code in a session's output.
3. In that session, run:
   ```
   /telegram:access pair <code>
   ```
   (replace `telegram` with `discord` for Discord).
4. The allowlist is persisted to `~/.claude/channels/telegram/access.json`
   (or `.../discord/access.json`). Subsequent DMs from your account are
   delivered as `<channel source="telegram" ...>` events.

## 5. Verify the loop

1. DM the bot — the session should receive the message as a channel event.
2. The agent replies via the plugin's reply tool (scoped to inbound
   context) — the reply appears in the chat.
3. Restart `autonomos-server`. Resumed sessions still have the
   `--channels` flag (settings are re-read on every spawn).
4. DM the bot again — inbound still works after restart.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Toggle is greyed out with "Not installed" | Plugin not on host | Run `/plugin install <id>` in any CC session, then `/reload-plugins` |
| Toggle is greyed out with "Disabled" | Plugin disabled | Run `/plugin install <id>` — this also re-enables disabled plugins |
| Bot doesn't respond to DMs | Not paired yet | Run `/telegram:access pair <code>` |
| Pairing code doesn't appear | Session has no tty output, or plugin not loaded | Verify `--channels` flag with `ps` or check terminal output |
| New sessions lack the flag after toggle | Old sessions need a restart | Existing PTYs don't re-read settings; use the Restart All button |
| `claude plugin list --json` hangs | Binary resolution issue | Check `AUTONOMOS_SERVER` logs; 5s subprocess timeout falls back to "unknown" status |

## Security notes

- Sender allowlist is enforced per-plugin; pair only accounts you trust.
- Channel plugins are a research preview — syntax may change. autonomOS
  isolates the flag plumbing in `packages/server/src/providers/claude-code.ts`
  (one function), so a syntax change is a small fix.
- Never check in channel credentials. They live outside the autonomOS
  config (`~/.claude/channels/...`), so they aren't copied when you copy
  your `~/.autonomos/settings.json`.
