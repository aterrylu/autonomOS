# Troubleshooting

Problems in roughly the order a new user meets them. The first rule: when something stops with no explanation, the reason is in the log.

```bash
autonomos logs
```

The server writes warnings and errors only there, never to the terminal you started it from.

## `autonomos: command not found`

The command lives in `~/.local/bin`, and that folder is not on your PATH. The installer printed the line to add to your shell file when this is the case. Add it to `~/.zshrc` (Mac) or `~/.bashrc` (Linux):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Open a new terminal window and try again. The service itself is fine; only the command was missing.

## The installer says the daemon isn't responding

The exact text is "⚠️ autonomOS installed, but the daemon isn't responding yet." with "Check: autonomos status and autonomos logs". The service started and stopped within 12 seconds. The two usual reasons:

1. **Claude Code is not installed.** The server refuses to start without it. Run `claude --version`; if that fails, install Claude Code, log in to it once, then `autonomos restart`.
2. **Something else is using the port.** The log will say so. Restart after freeing the port, or see the developer docs for changing it.

Either way, the log has the reason:

```bash
autonomos logs
```

## I lost the login token

It is in a file on the machine running autonomOS:

```bash
cat ~/.autonomos/token
```

Paste the whole line into the login page. It is long; make sure you copied all of it.

## "Invalid token"

The token you pasted does not match the one the server is using. Copy it again from `~/.autonomos/token`, checking for a missing first or last character. If you or someone else started the server with a token set by hand (an `AUTONOMOS_TOKEN` environment variable), the file is not the live token; ask whoever set it.

## "Cannot reach server — check that it is running"

The browser cannot reach autonomOS.

```bash
autonomos status
```

If it reports the service is not running, `autonomos restart`, then reload the page. If the service is running but on a different port than the address in your browser, `autonomos status` shows the right port.

The dashboard shows "Connecting..." and later "Cannot connect to server" with a "Retry" button in the same situation after you have logged in.

## The dashboard shows "Disconnected" in the bottom bar

The server went away while you had the page open, usually because it restarted. The page reconnects by itself within a few seconds. Agents survive a server restart; they resume where they were.

## An agent's row says "Needs input" and nothing is happening

That is the agent waiting for you. Click the row and answer the question in its terminal, typically by pressing a number and Enter. Managers waiting on that agent wait too, so do not leave it waiting. See [Working as a team](05-working-as-a-team.md#needs-input).

## An agent's terminal says "[autonomos · offline]"

The autonomOS status line at the bottom of an agent's terminal reads "offline" even though messages and status work. In the current release this is a display bug affecting every Claude Code agent, not a connection problem. Ignore it. It is being fixed.

## An agent's terminal says "N MCP servers need authentication"

That message comes from Claude Code's own configuration on this machine, listing tools you set up in Claude Code outside autonomOS that need a login. autonomOS agents inherit that configuration. It does not affect autonomOS; run `/mcp` inside the terminal if you want to log those tools in.

## The status bar says "setup needed"

autonomOS could not find a Claude Code login to read your usage from. It looks in the same place Claude Code keeps its own login. Run `claude` in a normal terminal on the same machine and complete its login, then reload the dashboard. The "Claude Usage Setup" popover that opens when you click "setup needed" offers a manual alternative, pasting a session key from claude.ai's cookies, for setups where that lookup cannot work. Usage tracking is a display only; agents run fine without it.

## The status bar shows "err" or "delayed" instead of usage

"delayed" is a temporary problem talking to Anthropic's usage service and clears on its own; clicking it shows "Retry now". "err" means the stored login stopped working; clicking it offers "Reconfigure". Neither affects agents.

## The "Projects" list is full of folders I don't recognise

That list is every folder Claude Code has ever been run in on this machine, including ones created by tools and tests. autonomOS reads it from Claude Code's own history, and it is harmless. Use the search in the "Create New Agent" form's folder list, or "Custom...", to get to the folder you want.

## The agent is working in the wrong folder

Check the second line of its row in the left column: it shows the folder name (and the git branch when there is one). The folder was chosen at creation and cannot change; kill the agent and create a new one in the right folder.

## The dashboard is broken after an update or a crash

If the page shows "The dashboard hit an error", click "Reset layout & reload". That clears only the arrangement of tabs and panes; agents, theme, and settings stay. If it happens again, the page offers "Clear all saved data & reload", which also resets theme and sidebar preferences. Neither one affects agents.

## I want to start over completely

```bash
autonomos uninstall-service
rm -rf ~/.autonomos
```

Then run the installer again. All agents, templates, schedules, presets, and the token are gone; Claude Code and its login are untouched. See [Installing](02-install.md#uninstalling).

## Something else

- `autonomos status` says whether it is running and where.
- `autonomos logs -f` shows what it is doing right now.
- The repository's issue tracker is at [github.com/aterrylu/autonomOS/issues](https://github.com/aterrylu/autonomOS/issues). Include the last twenty lines of `autonomos logs` and your `autonomos version`.
