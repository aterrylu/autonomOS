import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { codexProvider } from "../providers/codex.js";
import { writeGeminiSettings } from "../providers/gemini-cli.js";
import { buildBaseEnv, RESERVED_ENV_KEYS } from "../providers/shared.js";
import {
  _resetServerStateForTesting,
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "../serverState.js";

/**
 * Security audit V3: agents must never hold the OPERATOR token.
 *
 * It reached them three ways: Claude Code's `--mcp-config` JSON and Codex's
 * `-c mcp_servers.autonomos.env.AUTONOMOS_TOKEN=…` (both argv, readable by
 * other local users via `ps`), and the process env, because buildBaseEnv
 * copied the server's env wholesale (audit Hardening #7). Gemini's copy sat in
 * a 0600 settings file. The channel server now authenticates with its
 * PER-AGENT token instead.
 *
 * Each check searches the WHOLE output for the canary value rather than one
 * known key, so a path nobody mapped fails too.
 */

const CANARY = "operator-canary-7f3a9c1e5b2d4086";

let tmpDir: string;

function options(): ResolvedSpawnOptions {
  return {
    workingDirectory: "/tmp",
    cwd: "/tmp",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "TestAgent",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    injectChannelServer: true,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "53917",
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:53917",
    // The runtime picks this before building the Codex daemon sidecar.
    sidecarEndpoint: "ws://127.0.0.1:1",
  };
}

describe("agents never receive the operator token (audit V3)", () => {
  let prevEnvToken: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aos-no-optoken-"));
    _setConfigDirForTesting(tmpDir);
    setServerPort(53917);
    setAuthToken(CANARY);
    setInternalSocketPath("/tmp/aos-test/control.sock");
    // The server was launched with the token in its env (the .env path).
    prevEnvToken = process.env.AUTONOMOS_TOKEN;
    process.env.AUTONOMOS_TOKEN = CANARY;
  });

  after(() => {
    if (prevEnvToken === undefined) delete process.env.AUTONOMOS_TOKEN;
    else process.env.AUTONOMOS_TOKEN = prevEnvToken;
    _resetConfigDirForTesting();
    _resetServerStateForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("precondition: the canary really is the operator token in play", () => {
    assert.equal(process.env.AUTONOMOS_TOKEN, CANARY);
  });

  it("Claude Code argv (incl. --mcp-config) does not contain it", () => {
    const args = claudeCodeProvider.buildArgs(options());
    assert.ok(
      args.some((a) => a.includes("AUTONOMOS_SESSION_ID")),
      "precondition: the channel-server MCP config was emitted",
    );
    assert.ok(!args.join("\n").includes(CANARY));
  });

  it("Codex TUI argv and daemon argv do not contain it", () => {
    const tui = codexProvider.buildArgs(options());
    const daemon = codexProvider.buildSidecar?.(options());
    assert.ok(daemon, "precondition: codex builds a daemon sidecar");
    const daemonArgs = JSON.stringify(daemon);
    assert.ok(
      daemonArgs.includes("mcp_servers.autonomos"),
      "precondition: the daemon carries the channel-server MCP config",
    );
    assert.ok(!tui.join("\n").includes(CANARY));
    assert.ok(!daemonArgs.includes(CANARY));
  });

  it("the Gemini settings file does not contain it", () => {
    writeGeminiSettings("/tmp/channel-server.mjs");
    const settings = readFileSync(
      join(tmpDir, "gemini-settings.json"),
      "utf-8",
    );
    assert.ok(
      settings.includes("AUTONOMOS_SESSION_ID") ||
        settings.includes("autonomos"),
    );
    assert.ok(!settings.includes(CANARY));
  });

  it("the spawned process env does not contain it, even when the server's env does", () => {
    const env = buildBaseEnv("session-1", "Agent1");
    assert.equal(env.AUTONOMOS_TOKEN, undefined);
    assert.ok(!Object.values(env).some((v) => v?.includes(CANARY)));
  });

  it("presets and customEnvVars can't re-inject it (reserved key)", () => {
    assert.ok(RESERVED_ENV_KEYS.has("AUTONOMOS_TOKEN"));
  });
});
