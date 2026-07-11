import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetCacheForTesting as _resetAgentsForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  clearAgentState,
  clearNotifications,
  getAgentState,
  hooksRouter,
} from "../routes/hooks.js";

// Helper: simulate a hook event POST
async function postHookEvent(
  sessionId: string,
  event: Record<string, unknown>,
) {
  return hooksRouter.request(`/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

describe("hooks — agent status derivation", () => {
  const sid = "test-session-001";

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
  });

  it("SessionStart → ready", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("UserPromptSubmit → working", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreToolUse → tool_running with tool name", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const state = getAgentState(sid);
    assert.equal(state.status, "tool_running");
    assert.equal(state.currentTool, "Bash");
    assert.equal(state.toolDetail, "npm test");
  });

  it("PostToolUse → working (clears tool)", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
  });

  it("Stop → idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("Notification (permission_prompt) → needs_input", async () => {
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("Notification (non-permission) → no status change", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PermissionRequest → needs_input", async () => {
    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("SubagentStart → orchestrating", async () => {
    await postHookEvent(sid, { hook_event_name: "SubagentStart" });
    assert.equal(getAgentState(sid).status, "orchestrating");
  });

  it("SubagentStop → working (exits orchestrating)", async () => {
    await postHookEvent(sid, { hook_event_name: "SubagentStart" });
    assert.equal(getAgentState(sid).status, "orchestrating");
    await postHookEvent(sid, { hook_event_name: "SubagentStop" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreCompact from an active state → compacting (saves baseline)", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    const state = getAgentState(sid);
    assert.equal(state.status, "compacting");
    assert.equal(state.preCompactStatus, "working");
  });

  it("PreCompact at rest (idle) → stays idle (no spinner, nothing to interrupt)", async () => {
    // A /compact issued while idle has no live turn — showing "compacting"
    // would strand the agent, since the resolve signals only no-op from here.
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("PostCompact from unknown baseline → ready (fallback)", async () => {
    // No prior state — PreCompact is blocked from "unknown" (no baseline), so
    // status stays unknown; a resolve signal falls back to "ready" so the UI
    // never spins forever.
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "unknown");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("PreCompact → PostCompact restores pre-compact working status", async () => {
    // Mid-turn /compact: agent was working, stays working after compaction.
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
    assert.equal(state.toolDetail, undefined);
    // Baseline must be cleared — a stale baseline would corrupt later cycles.
    assert.equal(state.preCompactStatus, undefined);
  });

  it("SessionStart source=compact → PostCompact → ready (resume auto-compact)", async () => {
    // After server restart, sessions auto-compact on resume with no captured
    // baseline. SessionStart(source=compact) is a resolve signal — from a cold
    // store it goes straight to "ready" (no "compacting" flash for something
    // the user didn't initiate), and the trailing PostCompact is a no-op.
    await postHookEvent(sid, {
      hook_event_name: "SessionStart",
      source: "compact",
    });
    assert.equal(getAgentState(sid).status, "ready");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("tool_running → PreCompact → PostCompact coerces to working (stale tool)", async () => {
    // The in-flight tool is gone after compaction — don't show stale tool.
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    assert.equal(getAgentState(sid).status, "tool_running");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
    assert.equal(state.toolDetail, undefined);
  });

  it("needs_input → PreCompact → PostCompact coerces to working (stale prompt)", async () => {
    // A permission prompt in flight before compaction is gone afterward —
    // restore to working so the UI doesn't show a phantom prompt badge.
    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("compacting → Stop → idle clears preCompactStatus (no leak across cycles)", async () => {
    // User cancels mid-compact. Baseline must not leak into the next cycle.
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "Stop" });
    const state = getAgentState(sid);
    assert.equal(state.status, "idle");
    assert.equal(state.preCompactStatus, undefined);
  });

  it("SessionEnd → stopped", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("PostToolUseFailure → working (agent continues after tool error)", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "failing-cmd" },
    });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, "Bash");
  });

  it("unknown event → status unchanged", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");
    await postHookEvent(sid, { hook_event_name: "SomeNewEvent" });
    assert.equal(getAgentState(sid).status, "idle"); // unchanged
  });

  it("unknown session → default state", () => {
    const state = getAgentState("nonexistent");
    assert.equal(state.status, "unknown");
    assert.equal(state.lastEvent, "");
  });
});

describe("hooks — sticky idle state", () => {
  const sid = "test-sticky-001";

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
  });

  it("PostToolUse after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    // Late PostToolUse (e.g., from recap or delayed event) should be ignored
    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("SubagentStop after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "SubagentStop" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("PostCompact after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("PostToolUseFailure after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
    });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("UserPromptSubmit CAN exit idle (new turn)", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreToolUse CAN exit idle (agent resumed work)", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
    });
    assert.equal(getAgentState(sid).status, "tool_running");
  });

  it("SessionEnd CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("PermissionRequest CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("Notification (permission_prompt) CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("stopped is also sticky — PostToolUse ignored", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");

    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("SessionStart CAN exit stopped (session resumed)", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");

    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
  });
});

// ── Compaction is ORDER-INDEPENDENT ──────────────────────────────────
// The bug (ADR-053): CC fires the compaction hooks — the summarizer's
// SubagentStop, SessionStart(source=compact) and PostCompact — within ~90ms
// as async fire-and-forget curls, so they can arrive in ANY order. The prior
// fix (#154) assumed a single order (SessionStart(compact) before PostCompact)
// and its tests encoded only that safe order, so ~2/6 real orderings stranded
// the agent at "compacting" forever. These tests replay ALL orderings and
// assert the agent always lands on the correct terminal status.
describe("hooks — compaction order-independence", () => {
  const RACERS = [
    "SubagentStop",
    "SessionStartCompact",
    "PostCompact",
  ] as const;
  const EVENTS: Record<string, Record<string, unknown>> = {
    SubagentStop: { hook_event_name: "SubagentStop" },
    SessionStartCompact: { hook_event_name: "SessionStart", source: "compact" },
    PostCompact: { hook_event_name: "PostCompact" },
  };

  function permutations<T>(arr: readonly T[]): T[][] {
    if (arr.length <= 1) return [[...arr]];
    const out: T[][] = [];
    arr.forEach((x, i) => {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) out.push([x, ...p]);
    });
    return out;
  }

  let counter = 0;
  async function runCompaction(
    seed: Array<Record<string, unknown>>,
    order: readonly string[],
  ): Promise<string> {
    const sid = `compact-order-${counter++}`;
    clearAgentState(sid);
    for (const e of seed) await postHookEvent(sid, e);
    // PreCompact always fires first (it's what triggers compaction); only the
    // trailing trio races.
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    for (const name of order) await postHookEvent(sid, EVENTS[name]);
    const status = getAgentState(sid).status;
    clearAgentState(sid);
    return status;
  }

  for (const order of permutations(RACERS)) {
    const label = order.join(" → ");

    it(`manual /compact from idle → idle  [${label}]`, async () => {
      const status = await runCompaction(
        [{ hook_event_name: "UserPromptSubmit" }, { hook_event_name: "Stop" }],
        order,
      );
      assert.equal(status, "idle");
    });

    it(`auto-compact mid-turn (working) → working  [${label}]`, async () => {
      const status = await runCompaction(
        [{ hook_event_name: "UserPromptSubmit" }],
        order,
      );
      assert.equal(status, "working");
    });
  }

  // Resume auto-compact: no PreCompact, cold in-memory store (unknown). Both
  // resolve orders must land on "ready" (Q1: no "compacting" flash on resume).
  for (const order of permutations(["SessionStartCompact", "PostCompact"])) {
    it(`resume auto-compact from unknown → ready  [${order.join(" → ")}]`, async () => {
      const sid = `compact-resume-${counter++}`;
      clearAgentState(sid);
      for (const name of order) await postHookEvent(sid, EVENTS[name]);
      assert.equal(getAgentState(sid).status, "ready");
      clearAgentState(sid);
    });
  }

  it("the summarizer's SubagentStop does not exit compacting prematurely", async () => {
    const sid = "compact-subagent-noise";
    clearAgentState(sid);
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
    // The compaction summarizer subagent stops mid-window — must be ignored.
    await postHookEvent(sid, { hook_event_name: "SubagentStop" });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "working");
    clearAgentState(sid);
  });

  it("a duplicate PreCompact must NOT poison the baseline with 'compacting'", async () => {
    // A relay can send a duplicate PreCompact, or a back-to-back compaction's
    // PreCompact can arrive before the first cycle resolved. Re-entering must
    // preserve the ORIGINAL baseline, not overwrite it with "compacting" (which
    // restoredStatus would then hand back verbatim → permanent strand).
    const sid = "compact-dup-precompact";
    clearAgentState(sid);
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "PreCompact" }); // duplicate
    assert.equal(getAgentState(sid).preCompactStatus, "working");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "working"); // NOT stuck compacting
    clearAgentState(sid);
  });

  it("/compact from 'ready' (at rest) does not strand even if compaction fails", async () => {
    // "ready" is an at-rest state (post session-start/resume) — like idle, a
    // /compact here has no live turn. PreCompact must no-op so a failed
    // compaction (no PostCompact) can't leave it spinning.
    const sid = "compact-from-ready";
    clearAgentState(sid);
    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    // Compaction aborts (e.g. "not enough messages") — no resolve signal fires.
    assert.equal(getAgentState(sid).status, "ready"); // stays ready, not compacting
    clearAgentState(sid);
  });

  it("PreCompact-last from an active state self-heals on the trailing turn", async () => {
    // If PreCompact is delivered AFTER both resolve signals (the resolves no-op
    // with no baseline), it enters compacting last — but only from an active
    // state, which always emits a trailing Stop/tool event to self-heal.
    const sid = "compact-precompact-last";
    clearAgentState(sid);
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" }); // working
    await postHookEvent(sid, { hook_event_name: "PostCompact" }); // no-op
    await postHookEvent(sid, {
      hook_event_name: "SessionStart",
      source: "compact",
    }); // no-op
    await postHookEvent(sid, { hook_event_name: "PreCompact" }); // enters compacting last
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "Stop" }); // turn ends → self-heal
    assert.equal(getAgentState(sid).status, "idle");
    clearAgentState(sid);
  });
});

describe("hooks — notifications", () => {
  const sid = "test-notif-001";

  afterEach(() => {
    clearNotifications(sid);
  });

  it("Stop event creates a notification", async () => {
    const res = await postHookEvent(sid, { hook_event_name: "Stop" });
    const body = await res.json();
    assert.equal(body.ok, true);
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread, 1);
  });

  it("Notification event creates a notification", async () => {
    // Ensure agent has state so bulk endpoint includes it
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    clearNotifications(sid);
    await postHookEvent(sid, { hook_event_name: "Notification" });
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread, 1);
  });

  it("PreToolUse does NOT create a notification", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread ?? 0, 0);
  });
});

// ── Provider-aware event translation (Gemini) ─────────────────────────
//
// Gemini emits native event names (BeforeTool, AfterAgent, etc.) that the
// gemini-cli provider's normalizeEvent maps to CC-shaped vocabulary before
// deriveStatus consumes them. Verifies the full round-trip via the hook route.

describe("hooks — Gemini event translation", () => {
  const sid = "test-gemini-001";

  beforeEach(() => {
    _resetAgentsForTesting();
    insertAgent(
      buildAgent({
        id: sid,
        name: "gemini-test",
        workingDirectory: "/tmp",
        provider: "gemini-cli",
        providerSessionId: sid,
        permissionMode: "bypass",
      }),
    );
  });

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
    _resetAgentsForTesting();
  });

  it("BeforeAgent → UserPromptSubmit → working", async () => {
    await postHookEvent(sid, { hook_event_name: "BeforeAgent" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("BeforeTool → PreToolUse → tool_running", async () => {
    await postHookEvent(sid, {
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "ls" },
    });
    const state = getAgentState(sid);
    assert.equal(state.status, "tool_running");
    assert.equal(state.currentTool, "run_shell_command");
  });

  it("AfterTool → PostToolUse → working (clears tool)", async () => {
    await postHookEvent(sid, {
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
    });
    await postHookEvent(sid, { hook_event_name: "AfterTool" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
  });

  it("AfterAgent → Stop → idle (end of turn)", async () => {
    await postHookEvent(sid, { hook_event_name: "BeforeAgent" });
    await postHookEvent(sid, { hook_event_name: "AfterAgent" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("Notification (ToolPermission) → needs_input", async () => {
    // Gemini uses "ToolPermission" — translator must map to "permission_prompt"
    // so CC's deriveStatus flips to needs_input.
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "ToolPermission",
    });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("SessionStart and SessionEnd are pass-through", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("PreCompress is dropped (no status change)", async () => {
    // Gemini fires PreCompress unconditionally on every turn as a
    // "should we compress?" check, not "compression is starting." Mapping
    // it to CC's PreCompact would flash the agent into "compacting" on
    // every message — see INTENTIONAL_DROPS in gemini-cli.ts.
    await postHookEvent(sid, { hook_event_name: "BeforeAgent" });
    assert.equal(getAgentState(sid).status, "working");
    const res = await postHookEvent(sid, {
      hook_event_name: "PreCompress",
      trigger: "auto",
    });
    const body = (await res.json()) as { event: string };
    assert.equal(body.event, "dropped");
    assert.equal(getAgentState(sid).status, "working");
  });

  it("unmapped Gemini events are dropped (no status change)", async () => {
    // Put the session in a known state first
    await postHookEvent(sid, { hook_event_name: "BeforeAgent" });
    assert.equal(getAgentState(sid).status, "working");

    // AfterModel fires per streaming chunk — translator returns null
    const res = await postHookEvent(sid, {
      hook_event_name: "AfterModel",
      llm_response: { candidates: [] },
    });
    const body = (await res.json()) as { event: string };
    assert.equal(body.event, "dropped");
    assert.equal(getAgentState(sid).status, "working");
  });

  it("CC sessions still use identity (no translator regression)", async () => {
    const ccSid = "test-cc-regression-001";
    // No session for ccSid → translation skipped (unknown session path),
    // raw event passes through. CC event names match deriveStatus directly.
    await postHookEvent(ccSid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(ccSid).status, "working");
    clearAgentState(ccSid);
  });

  it("malformed event (no hook_event_name) is dropped", async () => {
    // Translator returns null for malformed input; route returns dropped.
    await postHookEvent(sid, { tool_name: "Bash" /* missing event name */ });
    // Status untouched
    assert.equal(getAgentState(sid).status, "unknown");
  });

  it("unknown Gemini event (vocabulary drift) is dropped without crashing", async () => {
    // A future Gemini release could add a new event. Translator drops it
    // (with a warn log) rather than passing untranslated to deriveStatus.
    await postHookEvent(sid, { hook_event_name: "BeforeAgent" });
    assert.equal(getAgentState(sid).status, "working");
    const res = await postHookEvent(sid, {
      hook_event_name: "SomeBrandNewGeminiEvent",
    });
    const body = (await res.json()) as { event: string };
    assert.equal(body.event, "dropped");
    assert.equal(getAgentState(sid).status, "working");
  });
});
