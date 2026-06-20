/**
 * Agents runtime — PTY lifecycle for autonomOS agents.
 *
 * Replaces the old packages/server/src/sessions.ts. Owns spawning, killing,
 * resuming, and shutting down PTY processes. The durable Agent record lives
 * in agents/store.ts; this module owns the in-memory PTY map keyed by agent.id.
 *
 * Every state-changing operation emits the appropriate AgentDelta so the
 * WebSocket broadcaster can fan it out to connected dashboards.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Agent, Provider, SpawnOptions, UUID } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { emitAgentDelta } from "../events/agents.js";
import {
  disposeCodexControl,
  startCodexStatusWatch,
} from "../gateway/codexControl.js";
import { DEFAULT_CAPABILITIES } from "../mcp/tools.js";
import { getProvider } from "../providers/index.js";
import { pushSystemNotification } from "../routes/hooks.js";
import { CHANNEL_SERVER_SCRIPT } from "../scriptPaths.js";
import { getServerPort } from "../serverState.js";
import { getSettings } from "../settings.js";
import { getTemplate } from "../templates.js";
import { batchGetTitles } from "../titleCache.js";
import {
  cancelAllPromptTracking,
  cancelPromptTracking,
  trackPromptDelivery,
} from "./promptDelivery.js";
import { pickFreePort, type Sidecar, startSidecarDaemon } from "./sidecar.js";
import {
  buildAgent,
  deleteAgentRaw,
  getAgent,
  insertAgent,
  listAgents,
  markExited,
  markRunning,
  resolveAgent as resolveAgentFromStore,
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
  /**
   * Provider sidecar daemon (Codex's `app-server`), if any. Lifecycle is bound
   * 1:1 to this PTY — disposed wherever the PTY is killed/exits. `endpoint` is
   * the ws:// the gateway uses to inject inbound turns + read status.
   */
  sidecar?: Sidecar;
}

