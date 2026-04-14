import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Session, SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { DEFAULT_CAPABILITIES } from "./mcp/tools.js";
import {
  getPersistedSessions,
  markSessionExited,
  persistSession,
  removePersistedSession,
} from "./persisted.js";
import { getProvider } from "./providers/index.js";
import { getSettings } from "./settings.js";
import { getTemplate } from "./templates.js";
import { batchGetTitles } from "./titleCache.js";

const OUTPUT_BUFFER_LIMIT = 1024 * 1024; // 1MB scrollback per session

/** Resolve claude binary — delegates to the claude-code provider. */
export function resolveClaudePath(): string {
  return getProvider("claude-code").resolveBinary();
}

export interface ManagedSession {
  session: Session;
  pty: IPty;
  outputBuffer: string[];
  outputSize: number;
}

const sessions = new Map<string, ManagedSession>();
let shuttingDown = false;

export function getSession(id: string): ManagedSession | undefined {
  return sessions.get(id);
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values()).map((s) => s.session);
}

export function expandPath(path: string): string {
  if (path.startsWith("~") && !process.env.HOME) {
    throw new Error("HOME environment variable is not set");
  }
  return path.replace(/^~/, process.env.HOME || "");
}

export function createSession(options: SpawnOptions): ManagedSession {
  // resumeSessionId is validated at the route boundary (routes/sessions.ts)

  // forkFrom and resumeSessionId are mutually exclusive
  if (options.forkFrom && options.resumeSessionId) {
    throw new Error(
      "Cannot use both forkFrom and resumeSessionId — fork creates a new session from the parent's context, resume reconnects to an existing session.",
    );
  }

  // Reject if a live agent with the same name is already running.
  // Exited agents in sessions.json may share names — only active ones must be unique.
  // INVARIANT: This check is safe because createSession() is fully synchronous —
  // no await points between here and sessions.set(). Adding an await would create
  // a TOCTOU race where two concurrent creates could both pass the check.
  if (options.name) {
    const needle = options.name.toLowerCase();
    const duplicate = getAllSessions().find(
      (s) => s.name.toLowerCase() === needle,
    );
    if (duplicate) {
      throw new Error(
        `An active agent named "${options.name}" is already running (id: ${duplicate.id}). ` +
          `Kill it first, or choose a different name.`,
      );
    }
  }

  const id = crypto.randomUUID();
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 40;
  const cwd = expandPath(options.workingDirectory);

  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Invalid working directory: ${cwd}`);
  }

  // ── Resolve provider ──────────────────────────────────────────
  const providerName = options.provider ?? "claude-code";
  const provider = getProvider(providerName);
  const binary = provider.resolveBinary();

  // Compute defaultName early — needed for env vars and MCP config
  const dirName = basename(cwd) || cwd;
  const shortId = id.slice(0, 4);
  const defaultName = options.name || `${dirName} · ${shortId}`;

  // Pre-generate provider session ID
  // For forks, always generate a new ID (the parent keeps its own).
  const providerSessionId = options.forkFrom
    ? crypto.randomUUID()
    : options.resumeSessionId || crypto.randomUUID();

  // ── Resolve spawn options ───────────────────────────────────
  const { channels } = getSettings();
  const channelScript = resolve(import.meta.dirname, "channel-server/dist.mjs");

  const resolved = {
    ...options,
    sessionId: id,
    agentName: defaultName,
    cwd,
    providerSessionId,
    injectChannelServer: !!channels?.includes("server:autonomos"),
    channelServerScript: channelScript,
    serverPort: process.env.PORT || "3000",
    capabilities:
      (options.template ? getTemplate(options.template)?.capabilities : null) ??
      DEFAULT_CAPABILITIES,
  };

  // ── Delegate to provider for args + env ─────────────────────
  const args = provider.buildArgs(resolved);
  const env = provider.buildEnv(id, defaultName);

  // Log spawn command (truncate large JSON args for readability)
  const logArgs = args.map((a) => {
    if (a.startsWith('{"hooks"')) return '{"hooks":...}';
    if (a.startsWith('{"mcpServers"')) return '{"mcpServers":...}';
    return a;
  });
  console.log(`[session] spawning: ${binary} ${logArgs.join(" ")}`);

  const pty = spawn(binary, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  // Auto-answer startup prompts via provider-specific watcher
  if (getSettings().autoTrust !== false && provider.attachStartupWatcher) {
    provider.attachStartupWatcher(pty, resolved);
  }

  const session: Session = {
    id,
    name: defaultName,
    status: "running",
    workingDirectory: cwd,
    provider: providerName,
    claudeSessionId: providerSessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const managed: ManagedSession = {
    session,
    pty,
    outputBuffer: [],
    outputSize: 0,
  };
  sessions.set(id, managed);

  // Persist immediately — providerSessionId is always known at spawn time now
  persistSession({
    claudeSessionId: providerSessionId,
    workingDirectory: cwd,
    name: defaultName,
    autonomousMode: !!options.autonomousMode,
    persistedAt: Date.now(),
    template: options.template,
    manager: options.manager,
    project: options.project,
  });

  pty.onData((data: string) => {
    managed.outputBuffer.push(data);
    managed.outputSize += data.length;

    // Trim buffer when it exceeds the limit — bulk splice to avoid O(n²) shift()
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
    session.status = "stopped";
    session.updatedAt = Date.now();

    // Fast exit with non-zero code almost always means bad spawn args
    if (lifetime < 5_000 && exitCode !== 0) {
      console.error(
        `[session] ${id.slice(0, 8)} died immediately (${lifetime}ms), code=${exitCode}` +
          ` — likely a bad flag. Args: ${logArgs.join(" ")}`,
      );
    } else if (exitCode !== 0 || signal) {
      console.warn(
        `[session] ${id.slice(0, 8)} exited: code=${exitCode} signal=${signal ?? "none"} lifetime=${lifetime}ms`,
      );
    }

    if (!shuttingDown) {
      // Natural exit (Ctrl+C, agent finished, crash) — mark as exited in persistence
      if (session.claudeSessionId) {
        markSessionExited(session.claudeSessionId);
      }
      sessions.delete(id);
    }
    // When shuttingDown is true, keep in persistence so sessions auto-resume
    // on next server boot.
  });

  return managed;
}

export function killSession(id: string): boolean {
  const managed = sessions.get(id);
  if (!managed) return false;
  try {
    managed.pty.kill();
  } catch (err) {
    console.error(`Failed to kill PTY for session ${id}:`, err);
  }
  managed.session.status = "stopped";
  managed.session.updatedAt = Date.now();
  if (managed.session.claudeSessionId) {
    markSessionExited(managed.session.claudeSessionId);
  }
  sessions.delete(id);
  return true;
}

/**
 * Permanently remove a session — kill PTY if live, then delete from sessions.json.
 * Unlike killSession (which marks as exited), this truly deletes the record.
 */
export function permanentlyRemoveSession(id: string): boolean {
  // Kill PTY if this is a live session (killSession marks as exited, we'll overwrite below)
  const managed = sessions.get(id);
  if (managed) {
    killSession(id);
  }

  // Delete from persistence entirely (overrides the "exited" mark from killSession)
  const claudeId = managed?.session.claudeSessionId ?? id;
  const removed = removePersistedSession(claudeId);
  // If we killed a live PTY, that counts as success even if persistence removal
  // missed (killSession already marked it exited)
  return !!managed || removed;
}

/**
 * Kill all PTY processes without removing them from persistence.
 * Used during server shutdown so sessions survive reboots.
 */
export function shutdownAllSessions(): void {
  shuttingDown = true;
  for (const [, managed] of sessions) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort during shutdown
    }
  }
  sessions.clear();
}

/**
 * Kill all sessions AND remove from persistence.
 * Used when the user explicitly wants to clear everything.
 */
export function killAllSessions(): void {
  for (const [id] of sessions) {
    killSession(id);
  }
}

/**
 * Resolve a session by name or ID.
 * Steps: (1) exact UUID match, (2) raw s.name case-insensitive, (3) titleCache lookup.
 * Returns { id } on unique match, or { error } on ambiguity/not-found.
 */
export async function resolveSessionId(
  nameOrId: string,
): Promise<{ id: string } | { error: string }> {
  // 1. Exact UUID match
  if (sessions.has(nameOrId)) return { id: nameOrId };

  const allSessions = getAllSessions();
  const needle = nameOrId.toLowerCase();

  function uniqueMatch(
    matches: Session[],
  ): { id: string } | { error: string } | null {
    if (matches.length === 1) return { id: matches[0].id };
    if (matches.length > 1) {
      const list = matches.map((s) => `  ${s.name} (id: ${s.id})`).join("\n");
      return {
        error: `Multiple agents named "${nameOrId}". Specify by ID:\n${list}`,
      };
    }
    return null;
  }

  // 2. Raw s.name match (case-insensitive)
  const byName = uniqueMatch(
    allSessions.filter((s) => s.name.toLowerCase() === needle),
  );
  if (byName) return byName;

  // 3. titleCache lookup
  const withClaude = allSessions
    .filter((s) => s.claudeSessionId)
    .map((s) => ({
      sessionId: s.claudeSessionId!,
      cwd: s.workingDirectory,
    }));

  if (withClaude.length > 0) {
    const titles = await batchGetTitles(withClaude).catch((err) => {
      console.warn(
        "resolveSessionId: titleCache lookup failed:",
        err instanceof Error ? err.message : err,
      );
      return new Map<string, string>();
    });
    const byTitle = uniqueMatch(
      allSessions.filter((s) => {
        const title = s.claudeSessionId
          ? titles.get(s.claudeSessionId)
          : undefined;
        return (title ?? s.name).toLowerCase() === needle;
      }),
    );
    if (byTitle) return byTitle;
  }

  return { error: `Agent "${nameOrId}" not found.` };
}

/**
 * Restart all live sessions — kills each PTY and respawns with fresh env.
 * Preserves session IDs so the dashboard's layout/groups/panes remain valid.
 *
 * Strategy: snapshot all session info, kill all PTYs under shuttingDown flag
 * (prevents onExit from deleting sessions), clear the map, then respawn
 * each session via createSession with the same claudeSessionId.
 * The new session gets a new internal ID but the Claude session ID is preserved.
 *
 * Returns a mapping of old session IDs to new session IDs so the
 * dashboard can update its layout/groups/panes.
 */
export function restartAllSessions(): Record<string, string> {
  // Look up autonomousMode from persisted sessions
  const persisted = getPersistedSessions();
  const persistedMap = new Map(persisted.map((p) => [p.claudeSessionId, p]));

  // Snapshot sessions to restart (including old internal ID for remapping)
  const toRestart: Array<{
    oldId: string;
    claudeSessionId: string;
    workingDirectory: string;
    name: string;
    autonomousMode: boolean;
    template?: string;
    manager?: string;
    project?: string;
  }> = [];

  for (const [id, managed] of sessions) {
    const { session } = managed;
    if (session.claudeSessionId) {
      const p = persistedMap.get(session.claudeSessionId);
      toRestart.push({
        oldId: id,
        claudeSessionId: session.claudeSessionId,
        workingDirectory: session.workingDirectory,
        name: session.name,
        autonomousMode: p?.autonomousMode ?? false,
        template: p?.template,
        manager: p?.manager,
        project: p?.project,
      });
    }
  }

  // Kill all PTYs — use shuttingDown to prevent onExit cleanup
  shuttingDown = true;
  for (const [, managed] of sessions) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort
    }
  }
  sessions.clear();
  shuttingDown = false;

  // Respawn each session, collecting old→new ID mapping
  const idMap: Record<string, string> = {};
  for (const info of toRestart) {
    try {
      // Re-resolve template system prompt so agents keep their role context
      const tmpl = info.template ? getTemplate(info.template) : null;
      if (info.template && !tmpl) {
        console.warn(
          `Template "${info.template}" not found for ${info.name} — agent will restart without role context`,
        );
      }

      const managed = createSession({
        workingDirectory: info.workingDirectory,
        name: info.name,
        resumeSessionId: info.claudeSessionId,
        autonomousMode: info.autonomousMode,
        appendSystemPrompt: tmpl?.systemPrompt,
        template: info.template,
        manager: info.manager,
        project: info.project,
      });
      idMap[info.oldId] = managed.session.id;
    } catch (err) {
      console.error(
        `Failed to restart session ${info.claudeSessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return idMap;
}

/** For testing — reset internal state */
export function _resetForTesting(): void {
  sessions.clear();
}

/** For testing — inject a fake session into the in-memory Map (no PTY needed) */
export function _injectSessionForTesting(id: string, session: Session): void {
  sessions.set(id, {
    session,
    pty: null as unknown as IPty,
    outputBuffer: [],
    outputSize: 0,
  });
}
