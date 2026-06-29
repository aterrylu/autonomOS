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
import { buildBaseEnv } from "../providers/shared.js";
import { _resetServerStateForTesting, setServerPort } from "../serverState.js";

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
    assert.ok(
      env.PATH?.includes(".bun/bin"),
      "expected BINARY_DIRS prepended to PATH",
    );
  });
});
