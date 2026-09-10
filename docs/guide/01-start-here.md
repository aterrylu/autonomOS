# Start here

Five minutes from nothing to a working agent. This page is the short path. Every step has a longer page if you want it.

## Before you start

You need three things on the computer that will run autonomOS:

1. **A Mac or a Linux machine.** Windows is not supported.
2. **Node.js 20 or newer.** Check with `node --version`. If that prints an error or a version below 20, install Node from [nodejs.org](https://nodejs.org/en/download/package-manager) or with `brew install node` on a Mac.
3. **Claude Code, installed and logged in.** Check with `claude --version`. If that prints an error, install Claude Code first ([claude.com/claude-code](https://claude.com/claude-code)), then run `claude` once in a terminal and complete the login it asks for. autonomOS cannot start without it, and its agents use that login.

Codex and Gemini are optional. You can add them later; see [Other runtimes](08-other-runtimes.md).

## 1. Install

Paste this into a terminal:

```bash
curl -fsSL https://autonomos.terrylu.cloud/install.sh | bash
```

It downloads autonomOS, checks the download, sets it up as a background service that starts when you log in, waits for it to come up, and then prints a block like this:

```
  ✓ autonomOS is running.
    Dashboard:  http://localhost:3000
    Token:      3f9a…   ← paste this at the login screen
    Manage:     autonomos status · autonomos logs -f · autonomos restart
```

It also opens the dashboard in your browser. If it did not, open the "Dashboard" address yourself.

If instead you see "⚠️ autonomOS installed, but the daemon isn't responding yet", go to [Troubleshooting](07-troubleshooting.md#the-installer-says-the-daemon-isnt-responding). The usual cause is that Claude Code is not installed.

## 2. Log in

The browser shows a page titled "autonomOS" with one field, "Paste token here...". Paste the token the installer printed and press Enter or click "Authenticate".

Lost the token? It is in a file. In a terminal on the same machine:

```bash
cat ~/.autonomos/token
```

## 3. Create your first agent

Because you have no agents yet, the dashboard opens the "Create New Agent" form for you. The defaults are good for a first run:

- **Name**: "Dispatcher" is filled in.
- **Template**: "Dispatcher" is selected and marked "Recommended". A Dispatcher is an agent that breaks work into tasks and hands them to other agents.
- **Runtime**: "Claude Code" is selected and marked "Recommended with full support".
- **Permissions**: "Ask". The agent will ask you before doing anything risky.
- **Working Directory**: "Home (~)". This is the folder the agent works in. For a first run it does not matter. For real work, pick the project folder you want the agent to touch, or choose "Custom..." and type a path.

Click "Create Agent".

A terminal pane opens on the right and Claude Code starts inside it. This takes a few seconds. On the left, under "Agents", a row appears: "Dispatcher" with the status "Ready".

## 4. Talk to it

Click inside the terminal pane and type, exactly as you would in Claude Code:

```
Hi. In one paragraph, what can you do for me here?
```

Press Enter. The row's status changes to "Working" while it thinks, then to "Idle" when it has answered. The answer appears in the terminal.

You are now using autonomOS. Everything else is more of this: more agents, agents that talk to each other, and a screen that shows you what they are all doing.

## Where to go next

- The form you filled in, field by field: [Your first agent](03-your-first-agent.md)
- What every part of the screen means: [Reading the dashboard](04-reading-the-dashboard.md)
- Ask the Dispatcher to spawn a helper and watch them coordinate: [Working as a team](05-working-as-a-team.md)

## Stopping

You do not need to stop anything. Agents wait for you when idle, and the service keeps running in the background. If you want it gone from your machine, see [Uninstalling](02-install.md#uninstalling).
