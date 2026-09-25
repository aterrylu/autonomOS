import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(
  join(tmpdir(), "aos-ordered-hooks-"),
);

import type { ResolvedSpawnOptions } from "@autonomos/core";
import { mintAgentToken } from "../agentCredentials.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import {
  clearAgentState,
  clearNotifications,
  getAgentState,
  hooksIngestRouter,
} from "../routes/hooks.js";

/**
 * Turn-boundary hooks must arrive in order.
 *
 * Each Claude Code hook is its own `curl`. Async hooks are fire-and-forget, so
 * the server can receive them in any order, and status derivation is
 * last-writer-wins by ARRIVAL: a UserPromptSubmit that lands after its turn's
 * Stop leaves an idle agent showing "working" (the agent-spawn-prompt failure
 * under concurrent boots). The fix is at the source: SessionStart,
 * UserPromptSubmit and Stop are registered as synchronous hooks, which Claude
 * Code runs to completion before moving on, so they can't overtake each other.
 */

function baseOptions(): ResolvedSpawnOptions {
  return {
    workingDirectory: "/work",
    cwd: "/work",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "Agent",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "53917",
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:53917",
  };
}

type HookEntry = { hooks: Array<{ async: boolean; timeout: number }> };

function hookSettings(): Record<string, HookEntry[]> {
  const args = claudeCodeProvider.buildArgs(baseOptions());
  const i = args.indexOf("--settings");
  assert.ok(i >= 0, "precondition: buildArgs passes an inline --settings");
  return JSON.parse(args[i + 1]).hooks;
}

describe("claude-code hook registration", () => {
  const ORDERED = ["SessionStart", "UserPromptSubmit", "Stop"];

  it("SessionStart, UserPromptSubmit and Stop run synchronously", () => {
    const hooks = hookSettings();
    for (const ev of ORDERED) {
      assert.equal(
        hooks[ev]?.[0]?.hooks[0]?.async,
        false,
        `${ev} must be a synchronous hook so it can't arrive after a later turn event`,
      );
    }
  });

  it("every other event stays async (tool calls pay no hook latency)", () => {
    const hooks = hookSettings();
    const others = Object.keys(hooks).filter((e) => !ORDERED.includes(e));
    assert.ok(
      others.includes("PreToolUse") && others.includes("PostToolUse"),
      "precondition: tool events are registered",
    );
    for (const ev of others) {
      assert.equal(hooks[ev][0].hooks[0].async, true, `${ev} must stay async`);
    }
  });

  it("every hook keeps the 3s timeout that bounds a stuck server", () => {
    for (const [ev, entries] of Object.entries(hookSettings())) {
      assert.equal(entries[0].hooks[0].timeout, 3, `${ev} timeout`);
    }
  });
});

describe("hook ingest is last-writer-wins by arrival (why the source must order)", () => {
  const sid = "ordered-hooks-session";

  async function post(event: string) {
    const res = await hooksIngestRouter.request(`/${sid}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": mintAgentToken(sid),
      },
      body: JSON.stringify({ hook_event_name: event }),
    });
    assert.equal(res.status, 200, `precondition: ${event} was accepted`);
  }

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
  });

  it("in order, a turn ends idle on Stop", async () => {
    await post("SessionStart");
    await post("UserPromptSubmit");
    await post("Stop");
    assert.equal(getAgentState(sid).status, "idle");
    assert.equal(getAgentState(sid).lastEvent, "Stop");
  });

  it("a UserPromptSubmit arriving after its Stop leaves the agent 'working' (documented behavior)", async () => {
    // The failure mode async turn hooks produced. Ingest has no emit order to
    // go by (the hook payload carries none), so it can't repair this; the
    // synchronous registration above is what keeps it from happening.
    await post("SessionStart");
    await post("Stop");
    await post("UserPromptSubmit");
    assert.equal(getAgentState(sid).status, "working");
    assert.equal(getAgentState(sid).lastEvent, "UserPromptSubmit");
  });
});
