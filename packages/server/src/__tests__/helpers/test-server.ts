/**
 * Shared harness for the CI-only real-spawn integration suites: boots the
 * REAL server as a child process with an isolated CONFIG_DIR, plus small
 * HTTP helpers.
 *
 * OPT-IN GATE. These suites boot a real autonomos server and spawn REAL
 * `claude` processes under a PTY, so they only run with AUTONOMOS_INTEGRATION=1
 * (CI sets it; see .github/workflows/test.yml). Running them locally next to a
 * live deployment is safe as audited in ADR-103: every boot is isolated
 * (own config dir, token, --port=0, control socket, throwaway HOME /
 * CLAUDE_CONFIG_DIR / CODEX_HOME, no credential-store reads) and each suite
 * asserts nothing landed in the operator's real ~/.claude. The one rule that
 * still matters: NEVER clean up with a broad `pkill -f claude` — that kills the
 * operator's real agents (this happened once). Only kill scoped PIDs.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The server requires the `claude` binary (default provider) on PATH at
 *  startup or it `process.exit(1)`s. CI installs `@anthropic-ai/claude-code`
 *  before `make check`, so in CI it is always present. When genuinely absent
 *  (a dev box without Claude Code), suites skip with a clear message. */
export function isClaudeCodeAvailable(): boolean {
  const r = spawnSync("which", ["claude"], { encoding: "utf-8" });
  // `which` failing to spawn (ENOENT) yields status=null + stdout=null — guard
  // so the probe degrades to `false` instead of throwing at module load.
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

const CLAUDE_AVAILABLE = isClaudeCodeAvailable();
const INTEGRATION_ENABLED = process.env.AUTONOMOS_INTEGRATION === "1";

/** True when the CI-gated real-spawn suites should run. */
export const RUN_INTEGRATION = INTEGRATION_ENABLED && CLAUDE_AVAILABLE;

if (INTEGRATION_ENABLED && !CLAUDE_AVAILABLE) {
  console.warn(
    "[integration] AUTONOMOS_INTEGRATION=1 but `claude` not on PATH — " +
      "skipping. CI installs @anthropic-ai/claude-code automatically.",
  );
}

const SERVER_ENTRY = fileURLToPath(new URL("../../index.ts", import.meta.url));
const READY_TIMEOUT_MS = 15_000;

export interface BootedServer {
  port: number;
  token: string;
  configDir: string;
  /** Throwaway HOME the server and every agent it spawns run under. */
  fakeHome: string;
  /** SIGTERM the server and resolve once it has EXITED (SIGKILL after 10s).
   *  Await it before deleting the config dir: the throwaway HOME lives there,
   *  and deleting it under a still-exiting claude can wedge teardown. */
  kill: () => Promise<void>;
  /** Throws if this run left anything in the operator's REAL Claude Code
   *  state (a session dir under ~/.claude/projects, or a trust entry in
   *  ~/.claude.json) for a temp-dir cwd. Call in every suite's `after`. */
  assertNoRealHomeLeak: () => void;
  /** Full stdout+stderr captured so far — include in assertion messages so
   *  the server's prompt-delivery/auto-trust decisions are visible on failure. */
  logs: () => string;
}

// ── Real-HOME isolation ──────────────────────────────────────────────
//
// The suites spawn a REAL `claude`. With the operator's HOME inherited, every
// run wrote a session dir into the real ~/.claude/projects (they surface in
// the dashboard's Projects panel as autonomos-usageq-cwd-* / -prompt-cwd-*)
// and the spawn-time pre-trust wrote a `projects[<tmp cwd>]` entry into the
// real ~/.claude.json. Each boot now runs under its own throwaway HOME inside
// its configDir (so the suites' existing rmSync(configDir) cleans it up), and
// the leak itself is asserted rather than assumed.

/** The operator's real Claude Code config dir, resolved the way CC does. */
function realClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}
function realClaudeJson(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  return cfg ? join(cfg, ".claude.json") : join(homedir(), ".claude.json");
}

