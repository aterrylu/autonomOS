import assert from "node:assert/strict";
// Config-dir isolation: transitively resolves the config dir; the configDir
// test-escape guard refuses the production dir from a test process.
import { mkdtempSync as __mkdtemp, mkdtempSync, rmSync } from "node:fs";
import { tmpdir as __tmpdir, tmpdir } from "node:os";
import { join as __join, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetAnalyticsForTesting,
  forgetAgentAnalytics,
  getAgentAnalytics,
  observeStatus,
  observeTool,
  supportFor,
} from "../agents/analytics.js";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
  markExited,
  markRunning,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { setAgentStatus } from "../routes/hooks.js";

process.env.AUTONOMOS_CONFIG_DIR = __mkdtemp(__join(__tmpdir(), "aos-iso-"));

const T0 = 1_000_000_000_000;
const MIN = 60_000;

describe("agent analytics — counted from status transitions", () => {
  beforeEach(() => _resetAnalyticsForTesting());

  it("time in state, turns (working → idle), and waits on a human", async () => {
    observeStatus("a", "ready", T0);
    observeStatus("a", "working", T0 + 1 * MIN);
    observeStatus("a", "tool_running", T0 + 2 * MIN);
    observeStatus("a", "needs_input", T0 + 3 * MIN);
    observeStatus("a", "working", T0 + 8 * MIN); // waited 5 min
    observeStatus("a", "idle", T0 + 9 * MIN); // turn 1
    observeStatus("a", "working", T0 + 10 * MIN);
    observeStatus("a", "idle", T0 + 11 * MIN); // turn 2
    const r = await getAgentAnalytics("a", {}, T0 + 12 * MIN);
    assert.deepEqual(r.status, { current: "idle", since: T0 + 11 * MIN });
    assert.equal(r.turns, 2);
    assert.equal(r.waits.count, 1);
    assert.equal(r.waits.totalMs, 5 * MIN);
    assert.equal(r.waits.waitingSince, null);
  });

  it("an OPEN wait keeps growing (the panel shows it live)", async () => {
    observeStatus("a", "working", T0);
    observeStatus("a", "needs_input", T0 + MIN);
    const r = await getAgentAnalytics("a", {}, T0 + 4 * MIN);
    assert.equal(r.waits.waitingSince, T0 + MIN);
    assert.equal(r.waits.totalMs, 3 * MIN);
  });

  it("a repeated status is not a transition (unread-only deltas cost nothing)", async () => {
    observeStatus("a", "working", T0);
    observeStatus("a", "working", T0 + MIN);
    const r = await getAgentAnalytics("a", {}, T0 + 2 * MIN);
    assert.equal(r.status?.since, T0);
    assert.equal(r.activity.length, 1);
  });

  it("the activity strip is contiguous segments over the last 24h, CLIPPED at the cutoff", async () => {
    const day = 24 * 60 * MIN;
    observeStatus("a", "ready", T0 - 3 * day); // entirely older than 24h
    observeStatus("a", "working", T0); // still running into the window
    observeStatus("a", "idle", T0 + day + 30 * MIN);
    observeStatus("a", "working", T0 + day + 40 * MIN);
    const now = T0 + day + 50 * MIN;
    const cutoff = now - day;
    const r = await getAgentAnalytics("a", {}, now);
    // The long "working" run overlaps the window, so it appears clipped to
    // start at the cutoff; the 3-day-old "ready" run doesn't appear at all.
    assert.deepEqual(
      r.activity.map((s) => s.status),
      ["working", "idle", "working"],
    );
    assert.equal(r.activity[0].from, cutoff);
    assert.equal(r.activity.at(-1)?.to, now);
    for (let i = 1; i < r.activity.length; i++) {
      assert.equal(r.activity[i].from, r.activity[i - 1].to, "contiguous");
    }
  });
});

describe("agent analytics — strip merging", () => {
  beforeEach(() => _resetAnalyticsForTesting());
  it("a zero-length blip doesn't leave two adjacent same-status segments", async () => {
    observeStatus("a", "tool_running", T0);
    observeStatus("a", "working", T0 + MIN); // zero-length: next change is instant
    observeStatus("a", "tool_running", T0 + MIN);
    observeStatus("a", "idle", T0 + 3 * MIN);
    const r = await getAgentAnalytics("a", {}, T0 + 4 * MIN);
    assert.deepEqual(
      r.activity.map((s) => s.status),
      ["tool_running", "idle"],
    );
    assert.equal(r.activity[0].to, T0 + 3 * MIN);
  });
});

