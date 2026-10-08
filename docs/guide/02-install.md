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
curl -fsSL https://autonomos.terrylu.cloud/install.sh | VERSION=0.6.1 bash
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

For release installs (the one-line installer), every download is checked twice before anything changes: against the release's SHA-256 checksum, and against its **signed build record**. The build record proves the file was built by autonomOS's own release workflow, not just uploaded to the release. If the record doesn't match, nothing is installed. If it can't be checked (GitHub or Sigstore unreachable, or rate-limited), an **update** is postponed: nothing changes, and you can try again later. A **first install** stops and asks you to re-run, so a new machine never starts from an unchecked download. To skip the check on purpose (a mirror, an offline machine), set `AUTONOMOS_SKIP_PROVENANCE=1`. For in-app updates, set it in the service's environment, not just your shell. autonomOS installs anyway and says, in amber, that it wasn't checked. Installs built from source (`make prod`) update from git and aren't covered by this check.

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

autonomOS usually lives on a server you reach from your laptop or phone, so who can reach its port matters. Every request needs your token, but the network in front of the port is the first line of defense. These are the setups, best first. Each survives restarts of the machine and of autonomOS.

### Recommended: Tailscale, served on this machine and your tailnet only

Install [Tailscale](https://tailscale.com) on the server and on each device you use, signed in to the same tailnet. Then tell autonomOS to listen on this machine (for the `autonomos` command) **and** on the server's tailnet address, and nowhere else:

```bash
autonomos install-service --force --host=127.0.0.1,$(tailscale ip -4)
# or with the FULL MagicDNS name:  --host=127.0.0.1,<server-name>.<tailnet>.ts.net
# (not the short name: /etc/hosts often maps the machine's own name to 127.0.1.1
#  or its cloud VPC address first; autonomOS warns if a name lands off the tailnet)
```

Open it from any of your devices at `http://<server-name>:3000` (MagicDNS) or `http://100.x.y.z:3000`. Your office or café network and the public internet can't reach it, Tailscale encrypts every connection, and autonomOS sees each device's own tailnet address, so its protections (the sign-in throttle, and the new-device lock for a short token) work per device. **Restarts are safe:** if autonomOS starts before Tailscale has connected (a reboot), it serves this machine at once and keeps retrying the tailnet address until Tailscale is up. Put `127.0.0.1` first in the list.

`install-service --force` rewrites the service file: if you installed with a custom `--port`, pass it again. Updates keep the list as it is.

### The default: all network interfaces

Without `--host`, autonomOS listens on **every** network the machine is on, on port 3000: your tailnet, but also the local network and, on a server with a public address, the internet. Opening `http://<server-name>:3000` over Tailscale works the same, but so does reaching the port from anything else that can route to the machine. Only use this together with a host firewall that allows the port on the Tailscale interface alone, for example on Linux with ufw:

```bash
sudo ufw allow in on tailscale0 to any port 3000 proto tcp
sudo ufw deny 3000/tcp
```

Firewall rules persist across reboots. On macOS, use the recommended setup above instead.

### `tailscale serve`: not yet

`tailscale serve` would give you an HTTPS address (`https://<server-name>.<tailnet>.ts.net`) without opening any port. Today, every visitor arriving through it reaches autonomOS from this machine itself, so autonomOS can't tell your devices apart, and its per-device protections treat everyone as this machine. Support that reads Tailscale's identity for each visitor is in progress; until it ships, use the recommended setup.

### Google Cloud IAP (a VM without a public address)

[Identity-Aware Proxy TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding) reaches a VM's port through your Google login, with no external IP. IAP connects to the VM's **internal** address, so keep the default bind (or list that address in `--host`), and let only IAP's range reach the port:

```bash
gcloud compute firewall-rules create allow-iap-autonomos \
  --network=<vpc> --allow=tcp:3000 --source-ranges=35.235.240.0/20
gcloud compute start-iap-tunnel <vm-name> 3000 --local-host-port=localhost:3000 --zone=<zone>
# then open http://localhost:3000 on your laptop
```

Who can open the tunnel is decided by IAM (the `IAP-secured Tunnel User` role). Give the VM no external IP, so nothing but IAP can reach the port.

### SSH

`ssh -L 3000:localhost:3000 <server>`, then open `http://localhost:3000`. This works with `--host=127.0.0.1`.

### Security notes

- **Don't open the port to the internet** (no router port-forwarding, no public firewall rule, no `tailscale funnel`). The token is the only lock on it.
- **On a plain local network, `http://` sends your token unencrypted** at sign-in and in the session cookie. Tailscale and IAP's tunnel encrypt it.
- **Repeated wrong tokens are throttled.** If your token is short, devices that have never signed in are locked out after 20 wrong tries in total, while devices you already use keep working. Unlock new devices with `autonomos auth unlock`. `autonomos token status` shows where things stand, and `autonomos token rotate` swaps in a long random token.

## Installing from source

If you want to change autonomOS rather than use it, follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Two things differ from the bundle install and matter if you read the rest of this guide: `make dev` keeps its data in `.autonomos-dev/` inside the checkout instead of `~/.autonomos/`, and the `autonomos` command is not on your PATH, so use `make restart` and `make logs` instead.
