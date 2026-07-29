import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { buildBaseEnv } from "../providers/shared.js";
import {
  _resetServerStateForTesting,
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "../serverState.js";

/**
 * The Built-in (embedded) mode reachability regression — when the server boots
 * with --port=0 and the OS picks an ephemeral port, spawned Claude Code sessions
 * USED to get `localhost:3000` baked into their hook + gateway URLs because the
 * spawn code read `process.env.PORT || "3000"`. The fix routes the actual
 * bound port through serverState. These tests guard the fix.
 *
 * The same family of tests covers the auth-token forwarding fix: providers
 * USED to read `process.env.AUTONOMOS_TOKEN`, which is undefined when
 * resolveAuthToken() falls back to reading ~/.autonomos/token off disk —
 * leaving the channel server tokenless and rejected by /ws/* auth.
 */

let tmpDir: string;

function baseOptions(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
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

    ...overrides,
  };
}

describe("Built-in mode URL + token forwarding", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-url-token-"));
    _setConfigDirForTesting(tmpDir);
    setServerPort(53917);
    setAuthToken("test-token-1234567890abcdef");
    setInternalSocketPath("/tmp/aos-test/control.sock");
  });

  after(() => {
    _resetConfigDirForTesting();
    _resetServerStateForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("shared.buildBaseEnv", () => {
    it("composes AUTONOMOS_SERVER from the actual bound port, not process.env.PORT", () => {
      // Even with PORT=3000 in env, the URL must reflect the actual bound port
      // from serverState. This is the regression that breaks Built-in mode.
      const prev = process.env.PORT;
      process.env.PORT = "3000";
      try {
        const env = buildBaseEnv("session-1", "Agent1");
        assert.equal(env.AUTONOMOS_SERVER, "http://localhost:53917");
        assert.equal(env.AUTONOMOS_SESSION_ID, "session-1");
        assert.equal(env.AUTONOMOS_AGENT_NAME, "Agent1");
      } finally {
        if (prev === undefined) delete process.env.PORT;
        else process.env.PORT = prev;
      }
    });

    it("strips PORT from the spawned child's env to prevent stale leak", () => {
      const env = buildBaseEnv("session-2", "Agent2");
      assert.equal(env.PORT, undefined);
    });
  });

  describe("claudeCodeProvider.buildArgs with injectChannelServer", () => {
    function readMcpEnv(args: string[]): Record<string, string> {
      const idx = args.indexOf("--mcp-config");
      assert.ok(idx >= 0, "expected --mcp-config flag");
      const config = JSON.parse(args[idx + 1] ?? "{}");
      return config.mcpServers.autonomos.env;
    }

    it("points the gateway at the control socket and the REST base at the public port", () => {
      writeFileSync(
        join(tmpDir, "settings.json"),
        `${JSON.stringify({ channels: ["server:autonomos"] })}\n`,
      );
      const args = claudeCodeProvider.buildArgs(baseOptions());
      const env = readMcpEnv(args);
      // ADR-055 PR B: gateway on the socket (ws+unix), REST base stays public.
      assert.equal(
        env.AUTONOMOS_SERVER_URL,
        "ws+unix:///tmp/aos-test/control.sock:/ws/gateway",
      );
      assert.equal(env.AUTONOMOS_API_URL, "http://localhost:53917");
    });

    it("always forwards the in-process auth token — even when process.env.AUTONOMOS_TOKEN is unset", () => {
      const prev = process.env.AUTONOMOS_TOKEN;
      delete process.env.AUTONOMOS_TOKEN;
      try {
        const args = claudeCodeProvider.buildArgs(baseOptions());
        const env = readMcpEnv(args);
        assert.equal(env.AUTONOMOS_TOKEN, "test-token-1234567890abcdef");
      } finally {
        if (prev !== undefined) process.env.AUTONOMOS_TOKEN = prev;
      }
    });

    it("propagates session id + agent name into MCP env", () => {
      const args = claudeCodeProvider.buildArgs(baseOptions());
      const env = readMcpEnv(args);
      assert.equal(
        env.AUTONOMOS_SESSION_ID,
        "11111111-1111-4111-8111-111111111111",
      );
      assert.equal(env.AUTONOMOS_AGENT_NAME, "TestAgent");
    });

    it("injects CONFIG_DIR (token-file path) but NOT the per-agent token", () => {
      // ADR-055 follow-up: the channel server reads its per-agent token from a
      // file under CONFIG_DIR, not from env — so CONFIG_DIR must be present and
      // AUTONOMOS_AGENT_TOKEN must NOT be (uniform across providers).
      const args = claudeCodeProvider.buildArgs(baseOptions());
      const env = readMcpEnv(args);
      assert.equal(env.AUTONOMOS_CONFIG_DIR, tmpDir);
      assert.equal(env.AUTONOMOS_AGENT_TOKEN, undefined);
    });
  });

  describe("codexProvider.buildArgs with injectChannelServer", () => {
    function readCfgValue(args: string[], key: string): string | null {
      // codex uses `-c key=JSON_VALUE` arg pairs
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "-c" && args[i + 1]?.startsWith(`${key}=`)) {
          const raw = args[i + 1].slice(key.length + 1);
          return JSON.parse(raw);
        }
      }
      return null;
    }

    it("points the gateway at the control socket and the REST base at the public port", () => {
      const args = codexProvider.buildArgs(baseOptions());
      const url = readCfgValue(
        args,
        "mcp_servers.autonomos.env.AUTONOMOS_SERVER_URL",
      );
      assert.equal(url, "ws+unix:///tmp/aos-test/control.sock:/ws/gateway");
      const apiUrl = readCfgValue(
        args,
        "mcp_servers.autonomos.env.AUTONOMOS_API_URL",
      );
      assert.equal(apiUrl, "http://localhost:53917");
    });

    it("always forwards the in-process auth token (no env fallthrough)", () => {
      const prev = process.env.AUTONOMOS_TOKEN;
      delete process.env.AUTONOMOS_TOKEN;
      try {
        const args = codexProvider.buildArgs(baseOptions());
        const token = readCfgValue(
          args,
          "mcp_servers.autonomos.env.AUTONOMOS_TOKEN",
        );
        assert.equal(token, "test-token-1234567890abcdef");
      } finally {
        if (prev !== undefined) process.env.AUTONOMOS_TOKEN = prev;
      }
    });

    it("injects CONFIG_DIR but NOT the per-agent token as a `-c` flag", () => {
      // Codex writes argv to world-readable /proc/<pid>/cmdline, so the token
      // must never be a `-c` flag; the channel server reads it from the 0600
      // file at CONFIG_DIR/agent-tokens/<sessionId> instead (ADR-055 follow-up).
      const args = codexProvider.buildArgs(baseOptions());
      assert.equal(
        readCfgValue(args, "mcp_servers.autonomos.env.AUTONOMOS_CONFIG_DIR"),
        tmpDir,
      );
      assert.equal(
        readCfgValue(args, "mcp_servers.autonomos.env.AUTONOMOS_AGENT_TOKEN"),
        null,
      );
      // Belt-and-suspenders: the raw token must not appear anywhere in argv.
      assert.ok(
        !args.some((a) => a.includes("AUTONOMOS_AGENT_TOKEN")),
        "no argv token flag",
      );
    });
  });
});
