/**
 * Shared harness for the CI-only real-spawn integration suites: boots the
 * REAL server as a child process with an isolated CONFIG_DIR, plus small
 * HTTP helpers.
 *
 * CI-ONLY GATE (load-bearing safety). These suites boot a real autonomos
 * server and spawn REAL `claude` processes under a PTY. On a developer machine
 * that is ALSO running a live autonomos deployment, that is dangerous — a
 * careless cleanup like `pkill -f claude` would kill the operator's real
 * agents (this happened once). So the suites NEVER run unless
 * AUTONOMOS_INTEGRATION=1 is set, which ONLY CI sets (see
 * .github/workflows/test.yml). If you ever run them locally, do so on a
 * machine with no live deployment, and NEVER use a broad pkill — only ever
 * kill scoped PIDs / agent ids.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  kill: () => void;
  /** Full stdout+stderr captured so far — include in assertion messages so
   *  the server's prompt-delivery/auto-trust decisions are visible on failure. */
  logs: () => string;
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

  return {
    port,
    token,
    configDir,
    kill: (): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
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
