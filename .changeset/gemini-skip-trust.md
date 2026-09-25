---
"@autonomos/core": patch
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Gemini agents now keep the permission mode you picked in folders Gemini doesn't trust. Before, Gemini stopped on its own "Do you trust the files in this folder?" dialog and ran as Ask until someone answered it, so a Bypass agent could silently act like Ask. With Auto-Trust on (the default), agents trust their folder for that session only, with nothing written to Gemini's own trust list. With Auto-Trust off, you get a notice explaining why the agent is waiting. The Auto-Trust setting's description now says what trusting means for both Claude Code and Gemini.
