# Permissions and settings

Permission modes in detail, then every control in the Settings panel.

## Permission modes

Every agent has one of four modes, chosen in the "Create New Agent" form and shown in the terminal's bottom line. The mode decides when the agent stops to ask you.

| Mode | Claude Code | Codex | Gemini |
|---|---|---|---|
| **Ask** | "Prompts on each tool use" | "Asks on request (approval_policy: on-request)" | "Prompts on each tool use" |
| **Accept edits** | "Auto-accepts edits (acceptEdits)" | "Runs commands, asks only on failure (on-failure)" | "Auto-accepts edits (auto_edit)" |
| **Plan** | "Read-only plan mode" | "Not supported — falls back to Ask" | "Read-only plan mode" |
| **Bypass** | "Skips all prompts (--dangerously-skip-permissions)" | "No approvals (approval_policy: never)" | "Auto-approves everything (yolo)" |

These are the strings the "?" button in the form shows.

### How to think about it

- **Ask** for anything touching a folder you care about. The agent will ask in its terminal, the row will show "Needs input", and you answer with a number or Enter.
- **Accept edits** when you are watching and the agent is doing lots of small edits. It still asks before running commands or messaging other agents.
- **Plan** when you want an opinion, not a change.
- **Bypass** only for an agent working in a disposable folder, or a branch you can throw away. Nothing will stop it.

Agents that other agents create get the mode the creating agent asked for, or the template's default, or "Ask". A Dispatcher in "Ask" mode does not make its helpers "Ask"; each agent is set on its own.

### "Ask" is Claude Code's own default

autonomOS passes no permission flag to Claude Code for "Ask". That means "Ask" is whatever Claude Code does by default on this machine. If you have never changed Claude Code's settings, that is asking before each tool. If you have set a default permission mode in Claude Code's own settings file, an autonomOS agent in "Ask" mode inherits it, and the terminal's bottom line will say so, for example "auto mode on".

To check: look at the bottom line of any agent's terminal. To change it for one agent: press Shift+Tab in that terminal, as in Claude Code. To change it for future agents: set a different mode in the form, or change Claude Code's own default.

## The Settings panel

Click the green badge in the bottom-left corner of the window. It shows your computer's name, which is not obvious; its tooltip says "Settings". The panel has two groups.

### Dashboard

These are saved in this browser only.

- **Theme.** Click to cycle "Midnight", "Daylight", "Void". Void is pure black.
- **Permission Mode.** The mode the "Create New Agent" form starts with. The help text: "Preselects tool-use autonomy in Create Agent, overridable per spawn. Saved in this browser only — it does not change how agents spawned by other agents start, which is ask unless their template or the spawn request says otherwise."
- **Agent Icons.** "Provider + status" shows each agent's runtime logo with a status ring; "Status only" shows a plain status icon.

### Server

These are saved on the server and apply to every browser.

- **Auto-Trust.** "Auto-dismiss workspace trust and dev channel prompts on session start." On by default. When Claude Code starts in a folder for the first time it asks "Yes, I trust this folder"; it also warns when autonomOS loads the channel it uses to deliver messages. Auto-Trust answers both. Turn it off only if you want to see and answer those prompts yourself.
- **Update Check.** "Check GitHub daily for a newer release and show a passive badge in the status bar. The dashboard itself never contacts GitHub." On by default. Off means no badge; `autonomos upgrade` still works.
- **autonomOS Statusline.** "Show an autonomOS-aware statusline in spawned agents (replaces personal ~/.claude/settings.json statusLine for spawned sessions only). Applies to newly spawned agents." On by default. If you have your own Claude Code status line and prefer it, turn this off.
- **Channels.** The list of Claude Code channels autonomOS injects into every agent. "autonomOS Gateway" is the one that carries messages between agents and must stay on. The note "Requires Claude Code v2.1.80+" is a minimum version for message delivery.
- **Custom Environment Variables.** Key-value pairs handed to every new agent. Most people never need this. "Applied to all newly spawned sessions. Restart existing sessions to apply."
- **Save.** Writes the server-side settings. "Settings are injected as env vars. Save, then restart all sessions to apply changes to running sessions."
- **Restart All Sessions.** Stops and restarts every agent, resuming each one's conversation. It asks "Confirm restart" first. Use it after changing Channels or environment variables. Agents keep their history.

## The Claude usage bars

Bottom-right, "5h 26%" and "7d 5%" are how much of your Claude subscription's five-hour and seven-day limits you have used. autonomOS reads this from the Claude Code login already on the machine, read-only. Click for the detail panel, "Claude Rate Limits", with reset times and a "%" / "bar" display toggle.

If instead you see an amber "setup needed", autonomOS could not find a Claude Code login to read. Clicking it opens a "Claude Usage Setup" popover that asks for a session key copied from your browser's cookies on claude.ai. That flow is for people who log in to Claude Code in an unusual way; if you ran `claude` and logged in normally, "setup needed" should not appear. See [Troubleshooting](07-troubleshooting.md#the-status-bar-says-setup-needed).

The Codex bar ("30d 10%") appears only when a Codex login is present; it shows nothing otherwise.
