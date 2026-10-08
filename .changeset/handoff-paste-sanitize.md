---
"@autonomos/server": patch
---

fix(security): a message delivered to a Gemini agent can't type keystrokes into it

Hand-delivered messages (and a re-delivered starting prompt) are pasted into the agent's terminal. A crafted message could end the paste early, so the rest was typed as raw keystrokes. For example, two Shift+Tabs switched a Gemini agent from its normal approval mode to "plan". Pasted text now has every control character removed except tabs and newlines, so it can't escape the paste.
