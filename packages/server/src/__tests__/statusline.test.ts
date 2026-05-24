/**
 * Unit tests for the statusline renderer (providers/statusline.mjs).
 *
 * The renderer ships as a plain .mjs that runs as a CC child process.
 * These tests exercise the pure-function building blocks (formatHierarchy,
 * formatActivity, buildBar, formatDuration) and the meta resolver against
 * a stubbed fetch. The CLI entry point itself is not exercised here —
 * the script's main() is integration-tested via /qa visual verification.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildBar,
  formatActivity,
  formatDuration,
  formatHierarchy,
  getAutonomosMeta,
} from "../providers/statusline.mjs";

// Strip ANSI escape codes so content assertions stay readable. Colors
// are verified separately in the "colorization" describe block.
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

// ── formatHierarchy ───────────────────────────────────────────

describe("formatHierarchy", () => {
  it("renders standalone agent (no manager, no reports)", () => {
    const out = formatHierarchy({
      name: "Agent@autonomos",
      manager: null,
      directReports: 0,
    });
    assert.equal(plain(out), "[Agent@autonomos · standalone]");
  });

  it("renders worker (manager only)", () => {
    const out = formatHierarchy({
      name: "Worker@autonomos",
      manager: "TeamLead",
      directReports: 0,
    });
    assert.equal(plain(out), "[Worker@autonomos · ↑TeamLead]");
  });

  it("renders top-of-chart agent (reports only)", () => {
    const out = formatHierarchy({
      name: "Dispatcher@autonomos",
      manager: null,
      directReports: 3,
    });
    assert.equal(plain(out), "[Dispatcher@autonomos · ↓3 reports]");
  });

  it("renders middle-of-chart agent (manager + reports)", () => {
    const out = formatHierarchy({
      name: "TeamLead@autonomos",
      manager: "Dispatcher",
      directReports: 2,
    });
    assert.equal(plain(out), "[TeamLead@autonomos · ↑Dispatcher · ↓2 reports]");
  });

  it("treats directReports = 0 as no reports segment", () => {
    const out = formatHierarchy({
      name: "X",
      manager: "Y",
      directReports: 0,
    });
    assert.ok(!out.includes("reports"), `unexpected reports segment: ${out}`);
  });

  it("treats negative directReports as no reports segment", () => {
    const out = formatHierarchy({
      name: "X",
      manager: null,
      directReports: -1,
    });
    // Negative is non-positive, no segment; standalone tag fires
    assert.equal(plain(out), "[X · standalone]");
  });
});

// ── buildBar ──────────────────────────────────────────────────

describe("buildBar", () => {
  it("renders empty bar at 0%", () => {
    assert.equal(buildBar(0), "░".repeat(10));
  });

  it("renders full bar at 100%", () => {
    assert.equal(buildBar(100), "▓".repeat(10));
  });

  it("renders half bar at 50%", () => {
    assert.equal(buildBar(50), "▓".repeat(5) + "░".repeat(5));
  });

  it("clamps values above 100", () => {
    assert.equal(buildBar(150), "▓".repeat(10));
  });

  it("clamps negative values to 0", () => {
    assert.equal(buildBar(-25), "░".repeat(10));
  });

  it("handles null/undefined input", () => {
    assert.equal(buildBar(null), "░".repeat(10));
    assert.equal(buildBar(undefined), "░".repeat(10));
  });

  it("respects custom width", () => {
    assert.equal(buildBar(50, 4), "▓▓░░");
  });
});

// ── formatDuration ────────────────────────────────────────────

describe("formatDuration", () => {
  // Seconds band (< 1 minute)
  it("renders 0ms as 0s", () => {
    assert.equal(formatDuration(0), "0s");
  });

  it("renders sub-minute durations in seconds only", () => {
    assert.equal(formatDuration(45_000), "45s");
  });

  // Minute boundary
  it("rolls over to minutes at exactly 60s", () => {
    assert.equal(formatDuration(60_000), "1m 0s");
  });

  // Minutes band (1 minute to < 1 hour)
  it("renders minutes + seconds without zero-padding", () => {
    assert.equal(formatDuration(125_000), "2m 5s");
  });

  it("renders large minute values correctly (was '705m05s' bug)", () => {
    // 11h 45m 5s — the bug previously rendered this as "705m05s"
    assert.equal(
      formatDuration(11 * 3_600_000 + 45 * 60_000 + 5_000),
      "11h 45m",
    );
  });

  // Hour boundary
  it("rolls over to hours at exactly 60m", () => {
    assert.equal(formatDuration(3_600_000), "1h 0m");
  });

  // Hours band (1 hour to < 24 hours)
  it("renders hours + minutes", () => {
    assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), "2h 15m");
  });

  // Day boundary
  it("rolls over to days at exactly 24h", () => {
    assert.equal(formatDuration(24 * 3_600_000), "1d 0h");
  });

  // Days band (>= 24 hours)
  it("renders days + hours", () => {
    assert.equal(formatDuration(3 * 86_400_000 + 2 * 3_600_000), "3d 2h");
  });

  it("handles null/undefined input", () => {
    assert.equal(formatDuration(null), "0s");
    assert.equal(formatDuration(undefined), "0s");
  });
});

// ── formatActivity ────────────────────────────────────────────

describe("formatActivity", () => {
  it("renders all fields when present", () => {
    const out = plain(
      formatActivity(
        {
          model: { display_name: "Opus" },
          context_window: { used_percentage: 45 },
          cost: { total_cost_usd: 0.18, total_duration_ms: 125_000 },
          workspace: { git_worktree: "terry/feat-x" },
        },
        {
          name: "Worker@x",
          manager: null,
          project: "x",
          directReports: 0,
        },
      ),
    );
    // Order: project → branch → cost → model → ctx → duration
    assert.match(out, /^x/, "project leads the line");
    assert.match(out, /🌿 terry\/feat-x/);
    assert.match(out, /\$0\.18/);
    assert.match(out, /⚡Opus/);
    assert.match(out, /45%/);
    assert.match(out, /⏱ 2m 5s/);
  });

  it("uses defaults for empty stdin", () => {
    const out = plain(formatActivity({}));
    assert.match(out, /⚡\?/);
    assert.match(out, /0%/);
    assert.match(out, /\$0\.00/);
    assert.match(out, /⏱ 0s/);
    assert.ok(!out.includes("🌿"), "no branch when workspace absent");
  });

  it("drops project segment when meta has no project", () => {
    const out = plain(
      formatActivity(
        { model: { display_name: "Opus" } },
        { name: "X", manager: null, project: null, directReports: 0 },
      ),
    );
    // Should start with cost or branch, not the project name
    assert.match(out, /^\$/);
  });

  it("drops branch segment when git_worktree absent", () => {
    const out = plain(
      formatActivity({
        model: { display_name: "Opus" },
        context_window: { used_percentage: 10 },
      }),
    );
    assert.ok(!out.includes("🌿"), `unexpected branch segment: ${out}`);
  });

  it("falls back to worktree.branch when git_worktree missing", () => {
    const out = plain(formatActivity({ worktree: { branch: "feature/x" } }));
    assert.match(out, /🌿 feature\/x/);
  });

  it("survives null nested fields", () => {
    const out = plain(
      formatActivity({
        model: null,
        context_window: null,
        cost: null,
        workspace: null,
      }),
    );
    assert.match(out, /⚡\?/);
    assert.match(out, /0%/);
  });
});

// ── colorization (verifies ANSI escapes are present) ──────────

describe("colorization", () => {
  it("agent name gets bright cyan + project gets blue", () => {
    const out = formatHierarchy({
      name: "Worker@autonomos",
      manager: null,
      directReports: 0,
    });
    assert.match(out, /\x1b\[1;36mWorker/, "agent role in bright cyan");
    assert.match(
      out,
      /\x1b\[38;2;103;164;250m@autonomos/,
      "project segment in true-color blue",
    );
  });

  it("name without @ uses agent color only (no project color)", () => {
    const out = formatHierarchy({
      name: "Dispatcher",
      manager: null,
      directReports: 0,
    });
    assert.match(out, /\x1b\[1;36mDispatcher/);
    assert.ok(
      !out.includes("\x1b[38;2;103;164;250m"),
      "no project color when no @ in name",
    );
  });

  it("context bar is green when usage < 70%", () => {
    const out = formatActivity({ context_window: { used_percentage: 45 } });
    assert.match(out, /\x1b\[32m▓+░+ 45%/);
  });

  it("context bar is yellow when usage 70-89%", () => {
    const out = formatActivity({ context_window: { used_percentage: 75 } });
    assert.match(out, /\x1b\[33m▓+░+ 75%/);
  });

  it("context bar is red when usage >= 90%", () => {
    const out = formatActivity({ context_window: { used_percentage: 92 } });
    assert.match(out, /\x1b\[31m▓+░+ 92%/);
  });

  it("branch segment is green", () => {
    const out = formatActivity({ workspace: { git_worktree: "feature/x" } });
    assert.match(out, /\x1b\[32m🌿 feature\/x/);
  });

  it("cost segment is yellow", () => {
    const out = formatActivity({ cost: { total_cost_usd: 1.23 } });
    assert.match(out, /\x1b\[33m\$1\.23/);
  });
});

// ── getAutonomosMeta ──────────────────────────────────────────

describe("getAutonomosMeta", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function mockFetch(payload: unknown, ok = true) {
    globalThis.fetch = (async () => ({
      ok,
      json: async () => payload,
    })) as unknown as typeof fetch;
  }

  function mockFetchError() {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
  }

  it("returns null when /api/agents errors out", async () => {
    mockFetchError();
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("returns null when /api/agents returns non-array", async () => {
    mockFetch({ error: "boom" });
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("returns null when agent not found in list", async () => {
    mockFetch([{ id: "other-id", name: "Other", managerId: null }]);
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("resolves manager name from managerId and counts direct reports", async () => {
    mockFetch([
      {
        id: "dispatcher-id",
        name: "Dispatcher",
        managerId: null,
        status: "running",
      },
      {
        id: "lead-id",
        name: "TeamLead@x",
        managerId: "dispatcher-id",
        status: "running",
      },
      {
        id: "w1",
        name: "Worker-1",
        managerId: "lead-id",
        status: "running",
      },
      {
        id: "w2",
        name: "Worker-2",
        managerId: "lead-id",
        status: "running",
      },
    ]);
    const meta = await getAutonomosMeta("lead-id", "http://localhost:3101");
    assert.deepEqual(meta, {
      name: "TeamLead@x",
      manager: "Dispatcher",
      project: null,
      directReports: 2,
    });
  });

  it("excludes exited agents from direct-report count", async () => {
    mockFetch([
      { id: "lead-id", name: "Lead", managerId: null, status: "running" },
      { id: "w1", name: "Worker-1", managerId: "lead-id", status: "running" },
      { id: "w2", name: "Worker-2", managerId: "lead-id", status: "exited" },
    ]);
    const meta = await getAutonomosMeta("lead-id", "http://localhost:3101");
    assert.equal(meta?.directReports, 1);
  });

  it("falls back to 'Agent' when name missing on persisted record", async () => {
    mockFetch([{ id: "x", managerId: null }]);
    const meta = await getAutonomosMeta("x", "http://localhost:3101");
    assert.equal(meta?.name, "Agent");
  });

  it("returns null manager (not undefined) when agent has no managerId", async () => {
    mockFetch([{ id: "x", name: "Lone" }]);
    const meta = await getAutonomosMeta("x", "http://localhost:3101");
    assert.equal(meta?.manager, null);
  });

  it("returns null manager when managerId references a deleted agent", async () => {
    mockFetch([{ id: "x", name: "Orphan", managerId: "ghost-id" }]);
    const meta = await getAutonomosMeta("x", "http://localhost:3101");
    assert.equal(meta?.manager, null);
  });

  it("strips ANSI/control characters from name and manager (security)", async () => {
    mockFetch([
      {
        id: "evil-id",
        name: "Evil\x1b[2J@x",
        managerId: "boss-id",
        status: "running",
      },
      {
        id: "boss-id",
        name: "Boss\nname\x1b[31m",
        managerId: null,
        status: "running",
      },
    ]);
    const meta = await getAutonomosMeta("evil-id", "http://localhost:3101");
    assert.equal(meta?.name, "Evil@x", "ANSI stripped from name");
    assert.equal(
      meta?.manager,
      "Bossname",
      "control chars stripped from manager",
    );
  });

  it("sends Authorization: Bearer header when token provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (
      _url: string,
      init: { headers?: Record<string, string> } = {},
    ) => {
      capturedHeaders = init.headers;
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    await getAutonomosMeta("x", "http://localhost:3101", "secret-token-9758");

    assert.equal(capturedHeaders?.Authorization, "Bearer secret-token-9758");
  });

  it("omits Authorization header when token absent", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (
      _url: string,
      init: { headers?: Record<string, string> } = {},
    ) => {
      capturedHeaders = init.headers;
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    await getAutonomosMeta("x", "http://localhost:3101");

    assert.equal(capturedHeaders?.Authorization, undefined);
  });
});
