import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { PermissionMode, ResolvedSpawnOptions } from "@autonomos/core";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { codexProvider } from "../providers/codex.js";
import {
  _resetServerStateForTesting,
  setAuthToken,
  setServerPort,
} from "../serverState.js";

/**
 * Codex per-agent DAEMON topology (A1). The provider splits a Codex spawn into:
 *   - buildSidecar(): the `codex app-server --listen ws://…` daemon (system
 *     prompt + MCP + approval config live here)
 *   - buildArgs(): the visible `codex --remote ws://…` TUI (thin client)
 * The runtime sets options.sidecarEndpoint between the two so both reference the
 * same ws:// endpoint.
 */

let tmpDir: string;

function baseOptions(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
  return {
    workingDirectory: "/work",
    cwd: "/work",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "CodexAgent",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "53917",
    capabilities: ["send"],
    ...overrides,
  };
}

const ENDPOINT = "ws://127.0.0.1:54321";

describe("codex daemon topology", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-codex-daemon-"));
    _setConfigDirForTesting(tmpDir);
    setServerPort(53917);
    setAuthToken("test-token-1234567890abcdef");
  });

  after(() => {
    _resetServerStateForTesting();
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("buildSidecar", () => {
    it("returns null when no sidecarEndpoint is set (runtime hasn't picked a port)", () => {
      assert.equal(codexProvider.buildSidecar?.(baseOptions()), null);
    });

    it("describes the app-server daemon listening on the runtime's endpoint", () => {
      const spec = codexProvider.buildSidecar?.(
        baseOptions({ sidecarEndpoint: ENDPOINT }),
      );
      assert.ok(spec, "expected a sidecar spec");
      assert.deepEqual(spec.args.slice(0, 3), [
        "app-server",
        "--listen",
        ENDPOINT,
      ]);
      // Readiness is detected from the daemon's "listening on" banner.
      assert.equal(spec.readyNeedle, "listening on");
      // System prompt rides on the daemon so every thread inherits it.
      const instrIdx = spec.args.indexOf("-c");
      assert.ok(
        spec.args.some((a) => a.startsWith("instructions=")),
        "daemon should carry -c instructions=",
      );
      assert.ok(instrIdx >= 0);
    });

    it("attaches the MCP channel server to the DAEMON when injectChannelServer", () => {
      const spec = codexProvider.buildSidecar?.(
        baseOptions({ sidecarEndpoint: ENDPOINT, injectChannelServer: true }),
      );
      assert.ok(spec);
      const joined = spec.args.join(" ");
      assert.match(joined, /mcp_servers\.autonomos\.command="node"/);
      assert.match(joined, /mcp_servers\.autonomos\.env\.AUTONOMOS_SESSION_ID/);
      // Auth token is always forwarded (no process.env fallthrough).
      assert.match(
        joined,
        /mcp_servers\.autonomos\.env\.AUTONOMOS_TOKEN="test-token-1234567890abcdef"/,
      );
    });

    it("omits MCP config when injectChannelServer is false", () => {
      const spec = codexProvider.buildSidecar?.(
        baseOptions({ sidecarEndpoint: ENDPOINT, injectChannelServer: false }),
      );
      assert.ok(spec);
      assert.doesNotMatch(spec.args.join(" "), /mcp_servers/);
    });

    it("ALWAYS disables the OS sandbox on the daemon (no bubblewrap), all modes", () => {
      for (const permissionMode of [
        "default",
        "auto",
        "plan",
        "bypass",
      ] as const) {
        const spec = codexProvider.buildSidecar?.(
          baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode }),
        );
        assert.ok(spec);
        assert.match(spec.args.join(" "), /sandbox_mode="danger-full-access"/);
      }
    });

    it("maps permissionMode → approval_policy on the daemon (always set)", () => {
      // Codex has no plan mode — 'plan' clamps to the default (on-request).
      const cases: Record<PermissionMode, string> = {
        default: "on-request",
        auto: "on-failure",
        plan: "on-request",
        bypass: "never",
      };
      for (const [permissionMode, policy] of Object.entries(cases)) {
        const spec = codexProvider.buildSidecar?.(
          baseOptions({
            sidecarEndpoint: ENDPOINT,
            permissionMode: permissionMode as PermissionMode,
          }),
        );
        assert.match(
          spec?.args.join(" ") ?? "",
          new RegExp(`approval_policy="${policy}"`),
          `expected ${permissionMode} → approval_policy="${policy}"`,
        );
      }
    });

    it("warns exactly once when clamping the unsupported 'plan' mode", () => {
      const warnings: string[] = [];
      const orig = console.warn;
      console.warn = (msg?: unknown) => {
        warnings.push(String(msg));
      };
      try {
        codexProvider.buildSidecar?.(
          baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: "plan" }),
        );
      } finally {
        console.warn = orig;
      }
      const planWarnings = warnings.filter((w) => w.includes("plan"));
      assert.equal(planWarnings.length, 1, "expected exactly one plan warning");
      assert.match(planWarnings[0], /no Codex equivalent/);
    });

    it("does NOT warn when clamping is not needed (supported modes)", () => {
      const warnings: string[] = [];
      const orig = console.warn;
      console.warn = (msg?: unknown) => {
        warnings.push(String(msg));
      };
      try {
        for (const mode of ["default", "auto", "bypass"] as const) {
          codexProvider.buildSidecar?.(
            baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: mode }),
          );
        }
      } finally {
        console.warn = orig;
      }
      assert.equal(warnings.filter((w) => w.includes("plan")).length, 0);
    });
  });

  describe("buildArgs", () => {
    it("autonomous TUI bypasses approvals AND sandbox (the CC --dangerously-skip-permissions equivalent)", () => {
      const args = codexProvider.buildArgs(
        baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: "bypass" }),
      );
      assert.deepEqual(args, [
        "--remote",
        ENDPOINT,
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
    });

    it("supervised TUI drops the sandbox but keeps approval prompts", () => {
      const args = codexProvider.buildArgs(
        baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: "default" }),
      );
      assert.deepEqual(args, [
        "--remote",
        ENDPOINT,
        "-s",
        "danger-full-access",
        "-c",
        'approval_policy="on-request"',
      ]);
      assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    });

    it("auto mode keeps the sandbox off and sets approval_policy=on-failure", () => {
      const args = codexProvider.buildArgs(
        baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: "auto" }),
      );
      assert.deepEqual(args, [
        "--remote",
        ENDPOINT,
        "-s",
        "danger-full-access",
        "-c",
        'approval_policy="on-failure"',
      ]);
    });

    it("RESUMES the prior conversation when a threadId was captured", () => {
      const args = codexProvider.buildArgs(
        baseOptions({
          sidecarEndpoint: ENDPOINT,
          permissionMode: "bypass",
          providerThreadId: "thread-abc-123",
        }),
      );
      // `codex resume <id> --remote <ep>` reattaches the persisted conversation
      // instead of `--remote` alone (which forks a fresh empty thread).
      assert.deepEqual(args, [
        "resume",
        "thread-abc-123",
        "--remote",
        ENDPOINT,
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
    });

    it("does NOT use the resume form on a first spawn (no threadId yet)", () => {
      const args = codexProvider.buildArgs(
        baseOptions({ sidecarEndpoint: ENDPOINT, permissionMode: "bypass" }),
      );
      assert.ok(!args.includes("resume"));
      assert.equal(args[0], "--remote");
    });

    it("appends the starting prompt after the TUI flags", () => {
      const args = codexProvider.buildArgs(
        baseOptions({
          sidecarEndpoint: ENDPOINT,
          permissionMode: "bypass",
          prompt: "do the thing",
        }),
      );
      assert.equal(args[0], "--remote");
      assert.equal(args[1], ENDPOINT);
      assert.equal(args[args.length - 1], "do the thing");
    });

    it("the TUI --remote endpoint matches the daemon --listen endpoint", () => {
      const opts = baseOptions({ sidecarEndpoint: ENDPOINT });
      const spec = codexProvider.buildSidecar?.(opts);
      const args = codexProvider.buildArgs(opts);
      const listenIdx = spec?.args.indexOf("--listen") ?? -1;
      const remoteIdx = args.indexOf("--remote");
      assert.ok(spec && listenIdx >= 0 && remoteIdx >= 0);
      assert.equal(spec.args[listenIdx + 1], args[remoteIdx + 1]);
    });

    it("falls back to the legacy in-process form when there is no sidecar", () => {
      const args = codexProvider.buildArgs(baseOptions());
      assert.ok(
        args.includes("--cd"),
        "legacy path still sets --cd for the in-process TUI",
      );
      assert.ok(!args.includes("--remote"));
    });
  });

  describe("capabilities", () => {
    it("declares native terminal-preserving inbound", () => {
      assert.equal(codexProvider.capabilities.messaging.inbound, true);
      assert.equal(
        codexProvider.capabilities.messaging.inboundMethod,
        "channels",
      );
    });
  });
});
