# Reading the dashboard

Every part of the window, what it shows, and what the words mean. Read top to bottom once; after that it is a reference.

## The window

```
┌──────────────────────────────────────────────────────────────┐
│ ☰  autonomOS                                                 │  top bar
├──────────────┬───────────────────────────────────────────────┤
│ ORG CHART    │ [Dispatcher] [Scout]                          │  tabs
│ TEMPLATES    │                                               │
│ SCHEDULES    │                                               │
│ PRESETS      │        terminal of the selected agent         │  panes
│ AGENTS  + New│                                               │
│  Dispatcher  │                                               │
│    Scout     │                                               │
│ PROJECTS     │                                               │
│  my-app   3  │                                               │
├──────────────┴───────────────────────────────────────────────┤
│ ⚙ my-mac  ● Connected           5h 26%  7d 5%  ◎ 30d 10%  🔔 │  status bar
└──────────────────────────────────────────────────────────────┘
```

The left column is where you find agents; the right area is where you talk to them. The bottom bar tells you about the server and your usage.

## Top bar

"☰" hides and shows the left column (also ⌘B). "autonomOS" is the name, nothing more.

## Left column

### The four pages

"Org Chart", "Templates", "Schedules", "Presets" each open as a tab on the right. [Working as a team](05-working-as-a-team.md) covers them. The org chart is the one you will use most: who reports to whom, each with its status.

### Agents

The list of running agents. The small icon next to the header toggles between a nested view (reports indented under their manager, the default) and a flat list; its tooltip reads "Switch to flat view" or "Switch to hierarchy view". "+ New" opens the "Create New Agent" form.

Each row has two lines:

```
 ●  Dispatcher            1 unread · now
    my-app · main                  Idle
```

- **Icon.** The runtime's logo (Claude, Codex, Gemini) with a small status ring, or a plain status icon if you chose "Status only" in Settings. A spinner means it is busy.
- **Name.** What you named it.
- **Unread.** "1 unread" in red: it finished a turn or received a message while you were looking at something else. Open the agent to clear it.
- **Age.** "now", "3m", "2h": how long since it last did anything. Fades as it gets older.
- **Folder · branch.** Second line, left: the folder it works in and, if that folder is a git repository, the branch.
- **Preset.** A gold pill with a preset name appears here if the agent runs on a model override.
- **Status.** Second line, right. See the vocabulary below.
- **"✉ 1".** A gold badge that appears only on Gemini agents when a message is waiting for you to deliver. See [Other runtimes](08-other-runtimes.md#gemini).

Click a row to open that agent's terminal. Right-click for "Open", "Restart", "Kill", "Delete…". Drag rows to reorder them. A pin icon on hover keeps an agent at the top.

### Status vocabulary

| Label | Meaning | What to do |
|---|---|---|
| **Ready** | Started and waiting for its first message. | Type something. |
| **Working** | Thinking or writing. | Wait. |
| **Running Bash**, **Running Edit**, … | Using a specific tool; the label names it. | Wait. |
| **Idle** | Finished its last turn, waiting for you or for a message. | Read what it did. |
| **Needs input** (amber) | Stopped to ask you something. | Click the row, answer in the terminal. |
| **Compacting** | Summarising its own long conversation to free memory. Brief. | Wait. |
| **Orchestrating** | Running its own sub-agents inside Claude Code. | Wait. |
| **Error** | The runtime reported a failure. | Open the terminal and read. |
| **Stopped** | The process ended. | Right-click, "Resume" or "Delete…". |

"Needs input" is the one to watch. Nothing that agent is responsible for moves until you answer, and if a manager is waiting on it, neither does the manager.

### Projects

Every folder in which Claude Code has been run on this machine, with a count of past conversations in each. autonomOS reads this from Claude Code's own records, so it includes folders you used before autonomOS existed and folders made by other tools. Expand a folder to see its past conversations; click one to bring it back as an agent with its history. Click "+" on a folder to start a new agent there.

Agents you kill also land here, under their folder, so you can resume them later.

## Tabs and panes

Each agent, and each of the four pages, opens as a tab across the top of the right-hand area. Click tabs to switch; close one with its "✕". Closing a tab does not stop the agent.

To see two things at once, drag a tab to the left, right, top, or bottom edge of the area and drop it; it becomes its own pane. Drag the divider between panes to resize. Panes that are not selected are dimmed slightly. This browser remembers your arrangement.

An agent's terminal is a real terminal: scroll with the trackpad or Shift+PageUp to read history. When you are scrolled up and new output arrives, a small "Jump to latest" button appears over the pane; click it, or type anything, to follow the bottom again.

## Status bar

Left to right:

- **Green badge with a computer name.** This is the Settings button; the name is the machine running autonomOS. Click it to open [Settings](06-permissions-and-settings.md#the-settings-panel).
- **"● Connected".** The browser can reach the server. "Checking..." while it verifies; "Disconnected" if the server went away, in which case it reconnects on its own.
- **"New release available (v0.6.1 → v0.7.0)".** Appears only when a newer version exists. Hover for the command; see [Updating](02-install.md#updating).
- **"5h 26%" and "7d 5%".** How much of your Claude subscription's five-hour and seven-day limits you have used, which autonomOS reads from your Claude Code login. Click for details and reset times. Amber "setup needed" means it could not find the login; see [Troubleshooting](07-troubleshooting.md#the-status-bar-says-setup-needed).
- **"30d 10%" with the Codex logo.** The same for Codex, shown only if Codex is logged in.
- **🔔.** Notifications: messages agents sent to you (not to each other), plus anything autonomOS itself needs to flag about a run. "Mark all read" clears them; "Load more" pages back. The counts on agent rows are separate and clear when you open the agent.

## Keyboard shortcuts

Press ⌘/ (Ctrl+/ on Linux) for the list. The ones worth remembering:

| Keys | Does |
|---|---|
| ⌘1 … ⌘9 | Switch to the 1st … 9th agent in the left column (hold ⌘ to see the numbers). |
| ⌘↑ / ⌘↓ | Previous / next agent. |
| ⌘K | Search agents by name. |
| ⌘B | Hide or show the left column. |
| ⌘/ | This list. |
| Esc | Close whatever is on top: a menu, a panel, the search. |

Everything else you type goes to the agent's terminal, exactly as in Claude Code, including Shift+Tab to change its permission mode and Ctrl+C to interrupt.

## Themes and the app

Settings → "Theme" cycles "Midnight", "Daylight", "Void". You can install the dashboard as an app from your browser's install option (Chrome: the icon at the right of the address bar; Safari: File → Add to Dock); it then opens in its own window and can show desktop notifications when an agent messages you.
