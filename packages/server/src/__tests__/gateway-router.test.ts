import assert from "node:assert/strict";
// Config-dir isolation: transitively resolves the config dir; the configDir
// test-escape guard refuses the production dir from a test process.
import { mkdtempSync as __mkdtemp, mkdtempSync, rmSync } from "node:fs";
import { tmpdir as __tmpdir, tmpdir } from "node:os";
import { join as __join, join } from "node:path";
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

process.env.AUTONOMOS_CONFIG_DIR = __mkdtemp(__join(__tmpdir(), "aos-iso-"));

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

  it("rejects removed platform schemes (slack, discord, telegram)", async () => {
    // `slack://` is here rather than in a suite of its own because it was the
    // most dangerous scheme in the router: its only adapter was a StubAdapter
    // whose send() console.logged and returned a fabricated message id, so this
    // call used to return null — SUCCESS — for a message that reached a log
    // line and nothing else. Removed with the adapters (ADR-064).
    for (const uri of [
      "slack://workspace/channel",
      "discord://guild/channel",
      "telegram://chat-id",
    ]) {
      const err = await routeMessage(uri, "hello", "sender-123");
      assert.ok(err, `${uri} must not report success`);
      assert.ok(err.includes("Unknown URI scheme"), `got: ${err}`);
    }
  });

  it("broadcast:// is refused, and says what to use instead", async () => {
    // It used to return null (success) unconditionally — including with a fleet
    // of zero, and including when every recipient was unreachable. Removed in
    // ADR-064. Agents spawned before the removal still carry `broadcast://all`
    // in their baked-in system prompt, so the error has to be actionable rather
    // than a bare "unknown scheme".
    const err = await routeMessage(
      "broadcast://all",
      "hello everyone",
      "sender-123",
    );
    assert.ok(err, "broadcast must NOT report success");
    assert.match(err, /removed/);
    assert.match(err, /agent:\/\//, "must name the replacement");
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
    provider: "codex" | "claude-code" | "gemini-cli",
    exited: boolean,
  ) {
    const agent = insertAgent(
      buildAgent({
        id: id as never,
        name,
        workingDirectory: "/tmp",
        provider,
        providerSessionId: id,
        permissionMode: "ask",
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
      readyState: 1, // OPEN — delivery now requires it, not just a send() that returns
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage("agent://LiveClaude", "ping", SENDER);

    assert.equal(err, null, `expected success, got: ${err}`);
    assert.equal(writes.length, 1, "the message must reach the socket");
    assert.match(writes[0], /ping/);
    unregisterSessionClient(ws);
  });

  it("refuses delivery to a Claude Code socket that is already CLOSING", async () => {
    // The registry is cleaned up on the socket's close EVENT, which lands after
    // the socket stops carrying data — so there is a real window where a client
    // is registered but cannot receive. `WSContext.send()` is not guaranteed to
    // throw there (the underlying impl may drop the frame), so the old
    // "no exception means delivered" inference reported success into the void.
    const id = "c1ad0000-0000-4000-8000-00000000000b";
    seedAgent(id, "ClosingClaude", "claude-code", false);
    const writes: string[] = [];
    const ws = {
      readyState: 2, // CLOSING
      // Deliberately does NOT throw — that is the whole point. A mock that threw
      // would let the old catch-based code pass and prove nothing.
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage("agent://ClosingClaude", "ping", SENDER);

    assert.ok(err, "must return an error — null would claim delivery");
    assert.match(err, /not delivered/);
    assert.equal(
      writes.length,
      0,
      "must not write into a socket that cannot carry it",
    );
    unregisterSessionClient(ws);
  });

  it("refuses delivery to a Gemini agent — it has NO inbound path (false-ack guard)", async () => {
    // Gemini holds a channel-server socket for OUTBOUND send() only; its reader
    // ignores channel notifications, so a write here reports success while the
    // message vanishes (the ADR-064 bug class, previously still live for Gemini).
    // readyState OPEN proves the guard fires BEFORE the send path — not via a
    // closed socket — and it is unconditional (no running-state gate).
    const id = "9e310000-0000-4000-8000-00000000000c";
    seedAgent(id, "GhostGemini", "gemini-cli", false);
    const writes: string[] = [];
    const ws = {
      readyState: 1, // OPEN
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage(
      "agent://GhostGemini",
      "are you there?",
      SENDER,
    );

    assert.ok(err, "must return an error, not null (null means success)");
    assert.match(err, /gemini-cli/); // names the runtime that can't receive
    assert.match(err, /no inbound delivery path/);
    assert.match(err, /not delivered/i);
    assert.equal(
      writes.length,
      0,
      "must NOT write into a socket whose reader discards inbound",
    );
    unregisterSessionClient(ws);
  });

  it("does NOT block a Gemini agent's OUTBOUND send() (guard keys on recipient, not sender)", async () => {
    // Gemini's own send() routes gemini→recipient; the guard checks the TARGET
    // provider, so a Gemini agent messaging a live Claude agent still delivers.
    const geminiId = "9e310000-0000-4000-8000-00000000000d";
    const claudeId = "c1ad0000-0000-4000-8000-00000000000e";
    seedAgent(geminiId, "SenderGemini", "gemini-cli", false);
    seedAgent(claudeId, "RecvClaude", "claude-code", false);
    const writes: string[] = [];
    const ws = {
      readyState: 1,
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(claudeId, ws);

    const err = await routeMessage(
      "agent://RecvClaude",
      "hi from gemini",
      geminiId,
    );

    assert.equal(err, null, `expected success, got: ${err}`);
    assert.equal(
      writes.length,
      1,
      "gemini's outbound must still reach the recipient",
    );
    assert.match(writes[0], /hi from gemini/);
    unregisterSessionClient(ws);
  });
});

describe("schedule://<name> sender scheme", () => {
  // Same isolation as the Codex describe above. This block originally had
  // NONE and its insertAgent escaped into the REAL ~/.autonomos during a
  // pre-#350 `make check` (the injected AUTONOMOS_CONFIG_DIR defeats naive
  // isolation) — the config-dir guard now throws on that; this is the fix.
  let isolatedDir = "";
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-sched-scheme-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
  });
  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("a reply to schedule://<name> gets actionable guidance, not 'unknown scheme'", async () => {
    const error = await routeMessage(
      "schedule://pr-watchdog",
      "done, pausing myself",
      "22222222-2222-2222-2222-222222222222",
    );
    assert.ok(error, "must not be accepted — schedules have no inbox");
    assert.match(error ?? "", /cannot receive replies/i);
    assert.match(
      error ?? "",
      /get_schedule\("pr-watchdog"\)/,
      "must name the schedule tools with the name pre-filled",
    );
    assert.doesNotMatch(error ?? "", /Unknown URI scheme/);
    assert.doesNotMatch(
      error ?? "",
      /list_agents/,
      "must not send the agent hunting for a peer that never existed",
    );
  });

  it("a schedule-fired prompt is stamped with the schedule identity, not agent://Scheduler", async () => {
    // The channel-server renders "[<userName> → you via <fromUri>]" from
    // exactly these two payload fields, so pinning them here pins the header
    // an agent sees in its terminal.
    const id = "c1ad0000-0000-4000-8000-00000000000f";
    const agent = buildAgent({
      id,
      name: "ScheduleTarget",
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: "ask",
    });
    insertAgent(agent);
    const writes: string[] = [];
    const ws = {
      readyState: 1,
      send: (data: string) => writes.push(data),
    } as unknown as WSContext;
    registerSessionClient(id, ws);

    const err = await routeMessage(
      "agent://ScheduleTarget",
      "nightly report please",
      "schedule:nightly-report",
    );

    assert.equal(err, null, `expected delivery, got: ${err}`);
    assert.equal(writes.length, 1);
    const payload = JSON.parse(writes[0]).payload as {
      userName: string;
      fromUri: string;
      text: string;
    };
    assert.equal(payload.userName, "Schedule nightly-report");
    assert.equal(payload.fromUri, "schedule://nightly-report");
    assert.equal(payload.text, "nightly report please");
    unregisterSessionClient(ws);
  });
});

describe("system-sender reply handling", () => {
  it("a reply to agent://Scheduler explains the system sender instead of the generic not-found", async () => {
    const error = await routeMessage(
      "agent://Scheduler",
      "ok",
      "11111111-1111-1111-1111-111111111111",
    );
    assert.ok(error, "must not be accepted — nothing exists to deliver to");
    assert.match(error ?? "", /not an agent/i);
    assert.match(error ?? "", /scheduler/i);
    assert.doesNotMatch(
      error ?? "",
      /list_agents/,
      "must not send the agent hunting for a peer that never existed",
    );
  });
});
