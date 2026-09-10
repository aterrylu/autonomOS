---
"@autonomos/server": patch
---

fix(statusline): authenticate with the per-agent token so the statusline stops showing "[autonomos · offline]"

Since #297 (per-agent token delivery, ADR-055), spawned agents no longer carry the server's global `AUTONOMOS_TOKEN` in their PTY env — but `statusline.mjs` still read exactly that variable, so every Claude Code agent's statusline degraded to `[autonomos · offline]` while the server sat reachable one HTTP call away. Classic env-contract drift: the spawn side changed what it provides, the consumer script wasn't in the sweep.

Fix on both sides of the wire:

- **statusline.mjs** now authenticates the way #297 intends: it reads the per-session token file (`$AUTONOMOS_CONFIG_DIR/agent-tokens/$AUTONOMOS_SESSION_ID`, the same delivery the channel-server uses), falling back to `AUTONOMOS_AGENT_TOKEN` from the env, and calls the new self endpoint. The legacy `AUTONOMOS_TOKEN` path still wins when present (external/manually-run statuslines).
- **`GET /api/agents/:id/self`** — a minimal self-scoped endpoint authenticated by `verifyAgentToken` (the agent's own token authorizes only its own record; a cross-agent token gets 401). Exempted from the global bearer-token gate in `run.ts` the same way the hook-ingest route is. Returns just what the statusline renders: name, manager, direct reports, permission mode, status.

The test pins the **contract, not just the fix**: `buildBaseEnv` must keep providing `AUTONOMOS_AGENT_TOKEN` + `AUTONOMOS_CONFIG_DIR` + `AUTONOMOS_SESSION_ID` (what the script reads), and the route must 200 a self-token, 401 a foreign one, 404 a vanished record — so the next provider-env sweep can't silently re-strand the statusline.

Verified end-to-end on an isolated rig: a real spawned CC agent's statusline invocation (no `AUTONOMOS_TOKEN` in env) renders `[sl-qa · standalone]` where it previously rendered `[autonomos · offline]`.
