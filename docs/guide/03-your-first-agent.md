# Your first agent

The "Create New Agent" form, field by field, and what happens after you click "Create Agent".

## Opening the form

The form opens by itself the first time you log in with no agents. After that, click "+ New" next to "Agents" in the left column, or click "+" next to a folder under "Projects" to start an agent in that folder.

The heading reads "Create New Agent" with the line "Configure and spawn a new coding agent" under it. "Spawn" means start.

## Name

"Display name for this agent." Required. This is how the agent appears everywhere: in the left column, in the org chart, and in messages between agents. It is also how other agents address it, so keep it short and distinct. "Dispatcher", "Reviewer", "Scout" are good names. Two running agents cannot share a name; the form refuses the duplicate.

The form fills in the name from the template you pick until you type your own.

## Template

"Optional role template for the agent." A template gives the agent a job description before it starts. Three come built in:

| Template | What it is told to do |
|---|---|
| **Dispatcher** (marked "Recommended") | "Orchestrates work across agents. Breaks down tasks, assigns to workers, tracks progress." Start here. You give it goals; it spawns and manages helpers. |
| **Feature Worker** | "Implements features, fixes bugs, ships code. Works on one task at a time." What a Dispatcher usually spawns. |
| **Team Lead** | "Manages a team of agents. Plans work, reviews output, handles escalations." A middle manager for bigger fleets. |

"None" gives you a plain Claude Code session that knows it is inside autonomOS but has no role. Picking a template also sets the permission mode below to the template's default, which for the built-in three is "Ask". You can add your own templates from the "Templates" page; see [Working as a team](05-working-as-a-team.md#templates).

## Runtime

"Which coding agent CLI to use." The program the agent runs on: "Claude Code", "Codex CLI", or "Gemini CLI". Each card lists what that runtime can do inside autonomOS:

- "Message other agents"
- "Receive agent messages"
- "Live status"
- "Custom system prompt"

Claude Code has all four and is marked "Recommended with full support". Gemini shows "✗ Receive agent messages", which changes how other agents reach it; see [Other runtimes](08-other-runtimes.md). A runtime that is not installed on the machine shows "Not installed" with an "Installation guide" link and the note "After installing, reopen this panel (or reload the page)".

## Permissions

"How much autonomy this agent has over tool use." The one choice that matters for safety. The default is "Ask". Click the small "?" next to the dropdown to see what each mode does on each runtime.

| Mode | What it means |
|---|---|
| **Ask** | "Agent asks for approval before each privileged action." The agent stops and asks you in its terminal before editing files or running commands. Safe default. |
| **Accept edits** | "Auto-approves file edits; still gates riskier actions where the provider can." Edits go through without asking; commands and messages still ask. |
| **Plan** | "Read-only investigation — the agent plans but does not act." Good for "look at this and tell me what you would do". Not available for Codex. |
| **Bypass** | "Skips all permission prompts. Full autonomy." The agent never asks. Only for work you would let run unattended in a folder you can afford to have changed. |

One thing the form does not say: "Ask" means *whatever Claude Code's own default is on this machine*. If you have changed Claude Code's default permission mode in its settings, "Ask" inherits that. The terminal's bottom line tells you the truth: it reads "auto mode on" when Claude Code is auto-accepting edits. See [Permissions and settings](06-permissions-and-settings.md).

## Model Override

"Optional env preset applied at spawn (e.g. an alternate model backend)." Leave it at "None (default backend)". This is for running an agent on a different model provider through the same Claude Code program, and it needs a preset created on the "Presets" page first. See [Working as a team](05-working-as-a-team.md#presets).

## Working Directory

"Where the agent will run." The folder the agent can see and change. The options:

- **"Home (~)"**, marked "Default". Your home folder. Fine for a first conversation. Not a good place for real work: the agent can reach everything under it.
- **A folder from the list.** Every folder in which Claude Code has ever been run on this machine, most recent first, with a count of past sessions. Pick your project here.
- **"Custom..."** then "Enter a path". Type a full path such as `/Users/you/projects/my-app`. The folder must already exist.

Give each agent the narrowest folder that contains the work. Agents working on the same project can share a folder; the templates tell them to coordinate.

## After you click "Create Agent"

The button reads "Creating..." for a moment, then:

1. A tab opens on the right named after the agent, containing a terminal.
2. Claude Code starts in that terminal. You see its normal startup banner: its version, the model, the folder, and a line or two of tips. If Claude Code is configured on this machine with extra tools, you may also see a note like "N MCP servers need authentication · run /mcp". That comes from your own Claude Code setup, not from autonomOS, and you can ignore it.
3. The bottom line of the terminal is autonomOS's status line. It shows the agent's name and its place in the team ("standalone", or its manager and how many agents report to it), then the folder, cost so far, the model, and the permission mode. If it reads "[autonomos · offline]" the agent cannot reach the server; see [Troubleshooting](07-troubleshooting.md).
4. In the left column, the agent's row appears under "Agents" with the status "Ready".

If Claude Code asks whether you trust the folder, or warns about loading "development channels", autonomOS answers those for you within a second. That is the "Auto-Trust" setting, on by default.

## Talking to it

Click in the terminal and type. This is a real Claude Code session, so everything you know from Claude Code applies: slash commands, `/model`, pasting, Shift+Tab to cycle permission modes, Ctrl+C to interrupt.

While it works, the row on the left shows "Working" with a spinner, or "Running <tool name>" when it is using a tool. When it finishes, the row shows "Idle". If it sends you a message or asks for permission while you are looking at a different agent, the row also shows "1 unread".

When the agent needs you, the row turns amber and reads "Needs input". Click the row and answer in the terminal. That is the single most useful habit in autonomOS; [Working as a team](05-working-as-a-team.md#needs-input) explains it.

## What the agent knows that plain Claude Code does not

Each agent starts with a short briefing from autonomOS: its name, that it is part of a team, who its manager is, and a set of tools for the team: list the other agents, message one by name, start a new agent, set who reports to whom, create a schedule. The agent uses these when you ask it to, in plain language. You never call the tools yourself.
