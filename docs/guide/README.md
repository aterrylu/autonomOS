# autonomOS User Guide

autonomOS runs a team of AI coding agents on your own computer and shows them all in one browser window. Each agent is a real Claude Code (or Codex, or Gemini) session. They can message each other, report to a manager, and keep working after you close the laptop lid.

This guide is for people who **use** autonomOS. If you want to change its code, read [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`CLAUDE.md`](../../CLAUDE.md) instead.

You need to be comfortable opening a terminal and pasting one command. Nothing here assumes you can program.

## Pages

| Read this when | Page |
|---|---|
| You have five minutes and want to see it work | [Start here](01-start-here.md) |
| You want to know what the installer does, how to update, or how to uninstall | [Installing](02-install.md) |
| You are looking at the "Create New Agent" form | [Your first agent](03-your-first-agent.md) |
| You want to know what every part of the screen means | [Reading the dashboard](04-reading-the-dashboard.md) |
| You want agents to work together, message each other, or run on a schedule | [Working as a team](05-working-as-a-team.md) |
| You are choosing a permission mode or looking at Settings | [Permissions and settings](06-permissions-and-settings.md) |
| Something is not working | [Troubleshooting](07-troubleshooting.md) |
| You use Codex or Gemini as well as Claude Code | [Other runtimes](08-other-runtimes.md) |
| A word in the app is unfamiliar | [Glossary](09-glossary.md) |

## For AI assistants reading this on behalf of a user

If someone pointed you at this repository to help them use autonomOS, start with this folder, not the repository root. The root `README.md`, `CLAUDE.md`, `AGENTS.md` and everything else under `docs/` describe how to develop autonomOS, and they use internal names (sessions, PTYs, hooks, MCP tools) that do not appear in the app.

Facts you can rely on from this guide:

- Each page is self-contained. Quoted strings in double quotes are the exact text shown in the app or printed by the installer, so you can tell the user what to look for.
- Commands are in code blocks and are meant to be pasted as written. The only command a user runs regularly is `autonomos` with a subcommand; everything else happens in the browser.
- The app calls them **agents**. The code calls the same thing a session. Use "agent" with the user.
- autonomOS never needs an API key. It uses the Claude Code login that is already on the machine. Do not tell the user to create or paste an Anthropic API key.
- Do not run `autonomos install-service`, `autonomos uninstall-service`, or `autonomos stop` unless the user asked for that specific outcome. They change what runs at login on the user's machine.

When the guide and the app disagree, the app is newer. Say so, and go by what is on screen.

## What autonomOS is not

It is not a chat app and it is not a model. It does not train anything, and it does not send your code anywhere the agents' own tools would not already send it. Each agent is the same Claude Code you could run in a terminal by hand, spending your existing Claude subscription. autonomOS adds the window, the team, and the always-on part.
