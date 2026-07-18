import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { buildBaseEnv, HOOK_CMD } from "../providers/shared.js";
import {
  _resetServerStateForTesting,
  setInternalSocketPath,
  setServerPort,
} from "../serverState.js";

/**
 * buildEnv contract after the Anthropic API-override removal:
 *
 * - ANTHROPIC_* vars reach spawned sessions ONLY via process.env
 *   inheritance (buildBaseEnv spreads process.env). The CI integration
 *   harness (helpers/test-server.ts) relies on this to point real
 *   `claude` binaries at the mock /v1/messages backend.
 * - Stale anthropic* keys in settings.json are NEVER injected — the
 *   settings-driven override was removed.
 * - customEnvVars remains the supported way to set ANTHROPIC_BASE_URL
 *   from settings (generic env vars, no special-casing).
 */

let tmpDir: string;

function writeSettings(body: Record<string, unknown>): void {
  writeFileSync(
    join(tmpDir, "settings.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe("claudeCodeProvider.buildEnv — ANTHROPIC_* handling", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-provider-env-"));
    _setConfigDirForTesting(tmpDir);
    setServerPort(53917);
    setInternalSocketPath("/tmp/aos-test/control.sock");
    // Isolate from any ambient values on the host/CI runner.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  after(() => {
    _resetConfigDirForTesting();
    _resetServerStateForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    writeSettings({});
  });

  it("inherits ANTHROPIC_BASE_URL/AUTH_TOKEN from process.env (integration-harness contract)", () => {
    writeSettings({});
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:54321";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-mock";
    const env = claudeCodeProvider.buildEnv("session-1", "Agent1");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-mock");
  });

  it("never injects stale anthropic* settings.json keys", () => {
    writeSettings({
      anthropicBaseUrl: "http://litellm:4000",
      anthropicAuthToken: "sk-stale",
      anthropicOverrideEnabled: true,
    });
    const env = claudeCodeProvider.buildEnv("session-2", "Agent2");
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("allows customEnvVars to set ANTHROPIC_BASE_URL (the supported escape hatch)", () => {
    writeSettings({
      customEnvVars: { ANTHROPIC_BASE_URL: "http://litellm:4000" },
    });
    const env = claudeCodeProvider.buildEnv("session-3", "Agent3");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://litellm:4000");
  });
});

/**
 * buildBaseEnv strips host Claude Code session identity so that a server
 * launched from inside a CC session doesn't re-broadcast CLAUDE_CODE_* /
 * CLAUDECODE into every spawned agent (which would pin the agent CLI version
 * and collide with the per-agent --session-id flag). ANTHROPIC_* and all
 * unrelated vars must survive — #214's CI harness depends on the spread.
 */
describe("buildBaseEnv — host CLAUDE_CODE_* contamination strip", () => {
  // Snapshot the host values we mutate so we never leak into other tests.
  const KEYS = [
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDECODE",
    "ANTHROPIC_BASE_URL",
    "MY_UNRELATED_VAR",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  before(() => {
    setServerPort(53918);
    setInternalSocketPath("/tmp/aos-test/control.sock");
    for (const k of KEYS) saved[k] = process.env[k];
  });

  after(() => {
    _resetServerStateForTesting();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("removes CLAUDE_CODE_* and CLAUDECODE while preserving ANTHROPIC_* and unrelated vars", () => {
    process.env.CLAUDE_CODE_EXECPATH = "/host/cli/2.1.183/claude";
    process.env.CLAUDE_CODE_SESSION_ID = "host-session-collides";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDECODE = "1";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:54321";
    process.env.MY_UNRELATED_VAR = "keep-me";

    const env = buildBaseEnv("agent-session-id", "Agent1");

    // Host CC identity is stripped.
    assert.equal(env.CLAUDE_CODE_EXECPATH, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDECODE, undefined);

    // Scope guard: ANTHROPIC_* and unrelated vars pass through untouched.
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:54321");
    assert.equal(env.MY_UNRELATED_VAR, "keep-me");

    // Core AUTONOMOS_* wiring and PATH enrichment still happen.
    assert.equal(env.AUTONOMOS_SERVER, "http://localhost:53918");
    assert.equal(env.AUTONOMOS_SESSION_ID, "agent-session-id");
    assert.equal(env.AUTONOMOS_AGENT_NAME, "Agent1");
    assert.equal(
      env.AUTONOMOS_INTERNAL_SOCKET,
      "/tmp/aos-test/control.sock",
      "hooks address the control plane by socket path, not by URL",
    );
    assert.ok(
      env.PATH?.includes(".bun/bin"),
      "expected BINARY_DIRS prepended to PATH",
    );
  });

  // ADR-055 layer 4. AUTONOMOS_SERVER used to serve BOTH planes: the hook
  // relay's /api/hooks (internal) and statusline.mjs's /api/agents (public).
  // Splitting them is the point — and a regression that re-merged them would
  // be silent, because hook curls are `-sf >/dev/null 2>&1` and a broken
  // statusline just renders nothing. Pin both ends.
  it("keeps the public and internal planes on separate single-purpose vars", () => {
    const env = buildBaseEnv("session-x", "Agent1");

    // Public plane: an http URL on the real bound port. statusline.mjs reads
    // this to GET /api/agents, which lives on the public listener.
    assert.equal(env.AUTONOMOS_SERVER, "http://localhost:53918");
    assert.ok(
      env.AUTONOMOS_SERVER?.startsWith("http://"),
      "statusline needs a dialable URL, not a socket path",
    );

    // Internal plane: a filesystem path for `curl --unix-socket`.
    assert.equal(env.AUTONOMOS_INTERNAL_SOCKET, "/tmp/aos-test/control.sock");
    assert.ok(
      !env.AUTONOMOS_INTERNAL_SOCKET?.includes("://"),
      "the control plane is addressed by socket path, not a URL",
    );

    // They must not be the same value — that collapse is the coupling this
    // decoupling exists to prevent.
    assert.notEqual(env.AUTONOMOS_SERVER, env.AUTONOMOS_INTERNAL_SOCKET);
  });
});

describe("HOOK_CMD targets the internal socket", () => {
  it("curls the control socket, not the public port", () => {
    // Shell vars stay UNEXPANDED on purpose — they are interpolated by the
    // agent's shell at hook time, from the env buildBaseEnv provides.
    assert.ok(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal shell var
      HOOK_CMD.includes('--unix-socket "${AUTONOMOS_INTERNAL_SOCKET}"'),
      `HOOK_CMD must dial the control socket. Got: ${HOOK_CMD}`,
    );
    assert.ok(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal shell var
      HOOK_CMD.includes('"http://localhost/api/hooks/${AUTONOMOS_SESSION_ID}"'),
      "the URL host is a placeholder curl never resolves; --unix-socket routes it",
    );
    // The old public-port form must be gone: if AUTONOMOS_SERVER crept back
    // into HOOK_CMD, hooks would ride the public listener again — where the
    // route no longer exists and every post would silently 401/404.
    assert.ok(
      !HOOK_CMD.includes("AUTONOMOS_SERVER"),
      "HOOK_CMD must not reference the PUBLIC base URL",
    );
  });
});
