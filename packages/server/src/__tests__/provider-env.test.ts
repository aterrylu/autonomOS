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
import { _resetServerStateForTesting, setServerPort } from "../serverState.js";

/**
 * buildEnv contract after the Anthropic API-override removal:
 *
 * - ANTHROPIC_* vars reach spawned sessions ONLY via process.env
 *   inheritance (buildBaseEnv spreads process.env). The CI integration
 *   harness (helpers/embedded-server.ts) relies on this to point real
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
