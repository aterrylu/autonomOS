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

// ── formatHierarchy ───────────────────────────────────────────

describe("formatHierarchy", () => {
  it("renders standalone agent (no manager, no reports)", () => {
    const out = formatHierarchy({
      name: "Agent@autonomos",
      manager: null,
      directReports: 0,
    });
    assert.equal(out, "[Agent@autonomos · standalone]");
  });

  it("renders worker (manager only)", () => {
    const out = formatHierarchy({
      name: "Worker@autonomos",
      manager: "TeamLead",
      directReports: 0,
    });
    assert.equal(out, "[Worker@autonomos · ↑TeamLead]");
  });

  it("renders top-of-chart agent (reports only)", () => {
    const out = formatHierarchy({
      name: "Dispatcher@autonomos",
      manager: null,
      directReports: 3,
    });
    assert.equal(out, "[Dispatcher@autonomos · ↓3 reports]");
  });

  it("renders middle-of-chart agent (manager + reports)", () => {
    const out = formatHierarchy({
      name: "TeamLead@autonomos",
      manager: "Dispatcher",
      directReports: 2,
    });
    assert.equal(out, "[TeamLead@autonomos · ↑Dispatcher · ↓2 reports]");
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
    assert.equal(out, "[X · standalone]");
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
  it("renders 0ms as 0m00s", () => {
    assert.equal(formatDuration(0), "0m00s");
  });

  it("pads seconds < 10", () => {
    assert.equal(formatDuration(5_000), "0m05s");
  });

  it("renders minutes correctly", () => {
    assert.equal(formatDuration(125_000), "2m05s");
  });

  it("handles null/undefined input", () => {
    assert.equal(formatDuration(null), "0m00s");
    assert.equal(formatDuration(undefined), "0m00s");
  });

  it("renders large durations without crashing", () => {
    // 99 minutes — exceeds typical session length but should not break
    assert.equal(formatDuration(99 * 60_000), "99m00s");
  });
});

// ── formatActivity ────────────────────────────────────────────

describe("formatActivity", () => {
  it("renders all fields when present", () => {
    const out = formatActivity({
      model: { display_name: "Opus" },
      context_window: { used_percentage: 45 },
      cost: { total_cost_usd: 0.18, total_duration_ms: 125_000 },
      workspace: { git_worktree: "terry/feat-x" },
    });
    assert.match(out, /^⚡Opus/);
    assert.match(out, /45%/);
    assert.match(out, /\$0\.18/);
    assert.match(out, /2m05s/);
    assert.match(out, /🌿 terry\/feat-x/);
  });

  it("uses defaults for empty stdin", () => {
    const out = formatActivity({});
    assert.match(out, /⚡\?/);
    assert.match(out, /0%/);
    assert.match(out, /\$0\.00/);
    assert.match(out, /0m00s/);
    assert.ok(!out.includes("🌿"), "no branch when workspace absent");
  });

  it("drops branch segment when git_worktree absent", () => {
    const out = formatActivity({
      model: { display_name: "Opus" },
      context_window: { used_percentage: 10 },
    });
    assert.ok(!out.includes("🌿"), `unexpected branch segment: ${out}`);
  });

  it("falls back to worktree.branch when git_worktree missing", () => {
    const out = formatActivity({
      worktree: { branch: "feature/x" },
    });
    assert.match(out, /🌿 feature\/x/);
  });

  it("survives null nested fields", () => {
    const out = formatActivity({
      model: null,
      context_window: null,
      cost: null,
      workspace: null,
    });
    // Should not throw, should produce a sensible string
    assert.match(out, /⚡\?/);
    assert.match(out, /0%/);
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

  it("returns null when /api/sessions errors out", async () => {
    mockFetchError();
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("returns null when /api/sessions returns non-array", async () => {
    mockFetch({ error: "boom" });
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("returns null when session not found in list", async () => {
    mockFetch([
      { claudeSessionId: "other-session", name: "Other", manager: null },
    ]);
    const meta = await getAutonomosMeta("session-123", "http://localhost:3101");
    assert.equal(meta, null);
  });

  it("resolves manager and counts direct reports for a manager", async () => {
    mockFetch([
      {
        claudeSessionId: "lead-id",
        name: "TeamLead@x",
        manager: "Dispatcher",
        status: "running",
      },
      {
        claudeSessionId: "w1",
        name: "Worker-1",
        manager: "TeamLead@x",
        status: "running",
      },
      {
        claudeSessionId: "w2",
        name: "Worker-2",
        manager: "TeamLead@x",
        status: "running",
      },
    ]);
    const meta = await getAutonomosMeta("lead-id", "http://localhost:3101");
    assert.deepEqual(meta, {
      name: "TeamLead@x",
      manager: "Dispatcher",
      directReports: 2,
    });
  });

  it("excludes exited sessions from direct-report count", async () => {
    mockFetch([
      {
        claudeSessionId: "lead-id",
        name: "Lead",
        manager: null,
        status: "running",
      },
      {
        claudeSessionId: "w1",
        name: "Worker-1",
        manager: "Lead",
        status: "running",
      },
      {
        claudeSessionId: "w2",
        name: "Worker-2",
        manager: "Lead",
        status: "exited",
      },
    ]);
    const meta = await getAutonomosMeta("lead-id", "http://localhost:3101");
    assert.equal(meta?.directReports, 1);
  });

  it("falls back to 'Agent' when name missing on persisted record", async () => {
    mockFetch([{ claudeSessionId: "x", manager: null }]);
    const meta = await getAutonomosMeta("x", "http://localhost:3101");
    assert.equal(meta?.name, "Agent");
  });

  it("returns null manager (not undefined) when session has no manager", async () => {
    mockFetch([{ claudeSessionId: "x", name: "Lone" }]);
    const meta = await getAutonomosMeta("x", "http://localhost:3101");
    assert.equal(meta?.manager, null);
  });
});
