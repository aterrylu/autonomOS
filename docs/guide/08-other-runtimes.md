# Other runtimes

Everything else in this guide assumes Claude Code. Codex and Gemini agents work in the same window with a few differences.

## What each runtime can do

| | Claude Code | Codex | Gemini |
|---|:---:|:---:|:---:|
| Run as an agent | yes | yes | yes |
| Live status in the left column | yes | yes | yes |
| Send messages to other agents | yes | yes | yes |
| Receive messages from other agents | yes | yes, shown inline | no, you deliver by hand |
| Permission modes | all four | Ask, Accept edits, Bypass (no Plan) | all four |
| Usage bar in the bottom right | yes | yes | no |
| Come back after a restart with its history | yes | yes | no, starts fresh |

This is the same table the "Create New Agent" form summarises on each runtime card.

## Setting up a runtime

autonomOS looks for the `codex` and `gemini` commands when it starts. Install the runtime the way its maker documents, log in to it once in a normal terminal, then reopen the "Create New Agent" form. The runtime card changes from "Not installed" to a selectable card. If it still shows "Not installed", run `autonomos restart`.

autonomOS never asks for API keys for any runtime. It uses the login each program already has.

## Codex

A Codex agent is a real Codex session. Two things look different:

- **Messages arrive inline.** When another agent messages a Codex agent, the text appears in its conversation immediately, even mid-task. Codex handles the timing itself.
- **The usage bar** ("30d 10%") appears in the bottom bar as soon as a Codex login exists on the machine, and shows nothing at all when it does not.

Codex has no "Plan" mode; the form shows "Plan (n/a)" and falls back to "Ask".

## Gemini

A Gemini agent is a real Gemini CLI session. The one difference that changes how you work:

**Gemini cannot receive messages on its own.** When another agent sends something to a Gemini agent, it waits in a queue, and you hand it over:

- The Gemini agent's row shows a gold "✉ 1" badge (tooltip: "1 awaiting your delivery").
- Its terminal shows a small floating panel titled "Incoming messages", listing each waiting message with the sender's name.
- Click **"Deliver"** to paste that message into the terminal as if you had typed it. The panel confirms once the agent has actually taken it; until then it stays in the queue. **"Discard"** drops it.

You can drag the panel out of the way; it remembers where you put it.

Two smaller differences: there is no usage bar for Gemini, and a Gemini agent that is restarted starts a fresh conversation instead of resuming the old one.

## Mixing runtimes

A team can mix all three. A Claude Code Dispatcher can spawn a Codex worker and a Gemini reviewer, message both, and read their replies; the org chart shows each with its own logo. The only thing to remember is the Gemini hand-off above: if a Gemini agent seems to be ignoring its manager, check its row for the "✉" badge.
