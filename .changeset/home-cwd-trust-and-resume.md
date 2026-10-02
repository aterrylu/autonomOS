---
"@autonomos/server": patch
---

fix(claude-code): agents in your home folder no longer die on start, and a fast exit never throws away a saved conversation

An agent whose working folder is your home folder sees Claude Code's "trust this folder" question on every start (Claude Code never remembers trust for the home folder), and autonomOS answers it for you. It used to answer too early: Claude Code would draw the selection on "Yes", then reset it to "No, exit" by itself, and the answer closed the agent. Restarts and deploys could then lose these agents. autonomOS now waits until the question has finished drawing, moves the selection to "Yes", and only confirms once "Yes" has stayed selected.

When a resumed agent closed within a few seconds, autonomOS assumed its saved conversation was broken and started a fresh one, which lost the conversation. Now it retries the same conversation twice; if it still won't start, the agent is left stopped with a notice that its conversation is intact, and restarting it tries again. A new conversation is started only when there is no saved one to resume.
