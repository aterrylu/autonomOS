/**
 * Claude Code provider — translates generic SpawnOptions into
 * CC-specific CLI flags, env vars, and startup handling.
 */

import {
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentProvider,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type PtyHandle,
  type ResolvedSpawnOptions,
} from "@autonomos/core";
import { getConfigDir } from "../configDir.js";
import { STATUSLINE_SCRIPT } from "../scriptPaths.js";
import { getAuthToken } from "../serverState.js";
import { getSettings } from "../settings.js";
import { cwdToDirName, projectsDir } from "../titleCache.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  HOOK_CMD,
  RESERVED_ENV_KEYS,
  resolveBinaryFromCandidates,
} from "./shared.js";

// ── Statusline renderer (runtime .mjs script, no build step) ──
const STATUSLINE_REFRESH_SECONDS = 5;

// ── Hook relay ─────────────────────────────────────────────────
const HOOK_ENTRY = {
  matcher: "",
  hooks: [{ type: "command", command: HOOK_CMD, timeout: 3, async: true }],
} as const;

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "Notification",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

// ── Auto-trust: ANSI stripping + prompt needles ───────────────
// The CSI prefix class includes the private-parameter markers <=>? — without
// them, sequences like `\x1b[>0q` (DECRQM/mode chatter CC emits around
// dialogs) strip only partially and leak fragments ("0q", "4m") into the
// needle buffer. Those fragments once counted as "fresh output" and
// false-settled a dialog that was still on screen.
const ANSI_RE =
  /\x1b[[\]()#;?<=>]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

const TRUST_NEEDLES = [
  "Yes,Itrustthisfolder",
  "Yes, I trust this folder",
  "Itrustthisfolder",
];

// Highlight (selection) markers for the trust dialog. CC ≥2.1.26x renders a
// "Quick safety check" variant whose DEFAULT selection is "❯ No, exit" — a
// bare Enter there exits the session (verified by PTY probe on 2.1.269), so
// the watcher must read where the ❯ sits before it confirms anything.
//
// Matching is on WHITESPACE-NORMALIZED text (all spaces removed): the real
// render interleaves cursor-positioning CSI with the glyphs (e.g.
// `❯\x1b[4GNo, exit`), so after ANSI stripping the spacing around ❯ and
// inside the label is arbitrary — a literal-spacing needle silently never
// matches, and "no highlight found" degrades to the fatal bare Enter. That
// exact miss shipped once: the fakes used the assumed spacing, so unit tests
// were green while CI's real dialog exited every agent.
const TRUST_NO_SELECTED_NORM = "❯No,exit";
const TRUST_YES_SELECTED_NORM = "❯Yes,Itrustthisfolder";

/** All whitespace removed — the normal form highlight needles match on. */
function despace(s: string): string {
  return s.replace(/\s+/g, "");
}

const DOWN_ARROW = "\x1b[B";

/**
 * Keystrokes that confirm "Yes, I trust this folder" given the LATEST
 * highlight evidence in the stripped buffer:
 *
 *   - ❯ on "No, exit" (the ≥2.1.26x default) → Down moves the highlight to
 *     Yes, then Enter confirms. Down is also self-correcting under the
 *     stdin-attach race: if only the Down lands, the dialog re-renders with
 *     ❯ on Yes, the needle re-render triggers a retry, and the retry
 *     re-reads the highlight and sends a bare Enter.
 *   - ❯ on "Yes" (the legacy default, or after our Down landed) → Enter.
 *   - NEITHER highlight matched → null: do not answer. A bare Enter is only
 *     ever written on positive ❯Yes evidence, because it is the one key
 *     that exits a default-No dialog — a stray ❯ elsewhere in scrollback,
 *     a mid-paint frame, or a redesigned dialog must all fail toward
 *     stuck-but-alive (operator-recoverable), never toward exited.
 */
function trustKeysFor(buffer: string): string[] | null {
  const norm = despace(buffer);
  const lastNo = norm.lastIndexOf(TRUST_NO_SELECTED_NORM);
  const lastYes = norm.lastIndexOf(TRUST_YES_SELECTED_NORM);
  if (lastNo > lastYes) return [DOWN_ARROW, "\r"];
  if (lastYes >= 0) return ["\r"];
  return null;
}
const CHANNELS_NEEDLES = [
  "WARNING: Loading development channels",
  "WARNING:Loadingdevelopmentchannels",
  "Iamusingthisforlocaldevelopment",
  "I am using this for local development",
];

// ── Permission mode → Claude Code flags ───────────────────────
// `bypass` keeps the legacy --dangerously-skip-permissions (which also
// auto-accepts the trust-folder prompt); `auto`/`plan` go through the explicit
// --permission-mode flag. Our `ask` emits NO flag — it IS Claude Code's
// built-in behavior, so passing CC's own `--permission-mode default` would be
// redundant AND perturbs the interactive TUI's startup enough to break
// real-spawn timing (the usage-queue auto-Enter), which the old flag-less
// supervised spawn never did. (Our value is `ask`; the word "default" below
// refers only to CC's native flag vocabulary and the switch's catch-all.)
function claudePermissionArgs(
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): string[] {
  switch (mode) {
    case "bypass":
      return ["--dangerously-skip-permissions"];
    case "auto":
      return ["--permission-mode", "acceptEdits"];
    case "plan":
      return ["--permission-mode", "plan"];
    default:
      return [];
  }
}

// ── Binary resolution cache ───────────────────────────────────
const binaryCache = { path: null as string | null };

// RESERVED_ENV_KEYS moved to shared.ts — it is now the single source of truth
// for keys that neither customEnvVars nor an env preset may override (consumed
// here for the customEnvVars merge and in runtime.ts for preset injection).

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",
  displayName: "Claude Code",

  capabilities: {
    hooks: { eventCount: 13, perSession: true, requiresSetup: false },
    liveStatus: { supported: true, method: "hooks" },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "flag" },
    messaging: { outbound: true, inbound: true, inboundMethod: "channels" },
    presetSessionId: true,
    sessionResume: true,
    sessionFork: true,
    agentNaming: true,
  },

  resolveBinary(): string {
    return resolveBinaryFromCandidates(
      "claude",
      commonBinaryCandidates("claude"),
      binaryCache,
    );
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    args.push(...claudePermissionArgs(options.permissionMode));

    // Session identity: fork, resume, or new
    if (options.forkFrom) {
      args.push(
        "--resume",
        options.forkFrom,
        "--fork-session",
        "--session-id",
        options.providerSessionId,
      );
    } else if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    } else {
      args.push("--session-id", options.providerSessionId);
    }

    // Display name
    if (options.name) {
      args.push("--name", options.name);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    } else {
      args.push(
        "--append-system-prompt",
        buildSystemPrompt(undefined, options.appendSystemPrompt),
      );
    }

    // SendUserMessage for structured agent-to-dashboard messaging
    args.push("--brief");

    // Inject configured channels (getSettings() deduplicates)
    const settings = getSettings();
    const { channels } = settings;
    if (channels && channels.length > 0) {
      // Only server:* channels are supported (plugin channels were
      // removed). getSettings() already drops anything else, but filter
      // defensively so a stale entry can never reach argv.
      const devChannels = channels.filter((c) => c.startsWith("server:"));

      if (devChannels.length > 0) {
        args.push("--dangerously-load-development-channels", ...devChannels);
      }

      // Inject MCP config for the autonomOS channel server
      if (options.injectChannelServer) {
        const mcpConfig = {
          mcpServers: {
            autonomos: {
              command: "node",
              args: [options.channelServerScript],
              env: {
                // Gateway on the internal socket (ADR-055 PR B). ws+unix://
                // <socketPath>:/ws/gateway — the channel server uses the `ws`
                // package, which parses this scheme (undici's global does not).
                AUTONOMOS_SERVER_URL: `ws+unix://${options.socketPath}:/ws/gateway`,
                // REST base stays PUBLIC (create_agent/kill_agent/schedules).
                AUTONOMOS_API_URL: options.apiUrl,
                AUTONOMOS_SESSION_ID: options.sessionId,
                AUTONOMOS_AGENT_NAME: options.agentName,
                // CONFIG_DIR lets the channel server derive its per-agent token
                // file path (<configDir>/agent-tokens/<sessionId>). See below.
                AUTONOMOS_CONFIG_DIR: getConfigDir(),
                // Forward the in-process auth token (from serverState, set at
                // server boot in run.ts) rather than `process.env.AUTONOMOS_TOKEN`.
                // resolveAuthToken() falls back to ~/.autonomos/token on disk,
                // so when the server boots without the env var set, the token
                // lives only in module state — `process.env.AUTONOMOS_TOKEN`
                // would be undefined and the channel server would be rejected
                // by the gateway's /ws/* auth.
                AUTONOMOS_TOKEN: getAuthToken(),
                // The per-agent token is NOT injected here (ADR-055 follow-up):
                // the channel server reads it from the per-session file the
                // server wrote at spawn. Uniform across providers — Gemini
                // filters the token out of MCP env, Codex would expose it in
                // world-readable argv; the file avoids both.
              },
            },
          },
        };
        args.push("--mcp-config", JSON.stringify(mcpConfig));
      }
    }

    // Inline --settings payload:
    //   - hooks: relay every CC event to /api/hooks for status tracking.
    //     (Note: nothing credential-related is relayed from spawned agents. The
    //     usage plugin reads Claude Code's own local OAuth token, read-only; see
    //     plugins/claude-usage/oauthUsage.ts.)
    //   - statusLine (optional, default on): autonomOS-aware bar at the bottom
    //     of the CC terminal. Replaces the user's personal statusLine for
    //     spawned sessions only. CC merges these as parallel keys at the root.
    const settingsPayload: Record<string, unknown> = {
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [HOOK_ENTRY]])),
    };
    if (settings.statusLine?.enabled !== false) {
      // JSON.stringify produces a properly-escaped, double-quoted path —
      // safe against install paths containing spaces, quotes, $, backticks.
      settingsPayload.statusLine = {
        type: "command",
        command: `node ${JSON.stringify(STATUSLINE_SCRIPT)}`,
        refreshInterval: STATUSLINE_REFRESH_SECONDS,
      };
    }
    args.push("--settings", JSON.stringify(settingsPayload));

    // User prompt (must be last, after --)
    if (options.prompt) {
      args.push("--", options.prompt);
    }

    return args;
  },

  buildEnv(sessionId: string, agentName: string): Record<string, string> {
    // buildBaseEnv strips host CLAUDE_CODE_* / CLAUDECODE contamination.
    const env = buildBaseEnv(sessionId, agentName);

    // Inject user-defined custom env vars
    const settings = getSettings();
    if (settings.customEnvVars) {
      for (const [key, value] of Object.entries(settings.customEnvVars)) {
        if (!RESERVED_ENV_KEYS.has(key)) {
          env[key] = value;
        }
      }
    }

    return env;
  },

  prepareSpawn(options: ResolvedSpawnOptions): void {
    preTrustWorkdir(options.cwd, claudeJsonPath());
  },

  attachStartupWatcher(
    pty: PtyHandle,
    options: ResolvedSpawnOptions,
    onSettled?: () => void,
  ): void {
    // Expect the channels warning prompt if any dev channels are configured
    const { channels } = getSettings();
    const expectChannels =
      channels?.some((c) => c.startsWith("server:")) ?? false;
    attachStartupWatcherCore(pty, options, { expectChannels, onSettled });
  },

  hasResumableSession(options: ResolvedSpawnOptions): boolean {
    // CC stores each session at ~/.claude/projects/<cwdToDirName>/<id>.jsonl
    // and writes it LAZILY — on the first turn, not at session creation. So an
    // agent that hasn't conversed yet has no file here, and `claude --resume
    // <id>` would exit code 1 on sight. Probe the exact path the SDK uses (same
    // helpers titleCache resolves titles with) so the runtime can fall back to
    // a fresh session instead of a doomed resume.
    //
    // Distinguish "genuinely absent" (ENOENT → not resumable) from "couldn't
    // stat it right now" (EACCES/EIO/transient blip → assume resumable). Bare
    // existsSync collapses both to false, which would let a momentary stat
    // hiccup discard — and start a fresh session OVER — a real conversation
    // under the same id. Fail OPEN on any non-ENOENT error: let the real
    // `--resume` attempt proceed (the onExit safety net is the backstop if it
    // truly can't resume).
    //
    // Path note: cwdToDirName matches the SDK exactly for cwd ≤ 200 chars (the
    // normal case). For longer cwds the SDK's truncation hash may diverge
    // (titleCache keeps a prefix-match fallback for exactly this reason); we
    // accept a rare false-negative there rather than make this probe async.
    const file = join(
      projectsDir(),
      cwdToDirName(options.cwd),
      `${options.providerSessionId}.jsonl`,
    );
    try {
      statSync(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true; // transient/unexpected error → don't discard a real session
    }
  },
};

