/**
 * The permission mode Claude Code is ACTUALLY in, from its own hooks.
 *
 * The record says what an agent was set to; Claude Code can run something
 * else (a live Shift+Tab, or its own default/settings when spawned without a
 * flag). Its hook payloads carry `permission_mode` (measured on 2.1.293:
 * UserPromptSubmit, PreToolUse, Stop… but NOT SessionStart), so ingest keeps
 * the last one as `livePermission`, in the table's own values (`default` →
 * `manual`), and pushes it like any other activity change. The dashboard's
 * inspector shows it next to the set value.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta, UUID } from "@autonomos/core";

// UNCONDITIONAL: this suite writes real agent records (insertAgent).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(
  join(tmpdir(), "aos-live-perm-"),
);

const { mintAgentToken } = await import("../agentCredentials.js");
const { buildAgent, insertAgent } = await import("../agents/store.js");
const { onAgentDelta } = await import("../events/agents.js");
const {
  clearAgentState,
  clearNotifications,
  getAgentState,
  getAgentStatusSnapshot,
  hooksIngestRouter,
} = await import("../routes/hooks.js");

const CLAUDE = "aaaaaaaa-1111-4111-8111-000000000001" as UUID;
const CODEX = "aaaaaaaa-1111-4111-8111-000000000002" as UUID;
insertAgent(
  buildAgent({
    id: CLAUDE,
    name: "claude-live",
    workingDirectory: "/w",
    provider: "claude-code",
    status: "running",
  } as never),
);
insertAgent(
  buildAgent({
    id: CODEX,
    name: "codex-live",
    workingDirectory: "/w",
    provider: "codex",
    status: "running",
  } as never),
);

const hook = (sid: string, event: Record<string, unknown>) =>
  hooksIngestRouter.request(`/${sid}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Token": mintAgentToken(sid),
    },
    body: JSON.stringify(event),
  });

describe("Claude Code's live permission mode, from its hooks", () => {
  let seen: AgentDelta[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    seen = [];
    off = onAgentDelta((d) => {
      if (d.type === "agent.status") seen.push(d);
    });
  });
  afterEach(() => {
    off();
    for (const id of [CLAUDE, CODEX]) {
      clearAgentState(id);
      clearNotifications(id);
    }
  });

  it("a prompt's permission_mode becomes livePermission, in the table's values (default → manual)", async () => {
    await hook(CLAUDE, { hook_event_name: "SessionStart", source: "startup" });
    assert.equal(
      getAgentState(CLAUDE).livePermission,
      undefined,
      "SessionStart carries no mode: unknown until the first prompt",
    );
    await hook(CLAUDE, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "default",
    });
    assert.equal(getAgentState(CLAUDE).livePermission, "manual");
  });

  it("a live Shift+Tab change (seen at the next event) updates it and is PUSHED", async () => {
    await hook(CLAUDE, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "acceptEdits",
    });
    seen = [];
    await hook(CLAUDE, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      permission_mode: "plan",
    });
    assert.equal(getAgentState(CLAUDE).livePermission, "plan");
    assert.ok(
      seen.some(
        (d) =>
          d.type === "agent.status" &&
          d.id === CLAUDE &&
          d.state.livePermission === "plan",
      ),
      "the dashboard hears about it without a poll",
    );
  });

  it("an event WITHOUT the field keeps the last known mode", async () => {
    await hook(CLAUDE, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "auto",
    });
    await hook(CLAUDE, { hook_event_name: "Notification", message: "x" });
    assert.equal(getAgentState(CLAUDE).livePermission, "auto");
  });

  it("a NEW process (SessionStart) forgets it; a compaction's SessionStart doesn't", async () => {
    await hook(CLAUDE, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "auto",
    });
    await hook(CLAUDE, { hook_event_name: "SessionStart", source: "compact" });
    assert.equal(getAgentState(CLAUDE).livePermission, "auto");
    await hook(CLAUDE, { hook_event_name: "SessionStart", source: "resume" });
    assert.equal(getAgentState(CLAUDE).livePermission, undefined);
  });

  it("the reconcile snapshot (what a page reload reads) carries it", async () => {
    await hook(CLAUDE, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "bypassPermissions",
    });
    assert.equal(
      getAgentStatusSnapshot()[CLAUDE]?.state.livePermission,
      "bypassPermissions",
    );
  });

  it("only Claude Code agents: another runtime's stray field is ignored", async () => {
    await hook(CODEX, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "auto",
    });
    assert.equal(getAgentState(CODEX).livePermission, undefined);
  });

  it("an unknown session never gets one (no record to say it's Claude Code)", async () => {
    const stray = "bbbbbbbb-2222-4222-8222-000000000009";
    await hook(stray, {
      hook_event_name: "UserPromptSubmit",
      permission_mode: "auto",
    });
    assert.equal(getAgentState(stray).livePermission, undefined);
    clearAgentState(stray);
  });
});
