# Glossary

Words as the app uses them, plus a few that only appear in the code or the developer docs, in case an AI assistant quotes them at you.

**Agent.** One running Claude Code, Codex, or Gemini session with a name, a folder, a permission mode, and a place in the org chart. The left column lists them under "Agents". The code calls the same thing a *session*; it is the same object.

**Auto-Trust.** A setting (on by default) that answers Claude Code's "do you trust this folder" and "loading development channels" prompts for you when an agent starts.

**Bypass.** The permission mode in which an agent never asks. See [Permissions and settings](06-permissions-and-settings.md).

**Channel.** A Claude Code extension point. autonomOS uses one, "autonomOS Gateway", to deliver messages between agents. Listed in Settings under "Channels".

**Config directory.** `~/.autonomos/` on the machine running autonomOS. Holds the token, agent records, templates, schedules, presets, settings, and logs. Removing it makes the next install fresh.

**Daemon, service.** The autonomOS server running in the background, started at login by macOS (launchd) or Linux (systemd). `autonomos status` tells you if it is up.

**Dashboard.** The web page. Bookmark it; the installer prints the address, normally `http://localhost:3000`.

**Deliver.** In the "Incoming messages" panel, the button that pastes a queued message into a Gemini agent's terminal, because Gemini cannot receive messages on its own.

**Dispatcher.** The built-in template for an agent that breaks work into tasks and hands them to other agents. The recommended first agent.

**Env preset, preset, Model Override.** A named set of environment variables that make an agent run on a different model provider through the same Claude Code program. Created on the "Presets" page; chosen in the form's "Model Override" field.

**Hooks, hook telemetry.** Developer term. Claude Code calls autonomOS at each step (tool started, tool finished, waiting for input, and so on); autonomOS builds the status labels from those calls. You never configure them.

**Incoming messages, hand-off queue.** The panel that appears on a Gemini agent's terminal when another agent has sent it something. You click "Deliver" to hand it over.

**Manager, report.** The org-chart relationship. An agent that creates another becomes its manager; the new one is its report. Work goes down the tree, results come back up.

**MCP tools.** Developer term. The small set of team actions autonomOS gives every agent: list agents, send a message, create an agent, set a manager, create a schedule, and a few more. You never call them; you ask an agent in plain language and it does.

**Needs input.** The amber status meaning the agent is waiting for you to answer something in its terminal. Click the row, read the question, answer.

**Org chart.** The page showing who reports to whom, with each agent's template and current status.

**Permission mode.** "Ask", "Accept edits", "Plan", or "Bypass": how often an agent stops to ask you. See [Permissions and settings](06-permissions-and-settings.md).

**Project.** In the left column's "Projects" section, a folder Claude Code has been run in, with the past sessions found there. Clicking "+" on one starts a new agent in that folder.

**Runtime.** The program an agent runs on: "Claude Code", "Codex CLI", or "Gemini CLI". The code calls this a *provider*.

**Schedule.** A recurring or one-time task that sends a prompt to a running agent at a set time. Created by asking an agent; listed on the "Schedules" page.

**Send, message.** One agent writing to another by name. Delivery is confirmed: autonomOS tells the sender only when the other agent has accepted the message.

**Session.** The code's word for an agent. Also Claude Code's word for one conversation, which is why the "Projects" list counts "sessions".

**Statusline.** The bottom line inside an agent's terminal, showing folder, cost, model, permission mode, and the agent's place in the team. Controlled by the "autonomOS Statusline" setting.

**Template.** A saved job description (role, instructions, default permission mode) used when creating an agent. Three come built in; the "Templates" page lets you add more.

**Token.** The password for the dashboard, generated at install, stored in `~/.autonomos/token`. Every browser that opens the dashboard needs it once.

**Unread.** The count on an agent's row of things that happened while you were looking elsewhere: it finished a turn, or it sent you a message. Clears when you open the agent.

**Worktree.** A git term you may see in agent messages: a second copy of a repository checked out to a different branch, so two agents can work on the same project without colliding. autonomOS does not create these; agents sometimes do.
