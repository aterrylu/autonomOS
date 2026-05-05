/**
 * Agents runtime — PTY lifecycle for autonomOS agents.
 *
 * Replaces the old packages/server/src/sessions.ts. Owns spawning, killing,
 * resuming, and shutting down PTY processes. The durable Agent record lives
 * in agents/store.ts; this module owns the in-memory PTY map keyed by agent.id.
 *
 * Every state-changing operation emits the appropriate AgentEvent so the
 * WebSocket broadcaster can fan it out to connected dashboards.
 */

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Agent, Provider, UUID } from "@autonomos/core";
import type { SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { emitAgentEvent } from "../events/agents.js";
import { DEFAULT_CAPABILITIES } from "../mcp/tools.js";
import { getProvider } from "../providers/index.js";
import { getSettings } from "../settings.js";
import { getTemplate } from "../templates.js";
import { batchGetTitles } from "../titleCache.js";
import {
  buildAgent,
  deleteAgentRaw,
  getAgent,
  insertAgent,
  listAgents,
  markExited,
  markRunning,
  resolveAgent as resolveAgentFromStore,
  resolveAgentByName,
} from "./store.js";

const OUTPUT_BUFFER_LIMIT = 1024 * 1024; // 1MB scrollback per attachment

/** Resolve claude binary — delegates to the claude-code provider. */
export function resolveClaudePath(): string {
  return getProvider("claude-code").resolveBinary();
}

export interface ManagedAttachment {
  agentId: UUID;
  pty: IPty;
  outputBuffer: string[];
  outputSize: number;
}

const live = new Map<UUID, ManagedAttachment>();
let shuttingDown = false;

export function getAttachment(agentId: UUID): ManagedAttachment | undefined {
  return live.get(agentId);
}

export function getLiveAgentIds(): UUID[] {
  return Array.from(live.keys());
}

export function expandPath(path: string): string {
  if (path.startsWith("~") && !process.env.HOME) {
    throw new Error("HOME environment variable is not set");
  }
  return path.replace(/^~/, process.env.HOME || "");
}

// ── Spawn ──────────────────────────────────────────────────────────

export interface SpawnParams extends SpawnOptions {
  /** Agent id to resume an existing record (was: resumeSessionId at the
   *  PTY layer). When provided, the Agent must already exist in the store. */
  resumeAgentId?: UUID;
  /** Agent id to fork from. The forked agent inherits parent context. */
  forkFromAgentId?: UUID;
  /** Manager agent id for the org chart. */
  managerId?: UUID | null;
}

export interface SpawnResult {
  agent: Agent;
  managed: ManagedAttachment;
}

/**
 * Spawn a new PTY for an agent.
 *
 * Three modes:
 *   - Fresh: no resumeAgentId, no forkFromAgentId → new Agent + new PTY
 *   - Resume: resumeAgentId present → existing Agent (must be exited) + new PTY
 *     reusing its providerSessionId (CC --resume flow)
 *   - Fork: forkFromAgentId present → new Agent (new id) + new PTY that --resume's
 *     the forked agent's providerSessionId then --fork-session's
 */
export function spawnAgent(params: SpawnParams): SpawnResult {
  if (params.forkFromAgentId && params.resumeAgentId) {
    throw new Error(
      "Cannot use both forkFromAgentId and resumeAgentId — fork creates a new agent from a parent's context, resume reattaches an existing agent.",
    );
  }

  // Reject if a live agent with the same name is already running.
  // INVARIANT: synchronous between check and live.set — no TOCTOU.
  if (params.name) {
    const needle = params.name.toLowerCase();
    for (const a of listAgents()) {
      if (a.status === "running" && live.has(a.id) && a.name.toLowerCase() === needle) {
        throw new Error(
          `An active agent named "${params.name}" is already running (id: ${a.id}). ` +
            `Kill it first, or choose a different name.`,
        );
      }
    }
  }

  const cwd = expandPath(params.workingDirectory);
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Invalid working directory: ${cwd}`);
  }

  const providerName: Provider = (params.provider as Provider) ?? "claude-code";
  const provider = getProvider(providerName);
  const binary = provider.resolveBinary();

  // Resolve the agent we'll attach to (resume), or create a new one.
  let agent: Agent;
  let providerSessionId: string;

  if (params.resumeAgentId) {
    const existing = getAgent(params.resumeAgentId);
    if (!existing) {
      throw new Error(`resumeAgentId "${params.resumeAgentId}" not found`);
    }
    if (live.has(existing.id)) {
      throw new Error(
        `Agent "${existing.name}" (${existing.id}) is already attached`,
      );
    }
    providerSessionId = existing.providerSessionId;
    agent = existing;
  } else if (params.forkFromAgentId) {
    const parent = getAgent(params.forkFromAgentId);
    if (!parent) {
      throw new Error(`forkFromAgentId "${params.forkFromAgentId}" not found`);
    }
    // New agent, new provider-session for the fork; CC will create the new session
    // by --resume'ing the parent then --fork-session'ing it.
    providerSessionId = crypto.randomUUID();
    const dirName = basename(cwd) || cwd;
    const id = crypto.randomUUID();
    const shortId = id.slice(0, 4);
    const defaultName = params.name || `${dirName} · ${shortId}`;
    agent = buildAgent({
      id,
      name: defaultName,
      workingDirectory: cwd,
      provider: providerName,
      providerSessionId,
      autonomousMode: !!params.autonomousMode,
      template: params.template,
      managerId: params.managerId ?? null,
      project: params.project,
    });
  } else {
    // Fresh spawn
    providerSessionId = crypto.randomUUID();
    const dirName = basename(cwd) || cwd;
    const id = crypto.randomUUID();
    const shortId = id.slice(0, 4);
    const defaultName = params.name || `${dirName} · ${shortId}`;
    agent = buildAgent({
      id,
      name: defaultName,
      workingDirectory: cwd,
      provider: providerName,
      providerSessionId,
      autonomousMode: !!params.autonomousMode,
      template: params.template,
      managerId: params.managerId ?? null,
      project: params.project,
    });
  }

  // Build provider args + env
  const { channels } = getSettings();
  const channelScript = resolve(import.meta.dirname, "../channel-server/dist.mjs");

  const resolved = {
    ...params,
    sessionId: agent.id,
    agentName: agent.name,
    cwd,
    providerSessionId,
    // For fork mode, the provider expects `forkFrom` to be the parent's
    // providerSessionId so it can --resume + --fork-session it.
    forkFrom: params.forkFromAgentId
      ? getAgent(params.forkFromAgentId)?.providerSessionId
      : undefined,
    // For resume, providerSessionId already equals the existing record's;
    // claude-code provider does --resume on it.
    resumeSessionId: params.resumeAgentId ? providerSessionId : undefined,
    injectChannelServer: !!channels?.includes("server:autonomos"),
    channelServerScript: channelScript,
    serverPort: process.env.PORT || "3000",
    capabilities:
      (params.template ? getTemplate(params.template)?.capabilities : null) ??
      DEFAULT_CAPABILITIES,
  };

  const args = provider.buildArgs(resolved);
  const env = provider.buildEnv(agent.id, agent.name);

  const logArgs = args.map((a) => {
    if (a.startsWith('{"hooks"')) return '{"hooks":...}';
    if (a.startsWith('{"mcpServers"')) return '{"mcpServers":...}';
    return a;
  });
  console.log(`[runtime] spawning: ${binary} ${logArgs.join(" ")}`);

  const cols = params.cols ?? 120;
  const rows = params.rows ?? 40;
  const pty = spawn(binary, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  if (getSettings().autoTrust !== false && provider.attachStartupWatcher) {
    provider.attachStartupWatcher(pty, resolved);
  }

  // Persist the agent record (insert if new, mark running if resume)
  const isResume = !!params.resumeAgentId;
  const persisted = isResume
    ? markRunning(agent.id, {
        provider: providerName,
        providerSessionId,
        startedAt: Date.now(),
      })!
    : insertAgent(agent);

  const managed: ManagedAttachment = {
    agentId: persisted.id,
    pty,
    outputBuffer: [],
    outputSize: 0,
  };
  live.set(persisted.id, managed);

  // Emit the appropriate event
  if (isResume) {
    emitAgentEvent({
      type: "agent.attached",
      id: persisted.id,
      provider: providerName,
      providerSessionId,
      version: persisted.version,
    });
  } else {
    emitAgentEvent({ type: "agent.created", agent: persisted });
  }

  // PTY data → output buffer (used by terminal WS streaming)
  pty.onData((data: string) => {
    managed.outputBuffer.push(data);
    managed.outputSize += data.length;
    if (managed.outputSize > OUTPUT_BUFFER_LIMIT) {
      let drop = 0;
      let freed = 0;
      while (
        drop < managed.outputBuffer.length - 1 &&
        managed.outputSize - freed > OUTPUT_BUFFER_LIMIT
      ) {
        freed += managed.outputBuffer[drop].length;
        drop++;
      }
      if (drop > 0) {
        managed.outputBuffer.splice(0, drop);
        managed.outputSize -= freed;
      }
    }
  });

  const spawnedAt = Date.now();

  pty.onExit(({ exitCode, signal }) => {
    const lifetime = Date.now() - spawnedAt;

    if (lifetime < 5_000 && exitCode !== 0) {
      console.error(
        `[runtime] ${persisted.id.slice(0, 8)} died immediately (${lifetime}ms), code=${exitCode}` +
          ` — likely a bad flag. Args: ${logArgs.join(" ")}`,
      );
    } else if (exitCode !== 0 || signal) {
      console.warn(
        `[runtime] ${persisted.id.slice(0, 8)} exited: code=${exitCode} signal=${signal ?? "none"} lifetime=${lifetime}ms`,
      );
    }

    if (!shuttingDown) {
      const reason: "self_exited" | "crashed" =
        exitCode === 0 && !signal ? "self_exited" : "crashed";
      const updated = markExited(persisted.id, reason);
      live.delete(persisted.id);
      if (updated) {
        emitAgentEvent({
          type: "agent.exited",
          id: persisted.id,
          exitReason: reason,
          version: updated.version,
        });
      }
    }
    // When shuttingDown is true, keep agent in store as "running" so it
    // auto-resumes on next server boot.
  });

  return { agent: persisted, managed };
}

// ── Kill / remove ──────────────────────────────────────────────────

/** Kill the PTY for an agent but keep the Agent record (status: exited). */
export function killAttachment(agentId: UUID): boolean {
  const managed = live.get(agentId);
  if (!managed) return false;
  try {
    managed.pty.kill();
  } catch (err) {
    console.error(`Failed to kill PTY for agent ${agentId}: ${err}`);
  }
  // Mark exited synchronously rather than waiting for onExit to fire — gives
  // the API a deterministic post-condition for the user-killed case.
  const updated = markExited(agentId, "user_killed");
  live.delete(agentId);
  if (updated) {
    emitAgentEvent({
      type: "agent.exited",
      id: agentId,
      exitReason: "user_killed",
      version: updated.version,
    });
  }
  return true;
}

/** Hard-delete an agent. Kills PTY if running, then removes the record from
 *  disk. Caller is responsible for handling children (reassign or orphan). */
export function deleteAgent(agentId: UUID): boolean {
  const wasLive = live.has(agentId);
  if (wasLive) {
    const managed = live.get(agentId)!;
    try {
      managed.pty.kill();
    } catch (err) {
      console.error(`Failed to kill PTY for agent ${agentId}: ${err}`);
    }
    live.delete(agentId);
  }
  const removed = deleteAgentRaw(agentId);
  if (removed) {
    emitAgentEvent({ type: "agent.deleted", id: agentId });
  }
  return removed || wasLive;
}

// ── Shutdown / restart ─────────────────────────────────────────────

/**
 * Kill all PTY processes without marking the Agent records exited.
 * Used during server shutdown so agents auto-resume on next boot.
 */
export function shutdownAllAttachments(): void {
  shuttingDown = true;
  for (const [, managed] of live) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort during shutdown
    }
  }
  live.clear();
}

/** Reset shuttingDown — used after restartAllAttachments to permit normal
 *  exit-marking to resume. */
function resetShuttingDown(): void {
  shuttingDown = false;
}

/**
 * Resume all agents whose persisted status is "running" (typical post-startup
 * recovery path). Called once from server startup.
 *
 * Failures are caught per-agent and the failing agent is marked exited+crashed
 * so a zombie record (status=running with no live PTY) doesn't sit forever.
 */
export function resumeActiveAgents(): void {
  const agents = listAgents().filter((a) => a.status === "running");
  if (agents.length === 0) return;

  console.log(`Resuming ${agents.length} agent(s)...`);
  let resumed = 0;
  for (const a of agents) {
    try {
      const tmpl = a.template ? getTemplate(a.template) : null;
      if (a.template && !tmpl) {
        console.warn(
          `  ⚠ Template "${a.template}" not found for ${a.name} — agent will resume without role context`,
        );
      }
      spawnAgent({
        workingDirectory: a.workingDirectory,
        resumeAgentId: a.id,
        name: a.name,
        autonomousMode: a.autonomousMode,
        appendSystemPrompt: tmpl?.systemPrompt,
        template: a.template,
        managerId: a.managerId,
        project: a.project,
        provider: a.provider,
      });
      console.log(`  ✓ ${a.name} (${a.id.slice(0, 8)}...)`);
      resumed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
      console.error(`  ✗ Failed to resume ${a.name}: ${message}${stack}`);
      const updated = markExited(a.id, "crashed");
      if (updated) {
        emitAgentEvent({
          type: "agent.exited",
          id: a.id,
          exitReason: "crashed",
          version: updated.version,
        });
      }
    }
  }
  if (resumed < agents.length) {
    console.warn(`Resumed ${resumed} of ${agents.length} agents`);
  }
}

/**
 * Restart all live attachments — kills each PTY and respawns with fresh env.
 * Preserves agent ids so the dashboard's layout/groups/panes remain valid.
 */
export function restartAllAttachments(): Record<UUID, UUID> {
  // Snapshot live agent ids before killing
  const toRestart: UUID[] = Array.from(live.keys());

  // Kill all PTYs under the shuttingDown flag so onExit doesn't mark them exited.
  shuttingDown = true;
  for (const [, managed] of live) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort
    }
  }
  live.clear();
  resetShuttingDown();

  // Respawn each (id stays the same since we resume by agent id).
  const idMap: Record<UUID, UUID> = {};
  for (const agentId of toRestart) {
    const a = getAgent(agentId);
    if (!a) continue;
    try {
      const tmpl = a.template ? getTemplate(a.template) : null;
      spawnAgent({
        workingDirectory: a.workingDirectory,
        resumeAgentId: a.id,
        name: a.name,
        autonomousMode: a.autonomousMode,
        appendSystemPrompt: tmpl?.systemPrompt,
        template: a.template,
        managerId: a.managerId,
        project: a.project,
        provider: a.provider,
      });
      idMap[a.id] = a.id;
    } catch (err) {
      console.error(
        `Failed to restart agent ${a.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return idMap;
}

// ── Resolve by name-or-id (for MCP tool boundary) ─────────────────────

/**
 * Resolve an agent by id or name. Returns { id } on unique match, or { error }
 * on ambiguity / not-found. Falls back to titleCache lookup if direct matches
 * fail (preserves /rename-friendly resolution from the old code).
 */
export async function resolveAgentId(
  idOrName: string,
): Promise<{ id: UUID } | { error: string }> {
  // 1. Exact id match in store
  const direct = resolveAgentFromStore(idOrName);
  if (direct) return { id: direct.id };

  // 2. titleCache lookup (for sessions where /rename changed the title)
  const all = listAgents().filter((a) => a.providerSessionId);
  const lookups = all.map((a) => ({
    sessionId: a.providerSessionId,
    cwd: a.workingDirectory,
  }));
  if (lookups.length > 0) {
    const titles = await batchGetTitles(lookups).catch((err) => {
      console.warn(
        "resolveAgentId: titleCache lookup failed:",
        err instanceof Error ? err.message : err,
      );
      return new Map<string, string>();
    });
    const needle = idOrName.toLowerCase();
    const matches = all.filter((a) => {
      const title = titles.get(a.providerSessionId);
      return (title ?? a.name).toLowerCase() === needle;
    });
    if (matches.length === 1) return { id: matches[0].id };
    if (matches.length > 1) {
      const list = matches
        .map((a) => `  ${a.name} (id: ${a.id})`)
        .join("\n");
      return {
        error: `Multiple agents named "${idOrName}". Specify by id:\n${list}`,
      };
    }
  }

  return { error: `Agent "${idOrName}" not found.` };
}

/** For testing — reset internal state. */
export function _resetForTesting(): void {
  live.clear();
  shuttingDown = false;
}
