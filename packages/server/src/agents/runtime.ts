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
import {
  type Agent,
  type AgentProvider,
  DEFAULT_PERMISSION_MODE,
  type ExitReason,
  type PermissionMode,
  type Provider,
  type SpawnOptions,
  type UUID,
} from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { writeAgentTokenFile } from "../agentCredentials.js";
import { applyPresetToEnv } from "../envPresets.js";
import { emitAgentDelta } from "../events/agents.js";
import {
  disposeCodexControl,
  startCodexStatusWatch,
} from "../gateway/codexControl.js";
import { getProvider } from "../providers/index.js";
import {
  clearAgentState,
  clearNotifications,
  pushSystemNotification,
  retractSystemNotification,
} from "../routes/hooks.js";
import { CHANNEL_SERVER_SCRIPT } from "../scriptPaths.js";
import {
  assertControlPlaneReady,
  getInternalSocketPath,
  getServerPort,
} from "../serverState.js";
import { getSettings } from "../settings.js";
import { getTemplate } from "../templates.js";
import { batchGetTitles } from "../titleCache.js";
import {
  cancelAllChannelServerChecks,
  cancelChannelServerCheck,
  trackChannelServerRegistration,
} from "./channelServerCheck.js";
import {
  cancelAllPromptTracking,
  cancelPromptTracking,
  noteStartupSettled,
  supportsPromptDeliveryReceipt,
  trackPromptDelivery,
} from "./promptDelivery.js";
import { pickFreePort, type Sidecar, startSidecarDaemon } from "./sidecar.js";
import {
  buildAgent,
  deleteAgentRaw,
  getAgent,
  getAgentByProviderSessionId,
  insertAgent,
  listAgents,
  markExited,
  markRunning,
  resolveAgent as resolveAgentFromStore,
} from "./store.js";

const OUTPUT_BUFFER_LIMIT = 1024 * 1024; // 1MB scrollback per attachment

/**
 * Redact secrets before spawn args reach the server log.
 *
 * Two shapes carry credentials into argv: Claude's `{"mcpServers":...}` /
 * `{"hooks":...}` JSON blobs (whole-arg redaction), and Codex's per-`-c` flags
 * `mcp_servers.autonomos.env.AUTONOMOS_[AGENT_]TOKEN="<hex>"` (the token is a
 * substring of the arg). The latter is why a blanket startsWith() check leaked:
 * the global token has ridden Codex argv all along, and PR B's per-agent token
 * joins it. On Linux `/proc/<pid>/cmdline` is world-readable, so this only
 * scrubs the LOG — argv exposure itself is documented in ADR-055's honest scope.
 */
