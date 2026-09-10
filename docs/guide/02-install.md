# Installing

What the installer does, how to manage the background service, how to update, and how to remove it. For the shortest possible path, read [Start here](01-start-here.md) instead.

## Requirements

| Requirement | How to check | If missing |
|---|---|---|
| macOS or Linux | | Windows is not supported. |
| Node.js 20+ | `node --version` | Mac: `brew install node`. Linux: [nodejs.org package manager instructions](https://nodejs.org/en/download/package-manager). |
| Claude Code, logged in | `claude --version`, then `claude` starts without asking you to log in | Install from [claude.com/claude-code](https://claude.com/claude-code), run `claude` once, complete the login. |
| Codex CLI (optional) | `codex --version` | Only if you want Codex agents. See [Other runtimes](08-other-runtimes.md). |
| Gemini CLI (optional) | `gemini --version` | Only if you want Gemini agents. See [Other runtimes](08-other-runtimes.md). |

The installer checks Node but does not check for Claude Code. Without Claude Code the service starts and stops immediately; see [Troubleshooting](07-troubleshooting.md#the-installer-says-the-daemon-isnt-responding).

## The one-line installer

```bash
curl -fsSL https://autonomos.terrylu.cloud/install.sh | bash
```

Step by step, it:

1. Detects your operating system and CPU.
2. Downloads the matching autonomOS bundle from the latest GitHub release and verifies its checksum. You will see "[install] ✓ Checksum OK".
3. Puts the bundle in `~/.local/share/autonomos/` and a small `autonomos` command in `~/.local/bin/`.
4. Registers a background service: a launchd agent on macOS, a systemd user service on Linux. On Linux it also enables "lingering" so the service survives logging out.
5. Starts the service, waits up to 12 seconds for it to answer, and prints the dashboard address and your login token.
6. Opens the dashboard in your default browser.

Everything the service writes at runtime lives in one folder, `~/.autonomos/`: your token, agent records, templates, schedules, settings, and logs.

### If the installer warns about PATH

If you see "⚠️ ~/.local/bin is not on your PATH", your shell cannot find the `autonomos` command until you add that folder to its PATH. The installer prints the exact line to add to `~/.zshrc` or `~/.bashrc`. Add it, open a new terminal, and `autonomos status` will work. The service itself is unaffected; only the command is.

### Pinning a version

To install a specific release instead of the latest:

```bash
VERSION=0.6.1 curl -fsSL https://autonomos.terrylu.cloud/install.sh | bash
```

## The `autonomos` command

You rarely need it. When you do:

```
autonomos status        # is the service running, and on which port?
autonomos logs          # last 50 lines of the server log
autonomos logs -f       # follow the log live (Ctrl-C to stop)
autonomos restart       # stop and start the service
autonomos stop          # stop the background service (autonomos restart brings it back)
autonomos start         # run the server in the foreground (for a quick test; the service is the normal way)
autonomos upgrade       # update to the latest release
autonomos rollback      # go back to the version you had before the last upgrade
autonomos version       # print the installed version
autonomos help          # the full list
```

Stopping the service does not delete anything. autonomOS records which agents were running, and the next start brings them back where they were.

## Updating

The dashboard shows a small badge in the bottom bar when a newer release exists: "New release available (v0.6.1 → v0.7.0)". Nothing updates by itself. When you want it:

```bash
autonomos upgrade
```

This downloads the new release, verifies it, swaps it in, restarts the service, and checks that the new version starts. If it does not, it puts the old version back on its own. Your agents, token, and settings are untouched, and agents that were running come back.

If an upgrade works but you want the previous version anyway:

```bash
autonomos rollback
```

Re-running the one-line installer is also a supported way to upgrade.

You can turn off the daily check for new releases in Settings ("Update Check"). The dashboard itself never contacts GitHub; the server does, once a day.

## Uninstalling

```bash
autonomos uninstall-service
```

This stops the service and removes the launchd or systemd registration. It leaves your data in place so you can reinstall later. To remove everything:

```bash
autonomos uninstall-service
rm -rf ~/.local/share/autonomos ~/.local/bin/autonomos
rm -rf ~/.autonomos        # your token, agent records, settings, logs
```

Removing `~/.autonomos` is what makes the next install fresh. It does not touch Claude Code or its login.

## Running it on another machine

autonomOS is a server, so it can live on an always-on box you own, such as a home server or a small VPS, and you use it from any browser. That setup is a git checkout managed by the same `upgrade` and `rollback` commands. The machine needs `git` and [bun](https://bun.sh) as well as Node 20+ and Claude Code:

```bash
git clone https://github.com/aterrylu/autonomOS && cd autonomOS
bash scripts/install-source.sh            # installs to ~/autonomos at the newest release
bash scripts/install-source.sh --ref v0.6.1 --dir /srv/autonomos   # pin a version and a location
```

By default the server only listens on the machine it runs on. Reaching it from another computer means either an SSH tunnel to port 3000 or starting the service with `--host=0.0.0.0`, which exposes it to your network. Every request still requires the token. Remote setups are a developer topic beyond this guide; the root `README.md` covers them.

## Installing from source

If you want to change autonomOS rather than use it, follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Two things differ from the bundle install and matter if you read the rest of this guide: `make dev` keeps its data in `.autonomos-dev/` inside the checkout instead of `~/.autonomos/`, and the `autonomos` command is not on your PATH, so use `make restart` and `make logs` instead.