/** ws:// endpoint of an agent's provider daemon (Codex), or undefined. */
export function getAgentSidecarEndpoint(agentId: UUID): string | undefined {
  return live.get(agentId)?.sidecar?.endpoint;
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
export async function spawnAgent(params: SpawnParams): Promise<SpawnResult> {
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
      if (
        a.status === "running" &&
        live.has(a.id) &&
        a.name.toLowerCase() === needle
      ) {
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
  } else {
    // Fresh spawn or fork — both create a new Agent record with a new id
    // and a new providerSessionId. For fork, CC creates the new session by
    // --resume'ing the parent then --fork-session'ing it (handled below
    // via params.forkFromAgentId in the resolved args).
    if (params.forkFromAgentId && !getAgent(params.forkFromAgentId)) {
      throw new Error(`forkFromAgentId "${params.forkFromAgentId}" not found`);
    }
    providerSessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const dirName = basename(cwd) || cwd;
    const defaultName = params.name || `${dirName} · ${id.slice(0, 4)}`;
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
    channelServerScript: CHANNEL_SERVER_SCRIPT,
    serverPort: String(getServerPort()),
    capabilities:
      (params.template ? getTemplate(params.template)?.capabilities : null) ??
      DEFAULT_CAPABILITIES,
    // Set by the sidecar block below (when the provider declares buildSidecar)
    // so buildArgs can emit `--remote <endpoint>` against the daemon.
    sidecarEndpoint: undefined as string | undefined,
  };

  const env = provider.buildEnv(agent.id, agent.name);

  // Provider sidecar daemon (Codex's `codex app-server`): pick a free loopback
  // port, start the daemon, and wait until it is listening BEFORE spawning the
  // PTY — the `codex --remote` TUI errors out immediately on a cold port (no
  // retry). The daemon is bound to this PTY's lifecycle and disposed on exit.
  let sidecar: Sidecar | undefined;
  if (provider.buildSidecar) {
    const port = await pickFreePort();
    resolved.sidecarEndpoint = `ws://127.0.0.1:${port}`;
    const spec = provider.buildSidecar(resolved);
    if (spec) {
      try {
        sidecar = await startSidecarDaemon(
          binary,
          spec.args,
          resolved.sidecarEndpoint,
          {
            cwd,
            env,
            readyNeedle: spec.readyNeedle,
            readyTimeoutMs: spec.readyTimeoutMs,
          },
        );
      } catch (err) {
        // The daemon never came up — abort the spawn rather than launch a TUI
        // that will fail to connect. The agent record hasn't been inserted yet
        // (fresh) or stays exited (resume), so there's nothing to roll back.
        throw new Error(
          `Failed to start ${providerName} sidecar daemon: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      resolved.sidecarEndpoint = undefined;
    }
  }

  let args: string[];
  try {
    args = provider.buildArgs(resolved);
  } catch (err) {
    // buildArgs threw after the daemon was already started — don't leak it.
    sidecar?.dispose();
    throw err;
  }

  const logArgs = args.map((a) => {
    if (a.startsWith('{"hooks"')) return '{"hooks":...}';
    if (a.startsWith('{"mcpServers"')) return '{"mcpServers":...}';
    return a;
  });
  console.log(
    `[runtime] spawning: ${binary} ${logArgs.join(" ")}` +
      (sidecar ? ` (sidecar ${sidecar.endpoint})` : ""),
  );

  const cols = params.cols ?? 120;
  const rows = params.rows ?? 40;
  let pty: IPty;
  try {
    pty = spawn(binary, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });
  } catch (err) {
    // PTY spawn failed — don't leak the sidecar daemon we just started.
    sidecar?.dispose();
    throw err;
  }

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
      })
    : insertAgent(agent);
  if (!persisted) {
    // The agent record was deleted concurrently (resume path) between
    // getAgent() and here — tear down the PTY and daemon we just started so
    // neither is orphaned, then surface the race rather than crashing on a
    // non-null assertion.
    sidecar?.dispose();
    try {
      pty.kill();
    } catch {
      // best-effort — the PTY may already be dead
    }
    throw new Error(
      `Agent record ${agent.id} vanished before it could be marked running`,
    );
  }

  const managed: ManagedAttachment = {
    agentId: persisted.id,
    pty,
    outputBuffer: [],
    outputSize: 0,
    sidecar,
  };
  live.set(persisted.id, managed);

  // Codex agents have no hook relay — drive their dashboard status from the
  // app-server daemon's event stream instead (busy/idle). Eager from spawn so
  // status is live before any inbound traffic. Only providers with a sidecar
  // daemon (Codex) have an endpoint; disposed alongside the daemon at kill.
  // Status is cosmetic and must NEVER jeopardize the spawn — guard the call.
  if (sidecar) {
    try {
      startCodexStatusWatch(persisted.id, sidecar.endpoint);
    } catch (err) {
      console.warn(
        `[runtime] ${persisted.id.slice(0, 8)} failed to start status watch:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Delivery receipt: a starting prompt travels only as a CLI arg, and a
  // startup-dialog race can silently drop it (agent sits at an empty input
  // forever). Track spawn → SessionStart → UserPromptSubmit via the hook
  // stream and re-deliver via PTY paste if the receipt never arrives.
  if (params.prompt) {
    trackPromptDelivery(
      persisted.id,
      `${persisted.name} (${persisted.id.slice(0, 8)})`,
      params.prompt,
      {
        write: (data) => {
          // Refuse writes once this PTY is no longer the canonical attachment
          // (exited or replaced) — never paste into the wrong process.
          if (live.get(persisted.id)?.pty !== pty) return false;
          try {
            pty.write(data);
            return true;
          } catch (err) {
            // A throw on a still-canonical PTY is anomalous (vs the expected
            // stale-attachment case above) — keep the two distinguishable.
            console.warn(
              `[runtime] ${persisted.id.slice(0, 8)} prompt re-delivery write threw:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }
        },
        notify: (message) => pushSystemNotification(persisted.id, message),
      },
    );
  }

  // Emit the appropriate event
  if (isResume) {
    emitAgentDelta({
      type: "agent.attached",
      id: persisted.id,
      provider: providerName,
      providerSessionId,
      version: persisted.version,
    });
  } else {
    emitAgentDelta({ type: "agent.created", agent: persisted });
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

    // The visible TUI (this PTY) and its sidecar daemon are SEPARATE processes —
    // the daemon does not die when the PTY does. Dispose it here unconditionally
    // (idempotent): whether this is the canonical attachment or a stale handler
    // from a replaced PTY, this closure's daemon is now orphaned and must go.
    sidecar?.dispose();

    // Guard against stale onExit handlers firing after the same agent.id has
    // been respawned. node-pty's onExit is async, so during restartAllAttachments
    // (kill → spawn) the killed PTY's onExit can fire AFTER the new attachment
    // is registered. Without this check, the stale handler would mark the
    // freshly-spawned agent as exited and drop its live entry. Comparing the
    // captured `pty` reference to the currently-registered attachment lets us
    // no-op cleanly when our PTY is no longer the canonical one.
    //
    // Resource-disposal note: nothing else in this closure needs explicit
    // cleanup on the stale-handler branch. The captured outputBuffer lives on
    // the dropped ManagedAttachment which is GC'd once it leaves the live map;
    // node-pty owns the underlying file descriptors and releases them when the
    // PTY actually exits (which is what triggered this handler). If a future
    // change adds captured streams/timers/listeners to the spawn closure, they
    // must be disposed here BEFORE the early return.
    if (live.get(persisted.id)?.pty !== pty) {
      return;
    }

    cancelPromptTracking(persisted.id);

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
      // Tear down the Codex inbound control client (no-op for other providers).
      disposeCodexControl(persisted.id);
      if (updated) {
        emitAgentDelta({
          type: "agent.exited",
          id: persisted.id,
          exitReason: reason,
          version: updated.version,
        });
      } else {
        console.warn(
          `[runtime] PTY for ${persisted.id} exited (${reason}) but agent missing from store — possibly deleted concurrently`,
        );
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
  // Sidecar daemon is a separate process — kill it alongside the PTY.
  managed.sidecar?.dispose();
  disposeCodexControl(agentId);
  // Mark exited synchronously rather than waiting for onExit to fire — gives
  // the API a deterministic post-condition for the user-killed case.
  cancelPromptTracking(agentId);
  const updated = markExited(agentId, "user_killed");
  live.delete(agentId);
  if (updated) {
    emitAgentDelta({
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
    managed.sidecar?.dispose();
    live.delete(agentId);
  }
  disposeCodexControl(agentId);
  cancelPromptTracking(agentId);
  const removed = deleteAgentRaw(agentId);
  if (removed) {
    emitAgentDelta({ type: "agent.deleted", id: agentId });
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
  cancelAllPromptTracking();
  for (const [, managed] of live) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort during shutdown
    }
    managed.sidecar?.dispose();
  }
  live.clear();
}

/** Reset shuttingDown — used after restartAllAttachments to permit normal
 *  exit-marking to resume. */
function resetShuttingDown(): void {
  shuttingDown = false;
}

/** Re-spawn an existing agent's PTY (resume). Pulls template/system prompt
 *  from the persisted Agent record so the resumed PTY matches the original
 *  configuration. */
async function respawnAgent(a: Agent): Promise<void> {
  const tmpl = a.template ? getTemplate(a.template) : null;
  await spawnAgent({
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
}

/**
 * Resume all agents whose persisted status is "running" (typical post-startup
 * recovery path). Called once from server startup.
 *
 * Failures are caught per-agent and the failing agent is marked exited+crashed
 * so a zombie record (status=running with no live PTY) doesn't sit forever.
 */
export async function resumeActiveAgents(): Promise<void> {
  const agents = listAgents().filter((a) => a.status === "running");
  if (agents.length === 0) return;

  console.log(`Resuming ${agents.length} agent(s)...`);
  let resumed = 0;
  for (const a of agents) {
    if (a.template && !getTemplate(a.template)) {
      console.warn(
        `  ⚠ Template "${a.template}" not found for ${a.name} — agent will resume without role context`,
      );
    }
    try {
      await respawnAgent(a);
      console.log(`  ✓ ${a.name} (${a.id.slice(0, 8)}...)`);
      resumed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
      console.error(`  ✗ Failed to resume ${a.name}: ${message}${stack}`);
      // Surface the reason in the dashboard, not just server logs — otherwise a
      // Codex agent whose sidecar daemon won't come up shows only as "crashed"
      // every boot with no actionable hint (mirrors the prompt-delivery path).
      pushSystemNotification(a.id, `Failed to resume ${a.name}: ${message}`);
      const updated = markExited(a.id, "crashed");
      if (updated) {
        emitAgentDelta({
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
 *
 * Returns both `idMap` (the agents that successfully respawned, identity-mapped
 * since post-unification ids are stable across restart) AND `failures` (per-agent
 * error reports for anything that didn't come back). The route handler surfaces
 * `failures` to the dashboard so a partial-success doesn't show as silently
 * "done" when N of M agents failed to respawn — the previous shape returned
 * Record<UUID, UUID> only and lost that distinction in the response body.
 */
export async function restartAllAttachments(): Promise<{
  idMap: Record<UUID, UUID>;
  failures: Array<{ id: UUID; name: string; error: string }>;
}> {
  // Snapshot live agent ids before killing
  const toRestart: UUID[] = Array.from(live.keys());
  const failures: Array<{ id: UUID; name: string; error: string }> = [];

  // Kill all PTYs under the shuttingDown flag so onExit doesn't mark them exited.
  shuttingDown = true;
  cancelAllPromptTracking();
  for (const [id, managed] of live) {
    try {
      managed.pty.kill();
    } catch (err) {
      // pty.kill is rare-throw on macOS but reachable on Windows / when the
      // process is already exiting. Log so operators see the cause; we still
      // proceed because live.clear() below makes the dead reference unreachable.
      console.error(
        `[runtime] restart-all: pty.kill threw for agent ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Dispose the sidecar daemon too — it won't die with the PTY.
    managed.sidecar?.dispose();
  }
  live.clear();
  resetShuttingDown();

  // Respawn each (id stays the same since we resume by agent id).
  const idMap: Record<UUID, UUID> = {};
  for (const agentId of toRestart) {
    const a = getAgent(agentId);
    if (!a) {
      // Persisted record vanished between snapshot and respawn — shouldn't
      // happen in practice (no other writer mutates the store mid-restart),
      // but if it does, surface it instead of silently dropping the agent.
      const msg = "agent record missing from store";
      console.error(`[runtime] restart-all: ${msg} (id=${agentId})`);
      failures.push({ id: agentId, name: "<unknown>", error: msg });
      continue;
    }
    try {
      await respawnAgent(a);
      idMap[a.id] = a.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[runtime] restart-all: respawn failed for ${a.id} (${a.name}):`,
        msg,
      );
      // The PTYs were killed under shuttingDown, so onExit did NOT mark this
      // agent exited — and the respawn just failed. Without this, the record
      // stays status:"running" with no live PTY (a zombie that tries to resume
      // again next boot). Mark it crashed + emit, mirroring resumeActiveAgents.
      const updated = markExited(a.id, "crashed");
      if (updated) {
        emitAgentDelta({
          type: "agent.exited",
          id: a.id,
          exitReason: "crashed",
          version: updated.version,
        });
      }
      failures.push({ id: a.id, name: a.name, error: msg });
    }
  }
  return { idMap, failures };
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
      const list = matches.map((a) => `  ${a.name} (id: ${a.id})`).join("\n");
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
  cancelAllPromptTracking();
}