export function redactArgForLog(a: string): string {
  if (a.startsWith('{"hooks"')) return '{"hooks":...}';
  if (a.startsWith('{"mcpServers"')) return '{"mcpServers":...}';
  return a.replace(/(AUTONOMOS_(?:AGENT_)?TOKEN=)("?)[^"\s]+("?)/g, "$1$2…$3");
}

/**
 * Append a PTY chunk to an attachment's scrollback buffer, evicting the oldest
 * chunks (FIFO) once total size exceeds OUTPUT_BUFFER_LIMIT. Always retains at
 * least the most recent chunk. Shared by `spawnAgent` and the test-only
 * `_registerSyntheticAttachment` so both exercise identical replay behavior.
 */
function appendToOutputBuffer(
  managed: Pick<ManagedAttachment, "outputBuffer" | "outputSize">,
  data: string,
): void {
  managed.outputBuffer.push(data);
  managed.outputSize += data.length;
  if (managed.outputSize <= OUTPUT_BUFFER_LIMIT) return;
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

/**
 * Probe (wired to the gateway's session-client registry at startup): has THIS
 * agent's channel-server MCP subprocess connected + registered? Lets the runtime
 * detect a Codex agent whose daemon-launched channel server never came up.
 * Injected (not imported) because router.ts already imports this module — a
 * direct import would close a cycle. Null until initGateway() wires it.
 */
let channelServerProbe: ((agentId: string) => boolean) | null = null;
export function setChannelServerProbe(fn: (agentId: string) => boolean): void {
  channelServerProbe = fn;
}

/** Arm the channel-server registration check for a spawn. Logic lives in the
 *  channelServerCheck leaf module (escalating probes, warn on final miss only,
 *  retract on late registration — see its header for the why); this wires in
 *  the runtime-owned pieces: the gateway probe, the live-attachment guard, and
 *  the notification store. */
function scheduleChannelServerCheck(
  agentId: UUID,
  name: string,
  pty: IPty,
): void {
  trackChannelServerRegistration(agentId, name, {
    // Gated on the `pty` still being the live attachment so a kill/respawn
    // within the grace window doesn't warn on a corpse (mirrors the
    // prompt-delivery write guard).
    isLive: () => live.get(agentId)?.pty === pty,
    probe: () => channelServerProbe?.(agentId),
    notify: (message) => pushSystemNotification(agentId, message),
    retract: (notificationId) =>
      retractSystemNotification(agentId, notificationId),
  });
}

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
   *
   * Narrowed to the two members anything here actually uses. `Sidecar.proc` is
   * never read through the interface ANYWHERE — `sidecar.ts` closes over its
   * own local `proc` — so widening this to the full `Sidecar` would buy nothing
   * and would force test-only synthetic attachments through a double cast that
   * silently disables checking in both directions: if `Sidecar` later grew a
   * member the runtime DOES read, the cast would keep compiling while the fake
   * lacked it. Stating the real coupling lets the compiler enforce it instead.
   */
  sidecar?: Pick<Sidecar, "endpoint" | "dispose">;
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

/**
 * PERF/TEST ONLY — register a synthetic attachment backed by a caller-supplied
 * PTY (typically a FakePty from `perf/fake-pty.ts`) so the real terminal WS
 * transport can be benchmarked without spawning `claude`. Mirrors the
 * output-buffer wiring that `spawnAgent` installs, so reconnect-replay
 * scenarios are exercised faithfully too. Not reachable from any product code
 * path (no caller in `src/` outside tests/perf).
 *
 * `sidecarEndpoint` makes the agent look, to `getAgentSidecarEndpoint`, like a
 * Codex agent whose app-server daemon is up. `live` is module-private and only
 * `spawnAgent` writes it, so without this the entire inbound delivery path
 * (router → endpoint lookup → codexControl → socket) was reachable only by
 * spawning a real `codex` binary — which is why that composition went untested
 * while each of its parts was covered. The lookup itself stays real.
 */
export function _registerSyntheticAttachment(
  agentId: UUID,
  pty: IPty,
  opts?: { sidecarEndpoint?: string },
): ManagedAttachment {
  const managed: ManagedAttachment = {
    agentId,
    pty,
    outputBuffer: [],
    outputSize: 0,
    ...(opts?.sidecarEndpoint
      ? { sidecar: { endpoint: opts.sidecarEndpoint, dispose: () => {} } }
      : {}),
  };
  // Mirror spawnAgent's output-buffer onData so replay works.
  pty.onData((data: string) => appendToOutputBuffer(managed, data));
  live.set(agentId, managed);
  return managed;
}

/** PERF/TEST ONLY — drop a synthetic attachment, so a suite that registers
 *  several does not leak them into each other through the module-private map.
 *  Deliberately does NOT touch the PTY or sidecar: neither is real here. */
export function _unregisterSyntheticAttachment(agentId: UUID): void {
  live.delete(agentId);
}

export function expandPath(path: string): string {
  if (path.startsWith("~") && !process.env.HOME) {
    throw new Error("HOME environment variable is not set");
  }
  return path.replace(/^~/, process.env.HOME || "");
}

/**
 * Whether a spawn attempted to resume a prior session — which ARMS the onExit
 * safety net (respawn fresh on an immediate crash). This is tied to the field
 * each provider actually resumes from AND to that provider's loop-breaker:
 *
 *  - Codex resumes via `providerThreadId`; the safety net clears it on the
 *    fresh respawn, so the respawn is no longer "attempting resume" → no loop.
 *  - Claude Code resumes via `resumeSessionId`, but ONLY when it has the
 *    `hasResumableSession` pre-flight (`hasResumeHook`) — which clears
 *    `resumeSessionId` on the regenerated-id respawn, so that loop also breaks.
 *
 * The hook guard is load-bearing: `resumeSessionId` is set on EVERY respawn
 * (provider-agnostic) and only ever cleared by the pre-flight. A provider with
 * a bare `resumeSessionId` and no pre-flight (e.g. a future provider) must NOT
 * arm the net, or a persistent non-resume crash would re-fire it forever
 * (regenerating the id each time, never reaching a terminal `crashed` state).
 *
 * `isAdopt` is an absolute veto and lives INSIDE this function rather than at
 * the callsite so it is covered by the same tests as the rest of the arming
 * logic. The net's remedy — reset providerSessionId to a fresh UUID and respawn
 * — is right for a managed record (a working agent beats one that vanishes from
 * the dashboard) but wrong for an adopted external session: that record exists
 * SOLELY to carry the user's prior conversation, and the reset overwrites
 * `providerSessionId`, the field `--resume` is actually issued against. The
 * record's `id` still holds the external CC session id (adopt sets both), so a
 * later resume does reattach THIS record rather than adopting a duplicate — but
 * it now resumes the fresh random id, finds no transcript for it, and quietly
 * starts empty. The user is left with a healthy, named, EMPTY agent after the
 * API already returned 201.
 *
 * Callers must pass `isAdopt` for any spawn of a record with
 * `adoptedExternal: true`, NOT merely the spawn that adopted it. The flag is
 * persisted precisely because a later resume takes the reattach path, where a
 * spawn-local `resolution` would read "reattach" and re-arm the net.
 */
export function resumeSafetyNetArmed(opts: {
  resumeSessionId?: string;
  providerThreadId?: string;
  hasResumeHook: boolean;
  isAdopt?: boolean;
}): boolean {
  if (opts.isAdopt) return false;
  return (
    !!opts.providerThreadId || (!!opts.resumeSessionId && opts.hasResumeHook)
  );
}

/**
 * A spawn failure that already knows its own HTTP status.
 *
 * Every throw site this PR ADDED uses this, so the route no longer has to infer
 * intent by substring-matching prose authored in this file — a coupling held
 * together by a string literal and a test. Follows the `CachePoisonedError`
 * precedent (store.ts) plus the router's `onError`.
 *
 * Messages are deliberately unchanged from the pre-typed versions, so
 * `spawnErrorStatus`'s substring chain still classifies them identically for
 * any caller that only sees the message. That chain remains the fallback for
 * the pre-existing untyped throws — converting those is a follow-up.
 */
export class SpawnError extends Error {
  readonly code:
    | "INVALID_SESSION_ID"
    | "NOT_ADOPTABLE"
    | "NOTHING_TO_RESUME"
    | "INVALID_WORKING_DIRECTORY";
  readonly status: 400 | 422;
  constructor(
    code: SpawnError["code"],
    status: SpawnError["status"],
    message: string,
  ) {
    super(message);
    this.name = "SpawnError";
    this.code = code;
    this.status = status;
  }
}

/** Canonical UUID shape. Session ids double as the agent-record id AND its
 *  on-disk filename, and `UUID` is a bare string alias, so the shape has to be
 *  checked at runtime — the type system offers nothing here. */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard for ADOPTING an external provider session (one with no autonomOS
 * record) into a new managed agent. Throws when adoption would be unsafe.
 *
 * Two distinct hazards, both caught here rather than downstream:
 *
 *  1. **Provider capability.** Adoption is only meaningful when the provider can
 *     prove a resumable session exists on disk (`hasResumableSession`). Codex and
 *     Gemini declare no such hook AND their `buildArgs` ignore `resumeSessionId`
 *     (Codex resumes via `providerThreadId`), so adopting there would spawn a
 *     FRESH session, persist a managed record, and report success — precisely the
 *     silent failure the adopt path exists to prevent. ADR-056 scopes adoption to
 *     Claude Code; this is where that scope is ENFORCED, not merely documented.
 *
 *  2. **Id shape.** The adopted id becomes the agent id and therefore its
 *     filename (`<agentsDir>/<id>.json`), so a `../`-bearing value would write
 *     outside the agents dir. Reachable post-auth by any spawned agent via MCP
 *     `create_agent`, the same semi-trusted surface ADR-054 hardened.
 */
export function assertAdoptable(
  provider: Pick<AgentProvider, "hasResumableSession" | "displayName">,
  sessionId: string,
): void {
  if (!provider.hasResumableSession) {
    throw new SpawnError(
      "NOT_ADOPTABLE",
      422,
      `${provider.displayName} cannot adopt an external session — nothing to resume`,
    );
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new SpawnError(
      "INVALID_SESSION_ID",
      400,
      `invalid session id ${JSON.stringify(sessionId)} — expected a UUID`,
    );
  }
}

// ── Spawn ──────────────────────────────────────────────────────────

export interface SpawnParams extends SpawnOptions {
  /** Internal autonomOS agent id to resume an existing record (was:
   *  resumeSessionId at the PTY layer). When provided, the Agent must already
   *  exist in the store — this is the managed-agent restart/attach path. */
  resumeAgentId?: UUID;
  /**
   * Raw provider (CC/Codex) session id to resume — a DIFFERENT id-space from
   * `resumeAgentId`. Inherited from SpawnOptions; documented here because
   * spawnAgent gives it first-class meaning:
   *   - if it matches an existing record's providerSessionId, OR an existing
   *     record's agent id (ANY record — the id-space overlap is the point:
   *     unified-id agents, migrated pre-#165 agents, and split-id agents whose
   *     caller happens to hold the agent id all land here) → reattach that
   *     managed record. `create_agent`'s public description promises exactly
   *     this ("an autonomOS agent id OR a raw Claude Code session id"), so the
   *     agent-id lookup is contract, not migration residue — do not prune it.
   *   - otherwise → ADOPT: an external session (e.g. one started via terminal
   *     `claude`, discovered via listSessions) with no autonomOS record yet.
   *     A new persistent managed record is synthesized adopting this CC id, then
   *     resumed. Kept as its own name (not folded into resumeAgentId) precisely
   *     because #165 conflating the two id-spaces is the bug this restores.
   */
  resumeSessionId?: string;
  /** Agent id to fork from. The forked agent inherits parent context. */
  forkFromAgentId?: UUID;
  /** Manager agent id for the org chart. */
  managerId?: UUID | null;
  /**
   * The permission mode declared by the resolved template, if any — kept
   * SEPARATE from the inherited `permissionMode` (which means "the caller
   * explicitly asked for this") because the two rank differently on a resume.
   *
   * On a reattach, only an EXPLICIT `permissionMode` may change an existing
   * agent's autonomy; a template's mode must not, or naming a template while
   * resuming would silently re-level an agent someone deliberately set. This
   * mirrors `respawnAgent`, which reads `tmpl?.systemPrompt` but pointedly not
   * `tmpl?.permissionMode`. On a fresh spawn there is no record to defer to, so
   * the template's mode applies normally.
   *
   * Callers MUST forward `undefined` rather than pre-resolving to
   * DEFAULT_PERMISSION_MODE — collapsing it here erases the distinction between
   * "the caller said `ask`" and "the caller said nothing", and the latter must
   * leave a resumed agent's mode alone.
   */
  templatePermissionMode?: PermissionMode;
  /**
   * Name of an env preset to apply (model override, ADR-067). Resolved once
   * after the agent record is known, with the same "explicit param wins, else
   * the record's value stands on a body-less resume" rule as permissionMode —
   * so `restart-all` / `/attach` (which send no body) keep an agent's override.
   * Callers forward `undefined` rather than a default. The resolved preset's
   * env is injected into ONLY this agent's process; only the NAME persists.
   */
  envPreset?: string;
}

export interface SpawnResult {
  agent: Agent;
  managed: ManagedAttachment;
}

/**
 * Spawn a new PTY for an agent.
 *
 * Modes:
 *   - Fresh: no resume/fork id → new Agent + new PTY
 *   - Resume (by record): resumeAgentId present → existing Agent (must be
 *     exited) + new PTY reusing its providerSessionId (CC --resume flow)
 *   - Resume/adopt (by CC session id): resumeSessionId present → reattach the
 *     matching managed record, OR adopt an external CC session (no record yet)
 *     into a NEW persistent record, then --resume it. Restores resuming
 *     terminal-started `claude` sessions discovered in the Projects panel.
 *   - Fork: forkFromAgentId present → new Agent (new id) + new PTY that --resume's
 *     the forked agent's providerSessionId then --fork-session's
 */
export async function spawnAgent(params: SpawnParams): Promise<SpawnResult> {
  if (
    params.forkFromAgentId &&
    (params.resumeAgentId || params.resumeSessionId)
  ) {
    throw new Error(
      "Cannot use both forkFromAgentId and a resume id — fork creates a new agent from a parent's context, resume reattaches/adopts an existing session.",
    );
  }

  // A present-but-EMPTY resume/fork id means the caller intended to resume but
  // lost the id somewhere. Every dispatch below is truthiness-based, so ""
  // silently falls through to a fresh spawn and reports success — a resume
  // request answered with a brand-new empty agent, no error anywhere.
  //
  // Enforced HERE, at the shared boundary, rather than only at the REST route:
  // the HTTP MCP handler (mcp.ts) calls spawnAgent DIRECTLY and never passes
  // through /api/agents, so a route-only guard leaves that entry point — and any
  // future direct caller — silently uncovered. (Caught in review on #283.)
  // Rejects "present but not a non-empty string", not merely "present and
  // empty": the REST route coerces any non-string to undefined without an error
  // (unlike workingDirectory/template/manager, which 400), so `resumeSessionId:
  // 3421` or `: null` would ALSO be dropped and answered with a fresh agent.
  // Same blast radius as "", so the same guard covers both.
  for (const [field, value] of [
    ["resumeSessionId", params.resumeSessionId],
    ["resumeAgentId", params.resumeAgentId],
    ["forkFromAgentId", params.forkFromAgentId],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      // Message keeps the "invalid session id" prefix so the legacy substring
      // chain classifies it identically for any caller that sees only text.
      throw new SpawnError(
        "INVALID_SESSION_ID",
        400,
        `invalid session id: ${field} was provided but empty or not a string`,
      );
    }
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

  // Caller-supplied for a fresh spawn/fork/adopt. On REATTACH this is replaced by
  // the record's own workingDirectory (see the resolution block) — the record is
  // authoritative about where it lives, and a caller's guess would send the
  // resume probe hunting in the wrong project directory.
  let cwd = expandPath(params.workingDirectory);
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Invalid working directory: ${cwd}`);
  }

  const providerName: Provider = (params.provider as Provider) ?? "claude-code";
  const provider = getProvider(providerName);
  const binary = provider.resolveBinary();

  // Mode for a record that does not exist yet (fresh / fork / adopt). There is
  // no prior autonomy to preserve in those cases, so the template's declared
  // mode applies and the fail-closed default backs it.
  //
  // The EFFECTIVE mode — the one the argv and the write-back use — is resolved
  // below, after `agent` is known, because a reattach must be able to fall back
  // to the record. Deliberately not merged into one expression up here: doing
  // that is what made a body-less resume overwrite a `bypass` record with the
  // fallback. See the effective-mode comment for the full story.
  const newRecordPermissionMode =
    params.permissionMode ??
    params.templatePermissionMode ??
    DEFAULT_PERMISSION_MODE;

  /**
   * Build a NEW managed record for `id`. Shared by the adopt and fresh/fork
   * branches — they differ only in where the id comes from (an external CC
   * session id vs. a minted UUID), not in how the record is shaped. Encodes the
   * id == providerSessionId invariant in one place.
   */
  function buildNewAgent(
    id: UUID,
    { adoptedExternal = false }: { adoptedExternal?: boolean } = {},
  ): Agent {
    const dirName = basename(cwd) || cwd;
    return buildAgent({
      id,
      name: params.name || `${dirName} · ${id.slice(0, 4)}`,
      workingDirectory: cwd,
      provider: providerName,
      providerSessionId: id,
      permissionMode: newRecordPermissionMode,
      template: params.template,
      managerId: params.managerId ?? null,
      project: params.project,
      envPreset: params.envPreset,
      adoptedExternal,
    });
  }

  /**
   * The cwd to reattach an existing record in. The RECORD is authoritative about
   * where it lives — `params.workingDirectory` is supplied independently of the
   * session id (the MCP schema requires it), so a wrong guess would send the
   * resume probe hunting in the wrong project directory, get a false "not
   * resumable", and take the fresh fallback — starting an empty session over a
   * real conversation. `respawnAgent` already resumes from the record's own
   * directory; this makes the resume-by-id paths agree.
   */
  function reattachCwd(existing: Agent): string {
    const own = expandPath(existing.workingDirectory);
    // Re-validate: the caller's workingDirectory was stat'd above, but THIS
    // path never was, and it can have disappeared since the record was written
    // — a first-class case here, since `wt-sync` deletes merged worktrees out
    // from under agents that ran in them. Unchecked, a missing dir either makes
    // node-pty throw (a 500 for a 400-class problem) or spawns a child that
    // dies instantly, arming the safety net and regenerating providerSessionId
    // for a reason that has nothing to do with the session's resumability.
    if (own !== cwd) {
      try {
        if (!statSync(own).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new SpawnError(
          "INVALID_WORKING_DIRECTORY",
          400,
          `Invalid working directory: ${own} — the agent's directory no longer exists, so its session cannot be resumed there`,
        );
      }
      console.warn(
        `[runtime] ${existing.id.slice(0, 8)} resume requested with workingDirectory ${cwd}, but the record lives in ${own} — using the record's`,
      );
    }
    return own;
  }

  // Resolve the agent we'll attach to (resume), or create a new one.
  let agent: Agent;
  let providerSessionId: string;
  /**
   * How `agent` was resolved. The three values are mutually exclusive and each
   * drives a distinct decision further down:
   *   - "reattach" — an existing record → markRunning (not insertAgent), --resume
   *   - "adopt"    — external CC session, new record → insertAgent, --resume, AND
   *                  the resume pre-flight throws instead of falling back to a
   *                  fresh session (an adopt with nothing on disk is an honest
   *                  error, not a silent empty start)
   *   - "new"      — fresh spawn or fork → insertAgent, no --resume
   */
  let resolution: "reattach" | "adopt" | "new" = "new";

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
    resolution = "reattach";
    cwd = reattachCwd(existing);
  } else if (params.resumeSessionId) {
    // Resume by RAW provider (CC) session id — a different id-space from
    // resumeAgentId. Either it belongs to a managed record (reattach) or it's
    // an external session we adopt into a NEW persistent record.
    const existing =
      getAgentByProviderSessionId(params.resumeSessionId) ??
      // Also accepts an agent id directly: migrated (pre-#165) records have
      // id == CC id, and split-id records resolve here when the caller holds
      // the agent id. This is the contract create_agent advertises ("an
      // autonomOS agent id OR a raw Claude Code session id"), not dead code.
      getAgent(params.resumeSessionId as UUID);
    if (existing) {
      if (live.has(existing.id)) {
        throw new Error(
          `Agent "${existing.name}" (${existing.id}) is already attached`,
        );
      }
      providerSessionId = existing.providerSessionId;
      agent = existing;
      resolution = "reattach";
      cwd = reattachCwd(existing);
    } else {
      // ADOPT: no record for this CC session id. Synthesize a persistent
      // managed record adopting the CC session id as its providerSessionId,
      // then resume it (the --resume path fires via resolved.resumeSessionId
      // below). The hasResumableSession pre-flight gates it: an external
      // session with no JSONL on disk has nothing to resume and is rejected
      // rather than silently started fresh.
      //
      // Reusing the external CC session id as the agent id upholds the
      // id == providerSessionId invariant. Collision-free: we only reach here
      // because no record already has this id (both lookups above missed) —
      // and assertAdoptable has vetted the id's shape, since it also becomes
      // the record's filename.
      //
      // INVARIANT: synchronous from those lookups through insertAgent + live.set
      // — no TOCTOU. This holds only because claude-code declares no
      // `buildSidecar`, so no `await` intervenes (the sidecar block is the only
      // one, and assertAdoptable rejects every provider that has it). If Claude
      // Code ever gains a sidecar, two concurrent adopts of the same session id
      // would both miss, both insert, and the second would clobber the first's
      // record while orphaning its live PTY — re-check the id before
      // insertAgent if that changes. Mirrors the name-collision pin above.
      assertAdoptable(provider, params.resumeSessionId);
      resolution = "adopt";
      providerSessionId = params.resumeSessionId;
      // `adoptedExternal: true` is PERSISTED on the record — see the field's
      // doc. Without it, every resume AFTER this one takes the reattach path
      // with the safety net armed, and the first failure there regenerates
      // providerSessionId, destroying the pointer to the user's conversation.
      agent = buildNewAgent(providerSessionId, { adoptedExternal: true });
    }
  } else {
    // Fresh spawn or fork — both create a new Agent record. For fork, CC creates
    // the new session by --resume'ing the parent then --fork-session'ing it
    // (handled below via params.forkFromAgentId in the resolved args).
    if (params.forkFromAgentId && !getAgent(params.forkFromAgentId)) {
      throw new Error(`forkFromAgentId "${params.forkFromAgentId}" not found`);
    }
    // INVARIANT (at mint time): agent id == providerSessionId (the CC session
    // id). One id, so callers never have to guess which to pass on resume.
    // Historically these were two independent UUIDs (post-#165), which is why
    // resuming a managed CC agent needed the autonomOS id but the CC session id
    // got tried first, 404'd, then retried. Unifying them removes that footgun.
    // Migrated (pre-#165) agents already satisfy this; adopted external sessions
    // do too (above).
    //
    // NOT a permanent invariant: the onExit force-fresh safety net regenerates
    // `providerSessionId` alone (leaving `id`), which RE-SPLITS them for that
    // agent. Never treat the two as interchangeable — always resolve through
    // getAgentByProviderSessionId (with the getAgent fallback), never by
    // assuming one equals the other.
    providerSessionId = crypto.randomUUID();
    agent = buildNewAgent(providerSessionId);
  }

  // ── The effective permission mode ────────────────────────────────
  //
  // THE one place. Everything downstream — the provider argv, the reattach
  // write-back — reads this, so the record and the running process cannot
  // disagree about how much autonomy an agent has.
  //
  // It resolves HERE, after `agent`, because the fallback is the agent's own
  // record. That ordering is the whole correctness argument:
  //   - explicit `params.permissionMode` wins (a caller asking for a mode gets
  //     it, and the record follows — the divergence this PR fixes);
  //   - otherwise the agent's mode stands. On a reattach that is the EXISTING
  //     record, so a resume that says nothing about permissions changes
  //     nothing. On fresh/fork/adopt it is `newRecordPermissionMode`, already
  //     baked into the record just above.
  //
  // Resolving before `agent` — collapsing `undefined` to the fallback up front,
  // which is what the callers used to do — silently DEMOTED a deliberately
  // autonomous agent on any body-less resume: `create_agent(resumeSessionId)`
  // with no mode wrote the fallback over a `bypass` record, permanently, with
  // nothing logged. Callers therefore forward `undefined`; do not "tidy" that
  // back into a `??` at the call site.
  const permissionMode = params.permissionMode ?? agent.permissionMode;

  // A resume that CHANGES autonomy is worth a line in the log either way. The
  // change is legitimate (the caller asked for it), but "this agent's autonomy
  // changed and nothing said so" is precisely the class of silence that made
  // the original bug take days to see.
  if (resolution === "reattach" && permissionMode !== agent.permissionMode) {
    console.warn(
      `[runtime] ${agent.name} (${agent.id.slice(0, 8)}): permission mode ` +
        `${agent.permissionMode} → ${permissionMode} on resume (caller-specified)`,
    );
  }

  // The effective env preset — same "explicit param wins, else the record's
  // value stands on a body-less resume" resolution as permissionMode (ADR-067).
  // On fresh/fork/adopt `agent.envPreset` is already `params.envPreset` (baked
  // by buildNewAgent); on reattach it is the EXISTING record, so restart-all /
  // /attach keep an agent's override.
  const envPreset = params.envPreset ?? agent.envPreset;
  if (resolution === "reattach" && envPreset !== agent.envPreset) {
    console.warn(
      `[runtime] ${agent.name} (${agent.id.slice(0, 8)}): env preset ` +
        `${agent.envPreset ?? "(none)"} → ${envPreset ?? "(none)"} on resume (caller-specified)`,
    );
  }

  // Build provider args + env
  const { channels } = getSettings();

  const resolved = {
    ...params,
    // Must come AFTER the spread: params.permissionMode may be undefined, and
    // the provider argv has to reflect the same resolved mode the record holds.
    permissionMode,
    sessionId: agent.id,
    agentName: agent.name,
    cwd,
    providerSessionId,
    // For fork mode, the provider expects `forkFrom` to be the parent's
    // providerSessionId so it can --resume + --fork-session it.
    forkFrom: params.forkFromAgentId
      ? getAgent(params.forkFromAgentId)?.providerSessionId
      : undefined,
    // For resume/adopt, providerSessionId is the CC session id to --resume:
    // reattached record → its providerSessionId; adopted external session → the
    // raw CC id. Fresh/fork leave this undefined (fork uses forkFrom instead).
    resumeSessionId: resolution === "new" ? undefined : providerSessionId,
    injectChannelServer: !!channels?.includes("server:autonomos"),
    channelServerScript: CHANNEL_SERVER_SCRIPT,
    serverPort: String(getServerPort()),
    // ADR-055 PR B: the gateway is on the control socket; the REST base stays
    // public. Both resolved here so providers inject single-purpose env vars
    // instead of the channel server string-deriving one plane from the other.
    socketPath: getInternalSocketPath(),
    apiUrl: `http://localhost:${getServerPort()}`,
    // Set by the sidecar block below (when the provider declares buildSidecar)
    // so buildArgs can emit `--remote <endpoint>` against the daemon.
    sidecarEndpoint: undefined as string | undefined,
    // Codex conversation resume: if this agent already captured a thread id
    // (any respawn — server-restart resume or restart-all), pass it so the
    // provider emits `codex resume <id> --remote` and reattaches the prior
    // conversation. Undefined on a fresh first spawn → a new thread is created.
    providerThreadId: agent.providerThreadId,
  };

  // Pre-flight resume check (provider-parity, ADR-049): a resume only succeeds
  // if the provider actually has a resumable session on disk. Claude Code writes
  // its session JSONL lazily (on the first turn, not at session creation), so a
  // never-conversed agent has no `--resume` target and `claude --resume <id>`
  // exits code 1 on boot — which marks the agent crashed and drops it out of the
  // dashboard (the bug). When the provider reports no resumable session, fall
  // back to a FRESH session reusing the SAME providerSessionId: nothing is lost
  // (there was no prior conversation) and the record's id stays stable. Codex
  // omits this hook — a missing thread id already takes its fresh `--remote`
  // path — so only Claude Code exercises this branch today.
  //
  // The fresh-fallback described above applies to REATTACH ONLY. An ADOPT throws
  // instead (see below): there is no prior record to strand, and starting fresh
  // would be exactly the silent failure the adopt path exists to prevent.
  if (resolved.resumeSessionId && provider.hasResumableSession) {
    // On REATTACH the probe is best-effort: if it THROWS we must never abort the
    // spawn (that would mark the agent crashed — the very outcome this fixes).
    // Fail OPEN to the prior unconditional-resume behavior; the onExit safety net
    // below is the backstop if the resume then genuinely crashes.
    //
    // On ADOPT we fail CLOSED instead. Fail-open's justification is "there's a
    // real record with real history, don't strand it" — but an adopt has no
    // record yet (nothing to strand) and a caller synchronously awaiting an HTTP
    // response. Treating "our probe is broken" as "yes, definitely resumable"
    // is the weakest possible inference, and for an adopt it leads straight to
    // `--resume` on an unverified session → likely crash → empty session. Note
    // claude-code's probe already fails open internally on non-ENOENT stat
    // errors, so reaching this catch means something genuinely unexpected broke.
    // Aborting an adopt costs a retry; proceeding costs the user's conversation.
    let resumable = true;
    try {
      resumable = provider.hasResumableSession(resolved);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (resolution === "adopt") {
        throw new SpawnError(
          "NOTHING_TO_RESUME",
          422,
          `could not verify a saved ${provider.displayName} session for "${params.resumeSessionId}" — refusing to adopt rather than risk starting an empty session (${detail})`,
        );
      }
      console.warn(
        `[runtime] ${agent.id.slice(0, 8)} ${provider.displayName} hasResumableSession probe threw — assuming resumable:`,
        detail,
      );
    }
    if (!resumable) {
      if (resolution === "adopt") {
        // External adopt: the user explicitly asked to resume THIS session's
        // content. Silently starting fresh would be a silent failure (and would
        // insert an empty managed record). Reject before insertAgent — nothing
        // to roll back (the record isn't persisted until after this block).
        throw new SpawnError(
          "NOTHING_TO_RESUME",
          422,
          `no saved ${provider.displayName} session found for "${params.resumeSessionId}" in ${cwd} — nothing to resume`,
        );
      }
      resolved.resumeSessionId = undefined;
      console.warn(
        `[runtime] ${agent.id.slice(0, 8)} resume requested but ${provider.displayName} has no resumable session on disk — starting fresh (same id)`,
      );
      pushSystemNotification(
        agent.id,
        `${agent.name} had no saved ${provider.displayName} session to resume — started a fresh session.`,
      );
    }
  }

  const env = provider.buildEnv(agent.id, agent.name);

  // Apply an env preset (model override, ADR-067): merge the resolved preset's
  // env into ONLY this agent's process env, AFTER the provider built its base +
  // customEnvVars (so a per-agent preset outranks a global customEnvVar). The
  // resolve/merge/refuse logic lives in applyPresetToEnv (unit-tested there); a
  // preset that is missing or whose API key is unset THROWS here — before the
  // record is persisted or the PTY launched, so a rejected spawn leaves no
  // half-started agent.
  if (envPreset) applyPresetToEnv(env, envPreset);

  // Write the per-agent token to its 0600 file BEFORE anything that could launch
  // the channel server (the sidecar daemon below, or the PTY). The channel server
  // reads the token from this file (ADR-055 follow-up) rather than from env/argv,
  // which is what lets Gemini authenticate (it strips `*TOKEN*` env) and keeps the
  // Codex token off world-readable argv. Idempotent with the mint buildEnv already
  // did — same token. Revoked (unlinked) on exit via markExited.
  writeAgentTokenFile(agent.id);

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

  const logArgs = args.map(redactArgForLog);
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

  // The watcher's settle signal gates the prompt-delivery receipt windows —
  // they measure nothing meaningful while a startup dialog may still be
  // blocking the TUI. resolved.sessionId IS the agent id (pre-generated,
  // passed as --session-id), and noteStartupSettled no-ops for sessions that
  // are never tracked (promptless spawns) or not yet tracked — though the
  // latter can't happen: trackPromptDelivery below runs in this same
  // synchronous block, before any watcher timer can fire.
  const startupWatcherAttached =
    getSettings().autoTrust !== false && provider.attachStartupWatcher != null;
  if (startupWatcherAttached) {
    provider.attachStartupWatcher?.(pty, resolved, () => {
      // Staleness guard (mirrors the prompt-delivery write guard below): a
      // watcher has no PTY-exit listener, so one from a killed spawn can
      // outlive its PTY until its hard timeout — its terminal callback must
      // not settle the REPLACEMENT spawn's tracker while that spawn's dialogs
      // are still up. live is populated a few sync lines below, before any
      // watcher timer can fire, so the guard never misfires on our own spawn.
      if (live.get(resolved.sessionId)?.pty !== pty) return;
      noteStartupSettled(resolved.sessionId);
    });
  }

  // Persist the agent record: reattaching an existing record → markRunning;
  // a freshly-built record (fresh spawn, fork, OR external adopt) → insertAgent.
  //
  // `permissionMode` is written on the reattach path too, because the PTY above
  // was launched with `resolved.permissionMode` — which a caller may have set
  // explicitly to something other than what the record holds. Omitting it here
  // is what let a resume run one mode while its record advertised another, for
  // the life of the process. The record now follows the process.
  //
  // Record-driven respawns (restart-all, /attach, startup resume, the crash
  // net) pass the record's own mode in, so this write is a no-op for them —
  // they cannot be elevated by it.
  const persisted =
    resolution === "reattach"
      ? markRunning(agent.id, {
          provider: providerName,
          providerSessionId,
          startedAt: Date.now(),
          permissionMode,
          // Written on reattach for the same reason as permissionMode: the PTY
          // was launched with the resolved preset, so the record must follow.
          // Record-driven respawns pass the record's own value → no-op.
          envPreset,
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

  // OUTBOUND (send + org tools) rides a channel-server MCP subprocess that dials
  // the gateway. If that launch/connect fails (bad node/script path, esp. in a
  // bundled build; or the ws+unix dial failing — ADR-055 PR B) the agent
  // silently has no outbound while still receiving inbound. Verify it actually
  // registered; warn if not.
  //
  // Hoisted out of the `if (sidecar)` block above (ADR-055 PR B): the Codex-only
  // scoping was an accident of nesting, not intent. EVERY agent with a channel
  // server dials the gateway and can hit this failure — a Claude agent whose
  // channel server never comes up is just as silently outbound-dead as a Codex
  // one, and now that the dial is over a Unix socket the failure surface is
  // wider. Gate purely on injectChannelServer.
  if (resolved.injectChannelServer) {
    scheduleChannelServerCheck(persisted.id, persisted.name, pty);
  }

  // Delivery receipt: a starting prompt travels only as a CLI arg, and a
  // startup-dialog race can silently drop it (agent sits at an empty input
  // forever). Track spawn → SessionStart → UserPromptSubmit via the hook
  // stream and re-deliver via PTY paste if the receipt never arrives.
  //
  // Only for providers with a hook relay — see supportsPromptDeliveryReceipt.
  //
  // Nothing is lost by skipping Codex: its re-delivery fallback needs a
  // SessionStart to reach the `awaiting_prompt_submit` phase, so it was never
  // reachable — the tracker was a detector with a 100% false-positive rate and
  // zero true-positive capability.
  //
  // But be clear about the gap this leaves: CODEX SPAWN-WITH-PROMPT NOW HAS NO
  // DELIVERY DETECTOR AT ALL. If the `--remote` TUI fails to attach, the
  // positional prompt is gone, and the daemon reports the thread as idle — so a
  // Codex agent that never started its task looks exactly like one that
  // finished it, and the spawner waits forever. A daemon-side receipt is
  // cheap (statusLoop already polls thread/read: "spawned with a prompt and the
  // thread never left idle within Ns") and is tracked as follow-up work, NOT
  // handled here. The inbound queue-wait warning does not cover this case.
  if (params.prompt && supportsPromptDeliveryReceipt(provider.capabilities)) {
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
        retract: (notificationId) =>
          retractSystemNotification(persisted.id, notificationId),
      },
    );
    // No startup watcher (auto-trust off, or a provider without one): there
    // are no dialogs to wait out — the receipt windows may start now. With a
    // watcher, its terminal callback above delivers this signal instead.
    if (!startupWatcherAttached) {
      noteStartupSettled(persisted.id);
    }
  }

  // Emit the appropriate event. Adopt emits `agent.created` alongside fresh/fork
  // — the dashboard has never seen this record before, so it must be added, not
  // patched as a reattachment of something already on screen.
  if (resolution === "reattach") {
    emitAgentDelta({
      type: "agent.attached",
      id: persisted.id,
      // Full record: a resume can change permissionMode/envPreset/
      // providerSessionId — a field-list would silently drop one.
      agent: persisted,
      provider: providerName,
      providerSessionId,
      version: persisted.version,
    });
  } else {
    emitAgentDelta({ type: "agent.created", agent: persisted });
  }

  // PTY data → output buffer (used by terminal WS streaming)
  pty.onData((data: string) => appendToOutputBuffer(managed, data));

  const spawnedAt = Date.now();
  // Whether this spawn attempted to resume a prior session — Claude Code's
  // `--resume <sessionId>` OR Codex's `codex resume <threadId>` — which arms the
  // onExit safety net below. Reads the POST-pre-flight value: if the resume
  // check above already cleared resumeSessionId, no resume was attempted and the
  // net won't fire. See resumeSafetyNetArmed for why the resumeSessionId arm is
  // gated on the provider owning a pre-flight hook (loop-breaker correctness).
  // An adopt never arms the net (see resumeSafetyNetArmed for why) — a resume
  // can still fail after a passing pre-flight: the session may be open in the
  // user's terminal, or the JSONL truncated or version-mismatched.
  //
  // Read the PERSISTED flag, not just this spawn's `resolution`. After the
  // adopting spawn an adopted record reaches this code as a "reattach", and
  // gating on `resolution` alone would re-arm the net on the very next resume —
  // reintroducing the failure one retry later.
  const isAdoptedRecord = resolution === "adopt" || !!persisted.adoptedExternal;
  const attemptedResume = resumeSafetyNetArmed({
    resumeSessionId: resolved.resumeSessionId,
    providerThreadId: resolved.providerThreadId,
    hasResumeHook: !!provider.hasResumableSession,
    isAdopt: isAdoptedRecord,
  });

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
    cancelChannelServerCheck(persisted.id);

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

    // Resume-failure safety net (provider-agnostic, ADR-049): a spawn that
    // attempted a resume — Claude `--resume <id>` or Codex `codex resume
    // <threadId>` — and died immediately almost certainly hit a missing/invalid
    // session on disk. Respawn FRESH so the agent recovers instead of being
    // marked crashed (and vanishing from the dashboard).
    //
    // Force-fresh for ANY provider by (a) regenerating providerSessionId so
    // Claude's pre-flight check finds no JSONL for the new id and emits a fresh
    // `--session-id`, and (b) clearing providerThreadId so Codex takes the plain
    // `--remote` path. Without (a), a Claude resume that crashed for a reason
    // OTHER than a missing file (e.g. a corrupt session) would re-resume the
    // same broken id every boot — a crash loop. With B's pre-flight in place,
    // the common "never conversed" case never reaches here; this catches the
    // residual "session existed but resume still failed" case.
    if (
      !shuttingDown &&
      attemptedResume &&
      lifetime < 5_000 &&
      exitCode !== 0
    ) {
      live.delete(persisted.id);
      disposeCodexControl(persisted.id);
      // One write resets both identity fields: a new providerSessionId (Claude's
      // pre-flight finds no JSONL for it → fresh `--session-id`) and a cleared
      // providerThreadId (Codex → fresh `--remote`).
      markRunning(persisted.id, {
        providerSessionId: crypto.randomUUID(),
        providerThreadId: undefined,
      });
      // Existence-guarded: this exit handler runs async, so the record may
      // have been DELETED since (which also reclaimed its notifications) — an
      // unguarded push would re-create a notifications entry under an id
      // nothing can resolve, the exact leak the reclamation closes.
      if (getAgent(persisted.id)) {
        pushSystemNotification(
          persisted.id,
          `Couldn't resume ${persisted.name}'s prior ${provider.displayName} session (its history may have been pruned) — starting fresh.`,
        );
      }
      console.warn(
        `[runtime] ${persisted.id.slice(0, 8)} crashed on resume — reset session id + cleared thread id, respawning fresh`,
      );
      const record = getAgent(persisted.id);
      if (record) {
        void respawnAgent(record).catch((err) => {
          const updated = markExited(persisted.id, "crashed");
          if (updated)
            emitAgentDelta({
              type: "agent.exited",
              id: persisted.id,
              exitReason: "crashed",
              version: updated.version,
            });
          console.error(
            `[runtime] ${persisted.id.slice(0, 8)} fresh respawn after failed resume also failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      return;
    }

    if (!shuttingDown) {
      const reason: "self_exited" | "crashed" =
        exitCode === 0 && !signal ? "self_exited" : "crashed";
      // An adopt that dies shortly after spawn almost always means the resume
      // itself failed. Because the safety net is deliberately NOT armed for
      // adopts, this notification is the ONLY signal the user gets — so it must
      // not be narrower than the failure it covers:
      //   - Not gated on `crashed`. A CC failure path that prints an error and
      //     exits 0 yields `self_exited`; gating on `crashed` would leave those
      //     entirely silent (a normal-looking ended agent with an empty pane).
      //   - Window is generous, not 5s. CC's boot isn't instant, and a resume
      //     that surfaces an error and lingers exits well past a tight bound.
      // The record keeps its external session id, so retrying resume reattaches
      // THIS record rather than adopting a duplicate.
      // Existence-guarded like the resume-crash push above: deleting a
      // just-adopted agent inside this 60s window would otherwise re-create
      // its just-reclaimed notifications entry under a deleted id.
      if (isAdoptedRecord && lifetime < 60_000 && getAgent(persisted.id)) {
        pushSystemNotification(
          persisted.id,
          exitCode === 0
            ? `The external ${provider.displayName} session ${providerSessionId.slice(0, 8)} ended right after resuming — if the pane looks empty, the session may still be open in another terminal. Close it there and resume again.`
            : `Couldn't resume the external ${provider.displayName} session ${providerSessionId.slice(0, 8)} — it may still be open in another terminal. Close it there and resume again.`,
        );
      }
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

/** Kill the PTY for an agent but keep the Agent record (status: exited).
 *  `reason` defaults to "user_killed" (operator-initiated kill); `self_exit`
 *  passes "self_exited" so the record is preserved AND labelled honestly —
 *  keeping it (not hard-deleting) is what makes the agent resumable. */
export function killAttachment(
  agentId: UUID,
  reason: ExitReason = "user_killed",
): boolean {
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
  cancelChannelServerCheck(agentId);
  const updated = markExited(agentId, reason);
  live.delete(agentId);
  if (updated) {
    emitAgentDelta({
      type: "agent.exited",
      id: agentId,
      exitReason: reason,
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
  cancelChannelServerCheck(agentId);
  const removed = deleteAgentRaw(agentId);
  if (removed) {
    // deleteAgentRaw revoked the token at the store chokepoint; reclaim the
    // hook state here (the store can't — routes/hooks would be a layering
    // inversion). Without this, GET /api/hooks keeps returning ids no store
    // lookup can resolve. KILL deliberately keeps both — the record survives,
    // and the history is part of it.
    clearAgentState(agentId);
    clearNotifications(agentId);
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
  cancelAllChannelServerChecks();
  for (const [agentId, managed] of live) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort during shutdown
    }
    // Dispose the Codex control client HERE, on the shutdown PATH, rather than
    // leaving it to process exit. Its queue may hold inbound that the sender was
    // told would be retried automatically (ADR-064) — a promise this shutdown is
    // about to break — and dispose() is what LOGS that. (It also
    // pushes a notification, but that lands in an in-memory store this process
    // is about to destroy — the durable half is the rotating log, which uses a
    // synchronous write. Do not read the notification as an operator signal on
    // this path.) At process exit there is no hook where even the log could
    // fire, so a restart mid-queue dropped the buffer in total silence.
    //
    // Ordering: the PTY's own onExit handler also disposes, but kill() only
    // signals and onExit is async, so it cannot preempt this call in a
    // SYNCHRONOUS loop. Do not introduce an `await` here without revisiting.
    // (`live.clear()` below is unrelated — the queue lives in codexControl's
    // own registry, not in `live`.)
    try {
      disposeCodexControl(agentId);
      managed.sidecar?.dispose();
    } catch (err) {
      // A throw here would skip every REMAINING agent's teardown and — since
      // the signal handler that calls this has no catch — removePidFile,
      // removeControlSocket and process.exit too, leaving a stale pid file and
      // socket that make the next boot's bind fail.
      console.warn(
        `[runtime] teardown for ${agentId.slice(0, 8)} threw during shutdown:`,
        err instanceof Error ? err.message : err,
      );
    }
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
    permissionMode: a.permissionMode,
    appendSystemPrompt: tmpl?.systemPrompt,
    template: a.template,
    managerId: a.managerId,
    project: a.project,
    provider: a.provider,
    // Re-apply the record's env preset so a model override survives a restart /
    // crash-net respawn (ADR-067), same as permissionMode above.
    envPreset: a.envPreset,
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
    try {
      // Inside the try, deliberately. getTemplate() throws on anything that
      // isn't ENOENT — that is its contract — so one corrupt or truncated
      // template file used to escape this loop entirely and reject
      // resumeActiveAgents(). The caller only .catch()es it to a log line, so
      // EVERY agent after the bad one stayed status:"running" in sessions.json
      // with no PTY behind it: a dashboard full of green agents whose terminals
      // are dead, never markExited, never notified. The per-agent recovery
      // below exists precisely to prevent that; this call was bypassing it.
      if (a.template && !getTemplate(a.template)) {
        console.warn(
          `  ⚠ Template "${a.template}" not found for ${a.name} — agent will resume without role context`,
        );
      }
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
  // Readiness is checked UP FRONT, before a single PTY is killed (ADR-055).
  //
  // Placement is the whole point. This condition applies uniformly to every
  // agent — if the control socket isn't bound, no respawn can succeed — so
  // discovering it inside the respawn loop would mean aborting AFTER the kill
  // pass and live.clear(), leaving every not-yet-respawned agent as a
  // status:"running" record with no PTY: precisely the zombie the per-agent
  // catch below exists to prevent. Letting it fall into that catch instead is
  // no better — it would mark every agent "crashed" for what is really "the
  // server is still starting up", and return 200 while doing it.
  //
  // Throwing here is clean: nothing has been destroyed, and the route has no
  // local catch, so it reaches agentsRouter.onError as a 503 + Retry-After.
  assertControlPlaneReady();

  // Snapshot live agent ids before killing
  const toRestart: UUID[] = Array.from(live.keys());
  const failures: Array<{ id: UUID; name: string; error: string }> = [];

  // Kill all PTYs under the shuttingDown flag so onExit doesn't mark them exited.
  shuttingDown = true;
  cancelAllPromptTracking();
  cancelAllChannelServerChecks();
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
  cancelAllChannelServerChecks();
}
