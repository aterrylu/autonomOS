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

The installer checks for both Node and Claude Code before it downloads anything. Without Claude Code it stops with "Error: Claude Code is required and was not found on PATH." and a three-step fix (install it, run `claude` once to log in, re-run the installer). The server refuses to start without Claude Code, so there is no point installing around it; if you must, `SKIP_CLAUDE_CHECK=1` in front of the command skips the check and the service will crash-loop until Claude Code exists.

## The one-line installer

```bash
curl -fsSL https://autonomos.terrylu.cloud/install.sh | bash
```

Step by step, it:

1. Detects your operating system and CPU, and checks that Node 20+ and Claude Code are present.
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

When a newer release exists, the status bar shows **Update to v0.8.0**. Nothing updates by itself. Click it to open one screen that shows:

- **Your agents, live.** If they're all idle, they reopen where they left off. If one is mid-task, it's named, with what a restart would cost it.
- **What's safe.** A snapshot of your agents, schedules, templates, presets and settings is saved first. If the new version doesn't start, autonomOS restores the old one on its own. You stay signed in.
- **What's new.** The release notes for every version since yours. If a release says some agents might not reopen after it, a warning above the notes says so, and that Restore brings them back.

Then pick one:

- **Update and restart** when every agent is idle.
- **Update when idle** when an agent is busy. autonomOS waits until every agent has been idle for 30 seconds, then updates. The amber pill in the status bar shows who it's waiting for: click it to see the wait or update right away, or click **Cancel**.
- **Update now** when an agent is busy and you'd rather not wait. The button names who it interrupts.

Progress shows on the same screen: Preparing, Restarting, Reopening agents. The page reloads onto the new version and confirms your agents reopened.

Settings → Updates has **Check for updates** (look for a release right away), **Update…** when one is available, and **Restore v…**, which puts back the previous version together with the snapshot from before the update. If autonomOS is not running as a service, the dialog shows the terminal command instead.

From a terminal, the same update:

```bash
autonomos upgrade
```

Your token and settings are untouched, and agents that were running reopen. If an update works but you want the previous version anyway:

```bash
autonomos rollback
```

This restores the previous version and the snapshot from before the update. What you changed since is saved as a snapshot first; undo the restore (Settings → Updates) to get it back.

Re-running the one-line installer is also a supported way to upgrade.

You can turn off the daily check for new releases in Settings → Updates (**Check for updates daily**). The dashboard itself never contacts GitHub; the server does, once a day.

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

See the next section for how to reach it from your other devices.

## Using it from your other devices

By default the server listens on **all network interfaces**, on the port the installer printed (3000 unless you chose another). The `install-service --force` commands below rewrite the service file: if you installed with a custom `--port`, pass it again. Any device that can reach that port can open the dashboard, and every request needs your token. What decides who can *reach* the port is the network in front of it, so pick one of these instead of exposing it to your whole network or the internet.

### Over Tailscale (most setups)

Install [Tailscale](https://tailscale.com) on the server and on each device you'll use, signed in to the same tailnet. Then open the server by its tailnet name (with MagicDNS) or its `100.x.y.z` address:

```
http://<server-name>:3000            (or http://<server-name>.<your-tailnet>.ts.net:3000)
```

Tailscale encrypts the connection end to end, and your tailnet's access rules decide which devices can reach it. Two ways to tighten it further:

- **Listen on the tailnet only.** Bind the server to the machine's tailnet address so nothing else on the local network can reach it:
  ```bash
  autonomos install-service --force --host=100.x.y.z     # this machine's tailnet IP (tailscale ip -4)
  ```
  If Tailscale isn't up yet when the machine boots, the server can't bind that address and the service retries until it is.
- **Keep it on this machine and let Tailscale serve it over HTTPS.** Bind to localhost, then publish it to your tailnet with `tailscale serve`:
  ```bash
  autonomos install-service --force --host=127.0.0.1
  tailscale serve --bg 3000          # → https://<server-name>.<your-tailnet>.ts.net
  ```
  Every visitor then reaches autonomOS from the machine itself, so autonomOS can't tell your devices apart: its per-device protections (the sign-in throttle, and the new-device lock for a short token) see one address. Your tailnet's access rules are the boundary. Never use `tailscale funnel` for autonomOS: that publishes it to the whole internet.

### Over Google Cloud IAP (a VM without a public address)

[Identity-Aware Proxy TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding) lets you reach a VM's port through your Google login, with no external IP and no open firewall to the internet:

```bash
# once: let IAP's address range reach the port (and nothing else)
gcloud compute firewall-rules create allow-iap-autonomos \
  --network=<vpc> --allow=tcp:3000 --source-ranges=35.235.240.0/20
# each time: forward the VM's port to your laptop, then open http://localhost:3000
gcloud compute start-iap-tunnel <vm-name> 3000 --local-host-port=localhost:3000 --zone=<zone>
```

Who can open the tunnel is decided by IAM (the `IAP-secured Tunnel User` role). Keep the server on its default bind: IAP connects to the VM's internal address, not to localhost.

### Over SSH

From any machine with SSH access: `ssh -L 3000:localhost:3000 <server>`, then open `http://localhost:3000`. This works with the server bound to `--host=127.0.0.1`.

### Security notes

- **Don't expose the port to the internet** (no router port-forwarding, no public cloud firewall rule, no `tailscale funnel`). The token is the only lock on it.
- **On a plain local network, `http://` sends your token unencrypted** at sign-in and in the session cookie. Tailscale encrypts it; `tailscale serve` and IAP's tunnel also give you an encrypted path.
- **Repeated wrong tokens are throttled.** If your token is short, devices that have never signed in are locked out after 20 wrong tries in total, while devices you already use keep working. Unlock new devices with `autonomos auth unlock`. `autonomos token status` shows where things stand, and `autonomos token rotate` swaps in a long random token.

## Installing from source

If you want to change autonomOS rather than use it, follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Two things differ from the bundle install and matter if you read the rest of this guide: `make dev` keeps its data in `.autonomos-dev/` inside the checkout instead of `~/.autonomos/`, and the `autonomos` command is not on your PATH, so use `make restart` and `make logs` instead.
