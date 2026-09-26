// Which agents this daemon started FRESH because there was nothing to resume.
//
// A Claude Code session or a Codex thread is saved lazily, on its first turn,
// so an agent that never conversed has nothing on disk. Its resume therefore
// starts fresh under a NEW id (ADR-100 / ADR-111). That's the correct outcome —
// nothing was lost — but to anything comparing ids across a restart (the
// post-update verification, ADR-105) it looks exactly like a lost conversation.
//
// The runtime's pre-flight is the only place that knows the difference (it
// probes where the CHILD looks, with the child's env), so it records the fact
// here and the verifier asks, instead of re-probing and guessing the env.
// It records ONLY never-used agents (no lastActivityAt): an agent that did
// converse and still has no saved session lost it, and must stay flagged.
// In-memory by design: the verifier runs in the same boot that resumed.

type Kind = "session" | "thread";
const fresh = new Map<string, string>();
const key = (agentId: string, kind: Kind, oldId: string) =>
  `${agentId}\0${kind}\0${oldId}`;

export function noteFreshStart(agentId: string, kind: Kind, oldId: string) {
  fresh.set(key(agentId, kind, oldId), new Date().toISOString());
}

/** True only when THIS id was replaced because it had never been saved. */
export function wasFreshStart(
  agentId: string,
  kind: Kind,
  oldId: string,
): boolean {
  return fresh.has(key(agentId, kind, oldId));
}

export function _resetFreshStartsForTesting(): void {
  fresh.clear();
}