describe("agent analytics — tools", () => {
  beforeEach(() => _resetAnalyticsForTesting());

  it("counts calls by name (top 5, busiest first), failures and the last tool", async () => {
    const calls = { Bash: 9, Edit: 6, Read: 5, Grep: 3, Write: 2, Glob: 1 };
    let t = T0;
    for (const [name, n] of Object.entries(calls)) {
      for (let i = 0; i < n; i++) {
        t += 1000;
        observeTool("a", "call", name, t);
      }
    }
    observeTool("a", "failure", "Bash");
    observeTool("a", "failure", "Bash");
    const r = await getAgentAnalytics("a", {});
    assert.equal(r.toolCalls, 26);
    assert.deepEqual(
      r.tools.map((x) => [x.name, x.count]),
      [
        ["Bash", 9],
        ["Edit", 6],
        ["Read", 5],
        ["Grep", 3],
        ["Write", 2],
      ],
    );
    assert.equal(r.failedTools, 2);
    assert.deepEqual(r.lastTool, { name: "Glob", at: t });
  });

  it("caps distinct tool names so a runaway set can't grow memory", async () => {
    for (let i = 0; i < 500; i++) observeTool("a", "call", `mcp__x__tool${i}`);
    const r = await getAgentAnalytics("a", {});
    assert.equal(r.toolCalls, 500); // every call still counts
    assert.equal(r.tools.length, 5);
  });
});

describe("agent analytics — honesty per runtime", () => {
  it("Codex reports no tools and no needs-input; Gemini no tool failures", () => {
    assert.deepEqual(supportFor("codex"), {
      tools: false,
      needsInput: false,
      failedTools: false,
    });
    assert.deepEqual(supportFor("gemini-cli"), {
      tools: true,
      needsInput: true,
      failedTools: false,
    });
    assert.deepEqual(supportFor("claude-code"), {
      tools: true,
      needsInput: true,
      failedTools: true,
    });
  });

  it("an agent with no data yet reads as zeros with no status (not a crash)", async () => {
    _resetAnalyticsForTesting();
    const r = await getAgentAnalytics("nobody", { provider: "codex" });
    assert.equal(r.status, null);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.activity, []);
    assert.equal(r.support.tools, false);
  });

  it("forget drops everything", async () => {
    observeStatus("gone", "working");
    forgetAgentAnalytics("gone");
    assert.equal((await getAgentAnalytics("gone", {})).status, null);
  });
});

describe("agent analytics — wired into the real taps", () => {
  let dir: string;
  const ID = "a11a0000-0000-4000-8000-000000000001";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autonomos-analytics-"));
    _setConfigDirForTesting(dir);
    _resetCacheForTesting();
    _resetAnalyticsForTesting();
    insertAgent(
      buildAgent({
        id: ID as never,
        name: "Tapped",
        workingDirectory: dir,
        provider: "codex",
        providerSessionId: ID,
        permissionMode: "ask",
      }),
    );
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the Codex daemon's status feed (setAgentStatus) counts turns via the status chokepoint", async () => {
    setAgentStatus(ID, "working");
    setAgentStatus(ID, "idle");
    setAgentStatus(ID, "working");
    setAgentStatus(ID, "idle");
    const r = await getAgentAnalytics(ID, { provider: "codex" });
    assert.equal(r.turns, 2);
    assert.equal(r.status?.current, "idle");
  });

  it("markRunning counts starts (restarts = starts − 1); markExited counts only crashes", async () => {
    markRunning(ID as never, {});
    markExited(ID as never, "user_killed");
    markRunning(ID as never, {});
    markExited(ID as never, "crashed");
    markRunning(ID as never, {});
    const r = await getAgentAnalytics(ID, {});
    assert.equal(r.restarts, 2);
    assert.equal(r.crashes, 1);
  });

  it("reads the git branch of the agent's directory (and null outside a repo)", async () => {
    const r = await getAgentAnalytics(ID, { workingDirectory: dir });
    assert.equal(r.branch, null); // a bare temp dir is not a repo
  });
});