/** CC names a project dir by replacing every non-alphanumeric in the cwd with
 *  "-". A temp-dir cwd therefore starts with the encoded tmpdir (both the
 *  symlinked and the resolved spelling — /var vs /private/var on macOS). */
function tmpPrefixes(): { dirs: string[]; paths: string[] } {
  const paths = [...new Set([tmpdir(), realpathSync(tmpdir())])];
  return { paths, dirs: paths.map((p) => p.replace(/[^a-zA-Z0-9]/g, "-")) };
}

function listRealProjectDirs(): Set<string> {
  try {
    return new Set(readdirSync(join(realClaudeDir(), "projects")));
  } catch {
    return new Set();
  }
}
function listRealTrustKeys(): Set<string> {
  try {
    const cfg = JSON.parse(readFileSync(realClaudeJson(), "utf-8")) as {
      projects?: Record<string, unknown>;
    };
    return new Set(Object.keys(cfg.projects ?? {}));
  } catch {
    return new Set();
  }
}

/** Seed a throwaway HOME the way CI seeds its runner: onboarding complete, so
 *  the TUI boots straight to the prompt (else SessionStart never fires). The
 *  config lives at CLAUDE_CONFIG_DIR, which we set explicitly so it wins even
 *  when the developer exports their own. */
function seedFakeHome(fakeHome: string): string {
  const claudeDir = join(fakeHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  // Probe under the fake HOME too: even `--version` must not start a claude
  // against the operator's real config. BOUNDED: this is a SYNCHRONOUS spawn,
  // so if claude stalls (first-run update check / migration in a fresh config
  // dir), it blocks the event loop and NO test timeout can fire — the file just
  // hangs until the CI job's 6h limit. A timeout, closed stdin and the same
  // no-network flags the server env uses keep it from ever freezing a suite;
  // on any failure we fall back to a fixed onboarding version.
  const v = spawnSync("claude", ["--version"], {
    encoding: "utf-8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: fakeHome,
      CLAUDE_CONFIG_DIR: claudeDir,
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
  });
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout ?? "")?.[1] ?? "2.1.168";
  writeFileSync(
    join(claudeDir, ".claude.json"),
    `${JSON.stringify(
      {
        hasCompletedOnboarding: true,
        numStartups: 5,
        theme: "dark",
        lastOnboardingVersion: version,
      },
      null,
      2,
    )}\n`,
  );
  return claudeDir;
}

/**
 * Boot the server child. When `anthropicBaseUrl` is provided, it is set as
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in the SERVER's environment —
 * the claude-code provider's `buildEnv()` spreads `process.env` into every
 * spawned agent (providers/shared.ts buildBaseEnv), and the real `claude`
 * binary reads these vars natively. This is plain env inheritance; the
 * dashboard-settings override that used to carry these values was removed.
 *
 * A settings.json is still written FIRST: `channels: []` disables the
 * default `server:autonomos` channel so spawns stay focused on the core
 * provider/PTY/hook path (no channel-server MCP subprocess, no
 * channels-warning prompt) — the hook relay, --brief,
 * --append-system-prompt and --settings argv are all still exercised.
 */
