/**
 * Keeps the agent row's branch current after the snapshot: an agent that runs
 * `git checkout` mid-session changes branch with no record mutation, so nothing
 * else would tell the dashboard. A cheap interval re-reads each running agent's
 * branch (pure fs, see gitBranch.ts) and emits a version-preserving
 * `agent.updated` patch ONLY when it changed — same convention as the hand-off
 * count (a derived value is not a record mutation). `""` clears a branch (a JSON
 * patch can't carry `undefined`).
 */

import type { Agent } from "@autonomos/core";
import { emitAgentDelta } from "../events/agents.js";
import { cachedGitBranch } from "./gitBranch.js";
import { listAgents } from "./store.js";

const REFRESH_MS = 15_000;

/** Last branch the dashboard was told about, per agent. First sight only
 *  records (the snapshot/created delta already carried it via enrichAgent). */
const lastSent = new Map<string, string>();

/** One refresh pass — exported for tests. */
export function refreshGitBranches(agents: Agent[] = listAgents()): void {
  const live = new Set<string>();
  for (const a of agents) {
    if (a.status !== "running") continue;
    live.add(a.id);
    const branch = cachedGitBranch(a.workingDirectory, { fresh: true }) ?? "";
    const prev = lastSent.get(a.id);
    lastSent.set(a.id, branch);
    if (prev === undefined || prev === branch) continue;
    emitAgentDelta({
      type: "agent.updated",
      id: a.id,
      patch: { gitBranch: branch },
      version: a.version,
    });
  }
  // Forget agents no longer running so the map stays bounded by the fleet.
  for (const id of lastSent.keys()) if (!live.has(id)) lastSent.delete(id);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startGitBranchRefresher(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      refreshGitBranches();
    } catch (err) {
      console.warn(
        "[agents] git-branch refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }, REFRESH_MS);
  timer.unref?.();
}

/** Test hook. */
export function _resetGitBranchRefresherForTesting(): void {
  lastSent.clear();
  if (timer) clearInterval(timer);
  timer = null;
}
