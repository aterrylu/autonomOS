---
"@autonomos/server": patch
"@autonomos/app": patch
---

Fix Claude Code statusline not applying in the desktop app. Two runtime-loaded scripts (the statusline renderer and the per-agent MCP channel-server) were referenced by path but never copied into the bundled server, so spawned sessions silently lost the statusline and the agent messaging tools. The build now stages both scripts (with a manifest), path resolution is centralized in scriptPaths.ts so source and bundle stay consistent, the server warns at boot if a script is missing, and the bundle smoke test fails on any missing runtime script.
