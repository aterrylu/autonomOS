---
"@autonomos/server": patch
---

fix(runtime): Codex crash-net retains the resumable thread (ADR-100)

A crashed Codex agent that resumed via `providerThreadId` had its thread cleared
by the ADR-049 onExit safety net and was force-respawned fresh — severing the
only link to its still-on-disk rollout and losing the conversation. The
destructive force-fresh now arms ONLY behind a pre-flight that proves the resume
target is the culprit (`resumeSessionId && hasResumeHook`); a bare
`providerThreadId` (Codex, which has no pre-flight hook) no longer arms it, so a
Codex resume-crash falls through to `markExited("crashed")` with the thread
INTACT = retained crash-but-resumable, revivable via `codex resume <threadId>`.
Adds an active notification + clarified crash log so the retained crash is
observable rather than a passive status-delta only. Extends ADR-049 to the
Codex/`providerThreadId` path.
