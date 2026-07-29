/**
 * Per-agent gateway/hook credentials (ADR-055 PR B, layer 3).
 *
 * Every spawned agent gets its own random token, distinct from the server's
 * global AUTONOMOS_TOKEN. The global token proves "I am an autonomOS agent"; a
 * per-agent token proves "I am *this* agent". It is what lets the gateway reject
 * a spoofed `register` (previously any client could claim any session id) and
 * lets hook ingest reject a POST forged for another agent's session.
 *
 * MINTED IN-MEMORY, DELIVERED TWO WAYS. The token is minted at spawn and held
 * in memory (the server re-spawns every agent on restart, re-minting fresh). It
 * reaches the agent's two clients by different routes because they can't share
 * one:
 *   - HOOK curl → env var `AUTONOMOS_AGENT_TOKEN` (buildBaseEnv). The curl
 *     references it unexpanded, so the value never hits argv.
 *   - CHANNEL-SERVER → a per-session FILE, `$configDir/agent-tokens/<sessionId>`
 *     (mode 0600, deleted on exit). This is the uniform delivery that works for
 *     ALL providers: Gemini filters `*TOKEN*` env names out of its MCP
 *     subprocess (so env can't reach its channel server), and Codex would
 *     otherwise take the token as a world-readable `-c` argv flag. A file the
 *     channel-server reads by a path derived from AUTONOMOS_CONFIG_DIR +
 *     AUTONOMOS_SESSION_ID (both non-secret names every provider propagates)
 *     sidesteps both. See ADR-055 follow-up.
 *
 * HONEST SCOPE. All agents run as the same Unix user, which can read any of its
 * own processes' /proc/<pid>/environ AND any file it owns. So neither delivery
 * is a hard wall against a malicious on-box sibling — this is defense-in-depth +
 * attribution, not a kernel boundary. What the file DOES buy over the old Codex
 * argv path: it is 0600 (other users can't read it, unlike world-readable
 * /proc/<pid>/cmdline) and never lands in a process's argv or the server log.
 * See ADR-055.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

/** sessionId → per-agent token. Cleared on exit (revoke). */
const credentials = new Map<string, string>();

/** Directory holding per-session token files. */
function agentTokensDir(): string {
  return join(getConfigDir(), "agent-tokens");
}

/**
 * Reject a sessionId that couldn't be a safe filename BEFORE it becomes one.
 * Session ids are UUIDs in practice, but this value is attacker-influenceable on
 * the resume/adopt path (a raw provider session id), and it lands as a path
 * segment — so a `/` or `..` must never reach join(). Fail loud, not traverse.
 */
function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes("..")) {
    throw new Error(
      `Unsafe sessionId for token file: ${JSON.stringify(sessionId)}`,
    );
  }
}

/** Absolute path of a session's token file. */
export function agentTokenFilePath(sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(agentTokensDir(), sessionId);
}

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
 * Mint (if needed) and write the token to its per-session file for the
 * channel-server to read. Called once at spawn, before the agent process starts,
 * so the file exists by the time the channel-server dials the gateway. 0600 so
 * other users can't read it; dir 0700. Returns the file path.
 */
export function writeAgentTokenFile(sessionId: string): string {
  const token = mintAgentToken(sessionId);
  const path = agentTokenFilePath(sessionId);
  mkdirSync(agentTokensDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return path;
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

/**
 * Drop a session's token on kill/exit — from memory AND disk — so a dead
 * session's credential can't be read or replayed. Best-effort unlink: a missing
 * file (never had a channel server) is fine.
 */
export function revokeAgentToken(sessionId: string): void {
  credentials.delete(sessionId);
  try {
    rmSync(agentTokenFilePath(sessionId), { force: true });
  } catch {
    // sessionId failed the safe-name guard, or fs error — nothing to clean up.
  }
}

/**
 * Remove ALL per-session token files at boot, before any agent respawns.
 *
 * A crash (or SIGKILL) skips the `markExited` revoke, so a token file can
 * outlive its process. On the next boot the in-memory `credentials` map starts
 * empty and every still-"running" agent is re-spawned — which re-mints and
 * re-writes its token file — so nothing in the dir is authoritative at boot: a
 * leftover file is at best about to be overwritten, at worst a stale secret for
 * an agent that won't come back. Clearing the whole dir first makes the on-disk
 * set exactly match the agents that actually respawn.
 *
 * MUST run before resumeActiveAgents (which writes the fresh files). Best-effort:
 * a missing dir (first boot) or fs error never blocks startup.
 */
export function sweepAgentTokenFiles(): void {
  try {
    rmSync(agentTokensDir(), { recursive: true, force: true });
  } catch {
    // Nothing to sweep, or fs error — not worth failing boot over.
  }
}

/** Test-only — clear all credentials between tests. */
export function _resetAgentCredentialsForTesting(): void {
  credentials.clear();
}
