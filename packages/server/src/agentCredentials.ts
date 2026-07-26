/**
 * Per-agent gateway/hook credentials (ADR-055 PR B, layer 3).
 *
 * Every spawned agent gets its own random token, distinct from the server's
 * global AUTONOMOS_TOKEN. The global token proves "I am an autonomOS agent"; a
 * per-agent token proves "I am *this* agent". It is what lets the gateway reject
 * a spoofed `register` (previously any client could claim any session id) and
 * lets hook ingest reject a POST forged for another agent's session.
 *
 * IN-MEMORY BY DESIGN. The token is minted at spawn and never persisted: the
 * server re-spawns every agent on restart (resumeActiveAgents), and each spawn
 * runs buildEnv again, so a fresh token is minted and injected into the fresh
 * process. There is never a live agent whose token this table doesn't hold, and
 * never a persisted secret to leak.
 *
 * HONEST SCOPE. All agents run as the same Unix user, which can read any of its
 * own processes' /proc/<pid>/environ. So this is NOT a hard wall against a
 * malicious on-box agent scraping a sibling's token — it raises spoofing from
 * "assert any name in a JSON message" to "actively read another process's
 * memory", and makes every message attributable. Defense in depth + audit, not
 * a kernel boundary. See ADR-055.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** sessionId → per-agent token. Cleared on exit (revoke). */
const credentials = new Map<string, string>();

/**
 * Return the agent's token, minting one on first request for a session.
 *
 * Idempotent per session: buildEnv (agent-process env, for the hook curl) and
 * buildArgs (channel-server env, for the gateway register) both call this during
 * one spawn and MUST get the same value, in whichever order they run.
 */
export function mintAgentToken(sessionId: string): string {
  const existing = credentials.get(sessionId);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  credentials.set(sessionId, token);
  return token;
}

/** The token for a session, or undefined if none has been minted. */
export function getAgentToken(sessionId: string): string | undefined {
  return credentials.get(sessionId);
}

/**
 * Constant-time check that `presented` is the token minted for `sessionId`.
 *
 * Fails closed: an unknown session (no mint — so not an agent this server
 * spawned), a missing/empty presented token, or any mismatch all return false.
 * Constant-time compare so a timing side channel can't leak the token byte by
 * byte (the token gates identity, so it is worth the care).
 */
export function verifyAgentToken(
  sessionId: string,
  presented: string | undefined | null,
): boolean {
  if (!presented) return false;
  const expected = credentials.get(sessionId);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Drop a session's token (on kill/exit) so a dead session's credential is gone. */
export function revokeAgentToken(sessionId: string): void {
  credentials.delete(sessionId);
}

/** Test-only — clear all credentials between tests. */
export function _resetAgentCredentialsForTesting(): void {
  credentials.clear();
}