export async function bootServer(opts?: {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
}): Promise<BootedServer> {
  const configDir = mkdtempSync(join(tmpdir(), "autonomos-integ-"));
  const fakeHome = join(configDir, "home");
  const fakeClaudeDir = seedFakeHome(fakeHome);
  // Snapshot BEFORE anything spawns: only entries NEW since boot count, so the
  // operator's live fleet writing its own sessions can't trip the assertion.
  const realDirsBefore = listRealProjectDirs();
  const realTrustBefore = listRealTrustKeys();
  const token = `integ-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (opts?.anthropicBaseUrl) {
    writeFileSync(
      join(configDir, "settings.json"),
      `${JSON.stringify(
        {
          channels: [],
          autoTrust: true,
          statusLine: { enabled: false },
        },
        null,
        2,
      )}\n`,
    );
  }

  // Use `tsx` to run the TS source — matches what `make dev` does and
  // doesn't require a build step before tests can run.
  const tsxBin = fileURLToPath(
    new URL("../../../node_modules/.bin/tsx", import.meta.url),
  );

  const child = spawn(tsxBin, [SERVER_ENTRY, "--port=0"], {
    env: {
      ...process.env,
      AUTONOMOS_CONFIG_DIR: configDir,
      AUTONOMOS_TOKEN: token,
      // Inherited by every spawned agent (providers/shared.ts buildBaseEnv).
      HOME: fakeHome,
      CLAUDE_CONFIG_DIR: fakeClaudeDir,
      CODEX_HOME: join(fakeHome, ".codex"),
      // The usage plugin's keychain read is keyed on $USER, not HOME, so the
      // fake HOME alone does not isolate it. This makes it read no store.
      AUTONOMOS_DISABLE_CREDENTIAL_READS: "1",
      // No telemetry / error-report / auto-update traffic from test agents.
      // (Not CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: the provider strips every
      // CLAUDE_CODE_* var from agent envs, providers/shared.ts.)
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      ...(opts?.anthropicBaseUrl
        ? {
            ANTHROPIC_BASE_URL: opts.anthropicBaseUrl,
            ANTHROPIC_AUTH_TOKEN: opts.anthropicAuthToken ?? "sk-mock",
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));
  child.stderr.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

  // Readiness + port discovery: parse the server's standard startup log line
  // ("autonomOS server listening on http://localhost:<port>"), emitted the
  // moment the HTTP listener is accepting connections. With --port=0 the OS
  // assigns an ephemeral port, so this line is how we learn the actual port.
  //
  // NOTE: this resolves when HTTP is *listening*, which is BEFORE the gateway
  // and scheduler finish their fire-and-forget init (run.ts arms those after
  // the listen callback). HTTP routes (incl. /api/agents) work immediately; a
  // test that needs the gateway/router or scheduler should `waitFor` a health
  // probe rather than trust this resolution alone.
  const port = await new Promise<number>((resolveFn, rejectFn) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      rejectFn(
        new Error(
          `Server exited (code=${code}) before it started listening.\n` +
            `stdout:\n${stdoutChunks.join("")}\n` +
            `stderr:\n${stderrChunks.join("")}`,
        ),
      );
    };
    const onData = (): void => {
      // Anchor on the full banner and require a trailing newline so a chunk
      // boundary splitting the port mid-write can't resolve a truncated value,
      // and no other "listening on http(s)://…" line can wrong-match.
      const m = stdoutChunks
        .join("")
        .match(/autonomOS server listening on https?:\/\/[^\s:]+:(\d+)\n/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        resolveFn(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);

    timer = setTimeout(() => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      rejectFn(
        new Error(
          `Server failed to start listening within ${READY_TIMEOUT_MS}ms.\n` +
            `stdout:\n${stdoutChunks.join("")}\n` +
            `stderr:\n${stderrChunks.join("")}`,
        ),
      );
    }, READY_TIMEOUT_MS);
  });

  // The "listening on" banner is the PUBLIC listener's readiness signal, but
  // the internal control socket binds a moment later (after pid-file
  // arbitration, inside the acquired branch — see run.ts armRuntimeInits).
  // Tests that address the socket, or that spawn an agent whose hook relay
  // needs it, must wait for both. Poll the path rather than parse a second log
  // line: the file appearing IS the bind completing.
  const socketPath = join(configDir, "control.sock");
  const socketDeadline = Date.now() + READY_TIMEOUT_MS;
  while (!existsSync(socketPath)) {
    if (Date.now() > socketDeadline) {
      throw new Error(
        `Internal control socket never appeared at ${socketPath} within ` +
          `${READY_TIMEOUT_MS}ms.\nstdout:\n${stdoutChunks.join("")}\n` +
          `stderr:\n${stderrChunks.join("")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  return {
    port,
    token,
    configDir,
    fakeHome,
    kill: (): Promise<void> =>
      new Promise<void>((resolveKill) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveKill();
          return;
        }
        const force = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(force);
          resolveKill();
        });
        child.kill("SIGTERM");
      }),
    assertNoRealHomeLeak: (): void => {
      const { dirs, paths } = tmpPrefixes();
      const newDirs = [...listRealProjectDirs()].filter(
        (d) => !realDirsBefore.has(d) && dirs.some((p) => d.startsWith(p)),
      );
      const newTrust = [...listRealTrustKeys()].filter(
        (k) => !realTrustBefore.has(k) && paths.some((p) => k.startsWith(p)),
      );
      if (newDirs.length || newTrust.length) {
        throw new Error(
          "Integration run leaked into the operator's REAL Claude Code state " +
            `(expected everything under ${fakeHome}):\n` +
            newDirs
              .map((d) => `  ${realClaudeDir()}/projects/${d}`)
              .join("\n") +
            (newTrust.length
              ? `\n  ${realClaudeJson()} trust keys: ${newTrust.join(", ")}`
              : ""),
        );
      }
    },
    logs: (): string =>
      `stdout:\n${stdoutChunks.join("")}\nstderr:\n${stderrChunks.join("")}`,
  };
}

