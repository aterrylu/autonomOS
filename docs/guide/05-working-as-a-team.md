# Working as a team

How agents create each other, message each other, report to each other, and run on a schedule. You do everything here by talking to an agent in plain language; there is nothing to configure.

## The shape of a team

autonomOS gives every agent a small set of team abilities: it can see who else is running, message any of them by name, start a new agent, and say who reports to whom. A Dispatcher uses those to turn your goal into a team.

The pattern that works:

1. Create one **Dispatcher** (the recommended first agent).
2. Give it a goal in its terminal, the way you would brief a person.
3. It creates workers, briefs them, waits for their reports, and tells you when it is done.
4. You watch the left column and the org chart, and step in when a row says "Needs input".

You can also create every agent yourself with "+ New" and never use a Dispatcher. Agents you create by hand start with no manager.

## Asking an agent to create another

Type something like this into the Dispatcher's terminal:

```
Spawn one Feature Worker named Scout in this same folder. Ask it to write a three-line haiku into haiku.md and report back to you when it is done.
```

What you will see, in order:

- The Dispatcher's row shows "Working", then "Running <tool>" while it calls the team tools.
- A new row, "Scout", appears **nested under** the Dispatcher in the left column. Nesting means Scout reports to the Dispatcher.
- Scout's terminal opens as a new tab; Claude Code boots in it with the brief the Dispatcher wrote.
- Scout works. If it needs permission for something, its row turns amber, "Needs input". Click it, read the prompt, answer.
- Scout reports back. In the Dispatcher's terminal a line appears that begins "← autonomos: [Scout → you via agent://Scout]" followed by the message. That line is the message arriving.
- The Dispatcher summarises for you.

The whole thing takes a minute or two. The agent that creates a helper chooses the helper's folder; in the example it used its own because we asked. Say so if you want a different one.

## Messages between agents

Agents address each other by name. When one sends, autonomOS delivers straight into the other's terminal and tells the sender whether the message was accepted. There is no mailbox to check and no broadcast; every message has exactly one recipient.

Seen from your side:

- In the recipient's terminal, an incoming message looks like "← autonomos: [Sender → you via agent://Sender] …". The agent reads it as part of its conversation and usually acts on it.
- The recipient's row shows "Working" while it handles the message. Agent-to-agent messages do not add to your unread counts; only messages to you do.
- You can ask any agent to message any other: "Tell Reviewer the branch is ready." You do not type addresses yourself.

Gemini agents cannot receive messages directly. For them, messages wait in an "Incoming messages" panel on the agent's terminal until you click "Deliver". See [Other runtimes](08-other-runtimes.md#gemini).

## Needs input

An amber row with the label "Needs input" is an agent waiting for you. It happens whenever the agent's own runtime stops to ask something: permission to edit a file or run a command, a question it cannot answer alone, or Claude Code's own "Do you want to proceed?" prompt before using a team tool.

Click the row. The terminal shows the question with numbered options, for example:

```
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for autonomos — Send commands in /path/to/folder
  3. No
```

Type the number and press Enter, or press Enter alone for the highlighted option. Option 2, where offered, is Claude Code's own "don't ask again"; Claude Code remembers it for that folder from then on, for any agent working there. Nothing else moves until you answer, including a manager waiting on that agent's report.

## The org chart

Click "Org Chart" at the top of the left column. Each agent is a card with its runtime icon, its name, its template, and its current status. Lines connect managers to their reports. With one agent the chart is one card.

autonomOS derives the chart from who created whom, and from any manager an agent sets explicitly. To change it, ask an agent: "Make Reviewer report to Team Lead." To see it as text, ask any agent to describe the org chart.

If the chart cannot be drawn for a moment while agents are starting, the left column shows "Hierarchy syncing" and offers "Show flat" to list agents without nesting.

## Templates

Click "Templates" in the left column. A template is a saved job description: a role, a description, a system prompt (the instructions the agent starts with), a default permission mode, and optionally a model. The three built in, "Dispatcher", "Feature Worker", and "Team Lead", cover most teams.

"+ New Template" opens an editor. The name is "lowercase-with-dashes" and cannot change later. Write the system prompt as you would brief a new colleague: what they own, what they should not do, when to report back. Agents can also create templates when you ask them to.

Each card shows how many agents are currently running from that template.

## Schedules

Click "Schedules". A schedule sends a prompt to a running agent at a set time, once or on a repeat. There is no form; you ask an agent, and the page shows what it set up. The empty state gives examples:

- "Set up a daily GitHub summary at 9am"
- "Schedule a weekly dependency audit"
- "Run a PR review check every 30 minutes"

Say any of those to an agent and a card appears on the page with the schedule, its next run, and a run history. The agent the schedule targets has to be running when it fires; if it is not, autonomOS records that run as failed and the next one tries again. The page's "Max runs" number is how many schedules may run at once.

Each card has "Run now" and "Delete". To pause or change a schedule, ask an agent.

## Presets

Click "Presets". A preset lets an agent run on a different model provider, for example a Kimi model, while still using the Claude Code program and everything in this guide. Creating one takes two steps: an agent (or you, with "+ New") defines the preset, then **you** paste the provider's API key into the preset's card on this page. Agents cannot see or set the key. When you create an agent, the preset appears in the form's "Model Override" field.

Most people never need this page.

## Watching more than one agent

Each agent opens in a tab across the top of the right-hand area. To see two at once, drag one tab to the left, right, top, or bottom edge of the area; it docks there as a split. Drag the divider to resize. Close a pane with the "✕" on its tab; the agent keeps running, and clicking its row reopens it.

Keyboard: ⌘1 to ⌘9 jump to the first nine agents in the left column, ⌘↑ and ⌘↓ move between them, ⌘K opens a search by name, ⌘B hides the left column, ⌘/ lists every shortcut. Escape closes whatever is on top.

## Stopping and removing agents

Right-click any agent row:

- **Open** shows its terminal.
- **Restart** stops the agent and starts it again on the same conversation.
- **Kill** stops it. The row moves to the "Projects" section, where **Resume** brings it back with its history.
- **Delete…** removes the record. It asks "Delete permanently?" first.

An agent that finishes its job may end itself; workers created by a Dispatcher often do. That is normal, and its record stays under "Projects" until you delete it.