/**
 * Where CC keeps `.claude.json` for the sessions WE spawn: under
 * `CLAUDE_CONFIG_DIR` when set (the child inherits the server's env via
 * buildBaseEnv, so server-side resolution matches what the child will read),
 * else the home default — the same precedence `readAccountIdentity` in
 * oauthUsage.ts documents. Hardcoding `~/.claude.json` made pre-trust a
 * silent no-op under a relocated config: we mutated a file nothing reads
 * while the dialog rendered anyway. Exported for tests.
 */
export function claudeJsonPath(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  return cfg ? join(cfg, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Pre-trust the working directory in CC's OWN config (`.claude.json`:
 * `projects[<realpath cwd>].hasTrustDialogAccepted: true` — byte-identical to
 * what CC records when a user picks "Yes, I trust this folder"), so the trust
 * dialog never renders for the spawn.
 *
 * WHY prevention instead of dismissal: CC ≥2.1.26x defaults the dialog to
 * "❯ No, exit", where a confirming Enter EXITS the session — and dismissing
 * it by keystroke is race-prone in a way no sequencing fully closes: an Ink
 * re-mount (e.g. the resize nudge a terminal attach fires) resets the
 * selection to the default BETWEEN our Down and Enter, observed live killing
 * an agent 0.7s after spawn. Writing the config before the process exists has
 * no such window. The startup watcher stays as the fallback for whatever
 * still renders (config unwritable, unknown layout, the channels dialog).
 *
 * Best-effort by contract: every failure path returns silently (missing file
 * = fresh CC install whose onboarding owns creating it; parse failure = not
 * ours to repair) — a spawn must never be blocked here. The write is
 * tmp+rename in the same directory so CC never reads a torn file; CC's own
 * rewrites can still race us (last writer wins), in which case the dialog
 * shows and the watcher handles it.
 *
 * Exported for tests, which drive it against a temp config path.
 */
export function preTrustWorkdir(cwd: string, claudeJsonPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath, "utf8");
  } catch {
    return; // no CC config yet — onboarding owns it
  }
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    config = parsed as Record<string, unknown>;
  } catch {
    return; // malformed — not ours to repair
  }

  // CC keys projects by RESOLVED path (macOS /var/... → /private/var/...).
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // keep the raw cwd — a not-yet-existing dir can't render a dialog anyway
  }

  const projects =
    config.projects && typeof config.projects === "object"
      ? (config.projects as Record<string, unknown>)
      : {};
  const entry =
    projects[real] && typeof projects[real] === "object"
      ? (projects[real] as Record<string, unknown>)
      : {};
  // Idempotent: any existing value (a deliberate decline included) is kept.
  if ("hasTrustDialogAccepted" in entry) return;

  entry.hasTrustDialogAccepted = true;
  projects[real] = entry;
  config.projects = projects;

  try {
    const tmp = join(
      dirname(claudeJsonPath),
      `.claude.json.autonomos-${process.pid}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmp, claudeJsonPath);
  } catch (err) {
    console.warn(
      "[auto-trust] pre-trust write failed (the startup watcher remains the fallback):",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface StartupWatcherConfig {
  expectChannels: boolean;
  /** How long to wait after an Enter before checking whether it landed.
   *  Also the length of the post-dismissal confirmation window. */
  retryDelayMs?: number;
  /** Max keystroke attempts per dialog before giving up. */
  maxAttempts?: number;
  /** Gap between the keys of a multi-key answer (Down, then Enter). */
  interKeyDelayMs?: number;
  /** Minimum ANSI-stripped chars of fresh output that may count as a
   *  dismissal. A real dialog dismissal is a screen transition (hundreds of
   *  chars); stripped-CSI residue from a repaint is a handful. */
  minDismissEvidenceChars?: number;
  /** Hard deadline for the whole watcher. */
  timeoutMs?: number;
  /** Fired exactly once when the watcher reaches ANY terminal state (all
   *  dialogs handled, gave up, hard timeout, or a PTY write failure — a PTY
   *  that dies without a write settles via the hard timeout; the watcher has
   *  no exit listener). Guarded: a throw must not escape into the watcher's
   *  timer callbacks. */
  onSettled?: () => void;
}

/**
 * Auto-trust core — dismisses CC's startup dialogs (trust folder / dev
 * channels) with needle-driven, selection-aware retry.
 *
 * CC's TUI takes 100-500ms after first paint to attach its stdin handler, so
 * a key written too early is silently dropped — and a dialog that is never
 * dismissed blocks the argv-queued starting prompt forever. Two hazards shape
 * the protocol, both live-probed on CC 2.1.267/2.1.269:
 *
 *   1. The ≥2.1.26x trust dialog DEFAULTS to "❯ No, exit" — a bare Enter that
 *      lands EXITS the session. The answer keys are therefore decided from
 *      the latest ❯ highlight in the buffer (Down+Enter when it sits on No,
 *      Enter when on Yes or for the legacy no-marker dialog), re-read on
 *      every retry so a partially-landed Down self-corrects.
 *   2. "Fresh output without the needle" is NOT proof of dismissal: repaint
 *      residue is a handful of stripped chars while a real dismissal is a
 *      screen transition, so sub-floor output re-arms a retry — and even a
 *      plausible transition is only believed after a confirmation window in
 *      which the needle stays absent.
 *
 * Silence after a write means it was swallowed pre-attach: retry, up to
 * maxAttempts. Exported separately from the provider so tests can drive it
 * with a fake PTY and fast timings.
 */
/** Default hard deadline for the whole watcher. Exported because
 *  promptDelivery's SETTLE_FALLBACK_MS must stay ABOVE it — the fallback
 *  self-settles the receipt windows, and if it fired before the watcher's
 *  terminal state, windows would arm while dialogs are genuinely still being
 *  fought, reintroducing the false-warning + double-paste classes ADR-074
 *  removed. A test pins the relationship; raise both together. */
export const DEFAULT_STARTUP_WATCHER_TIMEOUT_MS = 30_000;

export function attachStartupWatcherCore(
  pty: PtyHandle,
  options: ResolvedSpawnOptions,
  config: StartupWatcherConfig,
): void {
  const retryDelayMs = config.retryDelayMs ?? 500;
  const maxAttempts = config.maxAttempts ?? 5;
  const interKeyDelayMs = config.interKeyDelayMs ?? 150;
  const minDismissEvidenceChars = config.minDismissEvidenceChars ?? 24;
  const timeoutMs = config.timeoutMs ?? DEFAULT_STARTUP_WATCHER_TIMEOUT_MS;
  const label = `${options.agentName} (${options.sessionId.slice(0, 8)})`;

  const needles: Record<string, string[]> = {
    trust: TRUST_NEEDLES,
    channels: CHANNELS_NEEDLES,
  };
  const expected = config.expectChannels ? ["trust", "channels"] : ["trust"];

  interface DialogState {
    /** Needle seen — keys sent, awaiting confirmation they landed. */
    engaged: boolean;
    /** No further action will be taken — confirmed gone, or gave up after
     *  maxAttempts. NOT a claim the dialog was actually dismissed. */
    settled: boolean;
    attempts: number;
    /** ANSI-stripped output received since the last keystroke (or since the
     *  confirmation window opened). */
    freshBuf: string;
    checkTimer: NodeJS.Timeout | null;
    /** Paint-order grace: armed when the needle is visible but no ❯ yet. */
    deferTimer: NodeJS.Timeout | null;
  }
  const dialogs = new Map<string, DialogState>(
    expected.map((id) => [
      id,
      {
        engaged: false,
        settled: false,
        attempts: 0,
        freshBuf: "",
        checkTimer: null,
        deferTimer: null,
      },
    ]),
  );

  let buf = "";
  const MAX_BUF = 8192;
  let disposed = false;
  let ptyDead = false;

  function writeKey(key: string): boolean {
    if (ptyDead) return false;
    try {
      pty.write(key);
      return true;
    } catch (err) {
      ptyDead = true;
      console.warn(
        `[auto-trust] ${label} PTY write failed — process may have exited:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /** The answer keys for a dialog, decided at SEND time from the latest
   *  highlight evidence — a retry after a partially-landed Down re-reads the
   *  ❯ position, which is what makes the two-key answer self-correcting. */
  function keysFor(id: string): string[] | null {
    return id === "trust" ? trustKeysFor(buf) : ["\r"];
  }

  function sendAndScheduleCheck(id: string, d: DialogState): void {
    d.attempts++;
    d.freshBuf = "";
    const keys = keysFor(id);
    if (keys === null) {
      // No answer is safe to give right now (no matched highlight — a
      // mid-paint frame, or an unrecognized layout). Spend the attempt on
      // waiting: the next attempt re-reads the buffer, and exhaustion ends
      // in the loud give-up rather than a blind Enter.
      if (d.attempts < maxAttempts) {
        d.checkTimer = setTimeout(() => {
          d.checkTimer = null;
          if (!disposed) sendAndScheduleCheck(id, d);
        }, retryDelayMs);
        return;
      }
      console.warn(
        `[auto-trust] ${label} "${id}" dialog never showed a recognizable highlight after ${d.attempts} attempts — NOT auto-answering (a blind Enter exits a default-No dialog)`,
      );
      d.settled = true;
      maybeFinish();
      return;
    }
    if (!writeKey(keys[0])) {
      cleanup();
      return;
    }
    const scheduleCheck = () => {
      d.checkTimer = setTimeout(() => {
        d.checkTimer = null;
        if (disposed) return;
        const stillVisible = needles[id].some((n) => d.freshBuf.includes(n));
        // Zero fresh output means the TUI never reacted — the keys were most
        // likely swallowed before the stdin handler attached. Retry that too.
        const silent = d.freshBuf.length === 0;
        // Fresh output BELOW the evidence floor is a repaint's residue, not a
        // dismissal — a dialog closing is a screen transition worth hundreds
        // of stripped chars. Counting any needle-free byte as "dismissed" is
        // the false-settle that left agents stuck on the ≥2.1.26x trust
        // dialog while the watcher reported success.
        const inconclusive = d.freshBuf.length < minDismissEvidenceChars;
        if (stillVisible || silent || inconclusive) {
          if (d.attempts < maxAttempts) {
            sendAndScheduleCheck(id, d);
            return;
          }
          console.warn(
            `[auto-trust] ${label} "${id}" dialog not confirmed dismissed after ${d.attempts} attempts — giving up`,
          );
          d.settled = true;
          maybeFinish();
          return;
        }
        // Looks dismissed — hold a confirmation window before believing it.
        // A late repaint re-rendering the needle here means the transition we
        // saw was something else (a banner, another dialog) and the dialog is
        // still up; positive confirmation is the needle STAYING absent.
        d.freshBuf = "";
        d.checkTimer = setTimeout(() => {
          d.checkTimer = null;
          if (disposed) return;
          const reappeared = needles[id].some((n) => d.freshBuf.includes(n));
          if (reappeared && d.attempts < maxAttempts) {
            sendAndScheduleCheck(id, d);
            return;
          }
          if (reappeared) {
            console.warn(
              `[auto-trust] ${label} "${id}" dialog re-rendered after a presumed dismissal — giving up after ${d.attempts} attempts`,
            );
          } else if (d.attempts > 1) {
            console.log(
              `[auto-trust] ${label} "${id}" dismissed after ${d.attempts} attempts`,
            );
          }
          d.settled = true;
          maybeFinish();
        }, retryDelayMs);
      }, retryDelayMs);
    };
    if (keys.length > 1) {
      // Two-key answer (Down, then Enter). The confirming Enter is GATED on
      // fresh evidence that the highlight is on Yes RIGHT NOW — a blind
      // delay proved fatal: an Ink re-mount (e.g. the resize nudge fired by
      // a terminal attach) resets the selection to the default "No, exit"
      // between the keys, and the Enter then exits the session (observed
      // live, 0.7s after spawn). "Latest highlight" means the ❯Yes render
      // must be NEWER than any ❯No render in the post-Down output.
      const started = Date.now();
      const awaitYesThenEnter = () => {
        d.checkTimer = setTimeout(() => {
          d.checkTimer = null;
          if (disposed) return;
          const norm = despace(d.freshBuf);
          const lastYes = norm.lastIndexOf(TRUST_YES_SELECTED_NORM);
          const lastNo = norm.lastIndexOf(TRUST_NO_SELECTED_NORM);
          if (lastYes >= 0 && lastYes > lastNo) {
            if (!writeKey("\r")) {
              cleanup();
              return;
            }
            // Judge dismissal on output AFTER the confirming key — the
            // selection re-render answering the Down legitimately contains
            // the needle and must not read as "dialog still up".
            d.freshBuf = "";
            scheduleCheck();
            return;
          }
          const remounted = lastNo >= 0 && lastNo > lastYes;
          if (!remounted && Date.now() - started < retryDelayMs * 2) {
            awaitYesThenEnter(); // still waiting for the Down's re-render
            return;
          }
          // Selection reset under us, or the Down never visibly landed —
          // never confirm blind. Retry re-reads the highlight and re-sends,
          // FLOORED at retryDelayMs: a ❯No frame here can also be a routine
          // full repaint of the unchanged dialog while our Down sat
          // swallowed pre-attach (Ink rewrites whole frames), and an
          // immediate retry would burn the whole attempt budget inside the
          // 100-500ms stdin-attach window. A repaint must cost time, not
          // attempts-per-poll.
          if (d.attempts < maxAttempts) {
            d.checkTimer = setTimeout(() => {
              d.checkTimer = null;
              if (!disposed) sendAndScheduleCheck(id, d);
            }, retryDelayMs);
            return;
          }
          console.warn(
            `[auto-trust] ${label} "${id}" dialog selection never confirmed on Yes after ${d.attempts} attempts — giving up`,
          );
          d.settled = true;
          maybeFinish();
        }, interKeyDelayMs);
      };
      awaitYesThenEnter();
    } else {
      scheduleCheck();
    }
  }

  function engage(id: string): void {
    const d = dialogs.get(id);
    if (!d || d.engaged || d.settled) return;
    d.engaged = true;
    console.log(`[auto-trust] ${label} answered "${id}" prompt`);
    sendAndScheduleCheck(id, d);
  }

  function maybeFinish(): void {
    for (const d of dialogs.values()) {
      if (!d.settled) return;
    }
    cleanup();
  }

  const disposable = pty.onData((data: string) => {
    if (disposed) return;
    const clean = data.replace(ANSI_RE, "");
    buf += clean;
    if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
    for (const d of dialogs.values()) {
      if (d.engaged && !d.settled) d.freshBuf += clean;
    }

    const trust = dialogs.get("trust");
    if (trust && !trust.engaged && TRUST_NEEDLES.some((n) => buf.includes(n))) {
      // Paint-order guard: the needle text can arrive a frame before the ❯
      // highlight marker. Deciding keys highlight-blind would fall back to a
      // bare Enter — fatal on the default-No dialog if it lands. Wait for a
      // ❯ (every real dialog variant renders one); a short grace deadline
      // covers a hypothetical marker-less dialog.
      if (buf.includes("❯")) {
        if (trust.deferTimer) {
          clearTimeout(trust.deferTimer);
          trust.deferTimer = null;
        }
        engage("trust");
      } else if (!trust.deferTimer) {
        trust.deferTimer = setTimeout(() => {
          trust.deferTimer = null;
          if (disposed || trust.engaged || trust.settled) return;
          // A trust dialog with NO highlight marker is a layout this watcher
          // does not understand (CC swapped the glyph, or renders selection
          // as reverse-video). The only blind answer available is a bare
          // Enter — the one key that EXITS the session on a default-No
          // dialog. Stuck-but-alive is operator-recoverable; exited is not.
          // So: don't answer, say so loudly, and let pre-trust (the primary
          // mechanism) or the operator handle it. This line is the tripwire
          // that turns the next CC dialog redesign into a log grep instead
          // of silent fleet deaths.
          console.warn(
            `[auto-trust] ${label} trust dialog visible but no ❯ highlight marker ever rendered — unrecognized layout, NOT auto-answering (a blind Enter exits a default-No dialog)`,
          );
          trust.settled = true;
          maybeFinish();
        }, retryDelayMs);
      }
    }

    const ch = dialogs.get("channels");
    if (ch && !ch.engaged && CHANNELS_NEEDLES.some((n) => buf.includes(n))) {
      // The channels dialog rendering implies the trust dialog is behind us.
      if (trust && !trust.engaged) {
        trust.settled = true;
        if (trust.checkTimer) clearTimeout(trust.checkTimer);
      }
      engage("channels");
    }
  });

  const timer = setTimeout(() => {
    if (disposed) return;
    const unanswered = expected.filter((id) => !dialogs.get(id)?.settled);
    const engaged = unanswered.filter((id) => dialogs.get(id)?.engaged);
    if (unanswered.length > 0) {
      console.warn(
        `[auto-trust] ${label} timed out — never dismissed: ${unanswered.join(", ")}` +
          (engaged.length > 0 ? ` (mid-retry: ${engaged.join(", ")})` : ""),
      );
    }
    cleanup();
  }, timeoutMs);

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const d of dialogs.values()) {
      if (d.checkTimer) clearTimeout(d.checkTimer);
      if (d.deferTimer) clearTimeout(d.deferTimer);
    }
    disposable.dispose();
    // cleanup() is the watcher's single terminal point (all-settled, hard
    // timeout, PTY death), so the once-guarantee rides the `disposed` flag.
    try {
      config.onSettled?.();
    } catch (err) {
      console.warn(
        `[auto-trust] ${label} onSettled callback threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** For testing — reset the cached binary path */
export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}