// ── Small HTTP helpers against the booted server ─────────────────────

export async function authedJson<T>(
  server: BootedServer,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  // Keep non-JSON error bodies (e.g. a 500 with a stack trace) diagnosable
  // instead of collapsing them to {}.
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = { error: text } as T;
  }
  return { status: res.status, body };
}

// ── Internal control socket (ADR-055) ────────────────────────────────

/** Path of the booted server's internal control socket. */
export function controlSocketPath(server: BootedServer): string {
  return join(server.configDir, "control.sock");
}

export interface SocketResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Make an HTTP request over the server's internal Unix socket.
 *
 * `fetch()` cannot address a Unix socket, so this drops to node:http with
 * `socketPath`. The hostname in the URL is irrelevant — the socket decides the
 * destination — which is exactly how the agent-side `curl --unix-socket`
 * reaches the same routes.
 */
export function socketRequest(
  server: BootedServer,
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<SocketResponse> {
  return new Promise((resolveFn, rejectFn) => {
    const req = request(
      {
        socketPath: controlSocketPath(server),
        path,
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
      },
      (res) => {
        const chunks: string[] = [];
        res.on("data", (d: Buffer) => chunks.push(d.toString()));
        res.on("end", () =>
          resolveFn({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: chunks.join(""),
          }),
        );
      },
    );
    req.on("error", rejectFn);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

/** Options for real-spawn suites' before/after hooks. node:test hooks have NO
 *  timeout by default, and a describe-level timeout does not bound them, so a
 *  wedged teardown (e.g. awaiting a server/mock that never closes) held CI
 *  until the 6h job limit with no output. Bounded, it fails fast and the
 *  failure names the hook. */
export const HOOK_TIMEOUT = { timeout: 60_000 };

/**
 * Run a suite's teardown with a bound that FAILS THE RUN. A node:test after()
 * hook that times out is reported but the run still exits 0 (verified), so a
 * hook `timeout` alone turns a wedged teardown into a silent green. On timeout
 * this sets process.exitCode = 1 (the file fails, exit 1) and names the suite.
 */
export async function boundedTeardown(
  label: string,
  fn: () => Promise<void>,
  ms = 60_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  const res = await Promise.race([fn().then(() => "ok" as const), timedOut]);
  clearTimeout(timer);
  if (res === "timeout") {
    process.exitCode = 1;
    console.error(
      `[integration] TEARDOWN TIMED OUT after ${ms}ms: ${label} — a server, mock, or spawned agent did not shut down`,
    );
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll an async predicate until it returns true or the deadline passes. */
export async function waitFor(
  fn: () => Promise<boolean>,
  { timeoutMs, intervalMs = 250 }: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}
