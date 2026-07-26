import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WSContext } from "hono/ws";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
  markExited,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  isSessionClientRegistered,
  registerSessionClient,
  routeMessage,
  unregisterSessionClient,
} from "../gateway/router.js";

describe("routeMessage — URI routing", () => {
  // Note: routeMessage depends on sessionClients registry.
  // Without registered sessions, agent:// routes will fail with "not found".
  // These tests verify URI parsing, scheme handling, and error paths.

  it("rejects invalid URI (no scheme)", async () => {
    const err = await routeMessage("no-scheme", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("Invalid URI"));
  });

  it("rejects unknown URI scheme", async () => {
    const err = await routeMessage("ftp://server/file", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("Unknown URI scheme"));
    assert.ok(err.includes("ftp"));
  });

  it("returns error for agent:// when no agents connected", async () => {
    const err = await routeMessage(
      "agent://nonexistent",
      "hello",
      "sender-123",
    );
    assert.ok(err);
    assert.ok(err.includes("not found"));
  });

  it("returns error for slack:// when adapter not connected", async () => {
    const err = await routeMessage(
      "slack://workspace/channel",
      "hello",
      "sender-123",
    );
    assert.ok(err);
    assert.ok(err.includes("not available") || err.includes("not connected"));
  });

  it("rejects removed platform schemes (discord, telegram)", async () => {
    // These adapters were removed — their URIs must fail as unknown
    // schemes rather than silently dropping messages.
    for (const uri of ["discord://guild/channel", "telegram://chat-id"]) {
      const err = await routeMessage(uri, "hello", "sender-123");
      assert.ok(err);
      assert.ok(err.includes("Unknown URI scheme"));
    }
  });

  it("broadcast:// succeeds even with no agents (no-op)", async () => {
    const err = await routeMessage(
      "broadcast://all",
      "hello everyone",
      "sender-123",
    );
    assert.equal(err, null);
  });

  it("parses URI scheme correctly", async () => {
    // agent:// with a name containing special chars
    const err = await routeMessage("agent://My Agent", "hello", "sender-123");
    // Should fail with "not found" (no agents registered), not "invalid URI"
    assert.ok(err);
    assert.ok(err.includes("not found"));
    assert.ok(!err.includes("Invalid URI"));
  });
});

describe("isSessionClientRegistered — channel-server liveness probe", () => {
  // The registry compares WSContext by identity; a bare object stands in for a
  // real socket. This is the signal the runtime probes to detect a Codex agent
  // whose daemon-launched channel server never came up (silent loss of send()).
  const fakeWs = {} as WSContext;
  const agentId = "a4-probe-agent";

  it("is false before the channel server registers", () => {
    assert.equal(isSessionClientRegistered(agentId), false);
  });

  it("is true once the channel server registers, false after it disconnects", () => {
    registerSessionClient(agentId, fakeWs);
    assert.equal(isSessionClientRegistered(agentId), true);
    unregisterSessionClient(fakeWs);
    assert.equal(isSessionClientRegistered(agentId), false);
  });
});

/**
 * A Codex agent that is NOT `running` used to fall through to the generic
 * channel-server delivery path — and Codex agents DO hold that socket (they
 * need it for outbound `send()`) while never reading inbound from it (they
 * consume turns from their app-server daemon). So the write "succeeded",
 * `routeMessage` returned null (success) to the sender, nothing was logged, and
 * the recipient discarded the bytes.
 *
 * This is the PR's one behavior change: that call now returns an error. The
 * window is real — the seconds between markExited and the agent's MCP
 * subprocess dropping its socket, and the same window during a resume-crash
 * respawn — which is exactly when an agent is most likely to be messaged.
 */
describe("routeMessage — a non-running Codex agent fails loudly, not silently", () => {
  let isolatedDir: string;
  const SENDER = "5e2de100-0000-4000-8000-00000000ffff";

  function seedAgent(
    id: string,
    name: string,
    provider: "codex" | "claude-code",
    exited: boolean,
  ) {
    const agent = insertAgent(
      buildAgent({
        id: id as never,
        name,
        workingDirectory: "/tmp",
        provider,
        providerSessionId: id,
        permissionMode: "default",
      }),
    );
    if (exited) markExited(id as never, "user_killed");
    return agent;
  }

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-router-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("refuses delivery to an exited Codex agent whose socket is still open", async () => {
    const id = "c0de0000-0000-4000-8000-000000000001";
    seedAgent(id, "GhostCodex", "codex", true);
    const writes: string[] = [];
    const ws = {
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage(
      "agent://GhostCodex",
      "are you there?",
      SENDER,
    );

    assert.ok(err, "must return an error, not null (null means success)");
    assert.match(err, /not currently running/);
    assert.match(err, /not delivered/);
    assert.equal(
      writes.length,
      0,
      "must NOT write into a socket whose reader discards inbound",
    );
    unregisterSessionClient(ws);
  });

  it("still delivers to a non-Codex agent over the channel-server socket", async () => {
    // The guard must be Codex-specific — Claude Code genuinely consumes inbound
    // on this socket, so narrowing it further would break real delivery.
    const id = "c1ad0000-0000-4000-8000-00000000000a";
    seedAgent(id, "LiveClaude", "claude-code", false);
    const writes: string[] = [];
    const ws = {
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage("agent://LiveClaude", "ping", SENDER);

    assert.equal(err, null, `expected success, got: ${err}`);
    assert.equal(writes.length, 1, "the message must reach the socket");
    assert.match(writes[0], /ping/);
    unregisterSessionClient(ws);
  });
});
