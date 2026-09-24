import { describe, expect, it } from "vitest";
import type { ReleaseNote } from "../../api/system";
import {
  activeStepIndex,
  breakingReleases,
  compareVersions,
  consequenceFor,
  joinNames,
  sortNewestFirst,
  stepsFor,
} from "./updateFlow";

const rel = (version: string, body = ""): ReleaseNote => ({
  version,
  name: `v${version}`,
  body,
  url: `https://example.com/${version}`,
  publishedAt: "2026-09-19T00:00:00Z",
});

describe("updateFlow helpers", () => {
  it("compares versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });

  it("sorts releases newest-first", () => {
    const out = sortNewestFirst([rel("0.6.2"), rel("0.7.0"), rel("0.6.10")]);
    expect(out.map((r) => r.version)).toEqual(["0.7.0", "0.6.10", "0.6.2"]);
  });

  it("flags breaking changes case-insensitively", () => {
    const out = breakingReleases([
      rel("0.7.0", "### BREAKING CHANGE\n- old routes 404"),
      rel("0.6.9", "fixes"),
      rel("0.6.8", "a breaking change here"),
    ]);
    expect(out.map((r) => r.version)).toEqual(["0.7.0", "0.6.8"]);
  });

  it("maps statuses to their restart consequence", () => {
    expect(consequenceFor("working")).toMatch(/stops mid-turn/);
    expect(consequenceFor("tool_running", "codex")).toMatch(/thread is kept/);
    expect(consequenceFor("tool_running", "claude-code")).toMatch(
      /command is killed/,
    );
    expect(consequenceFor("needs_input")).toMatch(/re-asking/);
    expect(consequenceFor("idle")).toBe("Nothing lost");
    expect(consequenceFor("ready")).toBe("Nothing lost");
  });

  it("joins names in prose", () => {
    expect(joinNames(["a"])).toBe("a");
    expect(joinNames(["a", "b"])).toBe("a and b");
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
  });

  it("picks the step list by install mode and maps phases onto it", () => {
    // The snapshot comes right before the change — after download/verify (and
    // the idle re-check), so it holds the state actually left.
    const bundle = stepsFor("bundle", "0.7.0", { snapshotId: "0.6.1-x" });
    expect(bundle.map((s) => s.id)).toEqual([
      "download",
      "verify",
      "snapshot",
      "install",
      "restart",
      "health",
      "reopen",
      "verify-agents",
    ]);
    expect(bundle[2].detail).toContain("snapshots/0.6.1-x");
    const source = stepsFor("source", "0.7.0");
    expect(source.map((s) => s.id)).toEqual([
      "fetch",
      "snapshot",
      "build",
      "restart",
      "health",
      "reopen",
      "verify-agents",
    ]);
    expect(stepsFor("rollback", "0.6.1").map((s) => s.id)).toEqual([
      "swap",
      "restart",
      "reopen",
    ]);
    expect(activeStepIndex(bundle, "launching")).toBe(0);
    expect(activeStepIndex(bundle, "downloading")).toBe(0);
    expect(activeStepIndex(bundle, "verifying")).toBe(1);
    expect(activeStepIndex(bundle, "snapshotting")).toBe(2);
    expect(activeStepIndex(source, "building")).toBe(2);
    expect(activeStepIndex(source, "health_check")).toBe(4);
    // done: agent check still pending until verification lands.
    expect(activeStepIndex(bundle, "done")).toBe(bundle.length - 1);
    expect(activeStepIndex(bundle, "done", true)).toBe(bundle.length);
    // A list with no agent-check step (rollback) completes on done.
    const rb = stepsFor("rollback", "0.6.1");
    expect(activeStepIndex(rb, "done")).toBe(rb.length);
  });

  it("a wait-for-idle run shows the re-check as its own step, with the job's word", () => {
    const steps = stepsFor("bundle", "0.7.0", {
      waitIdle: true,
      waitingMessage: "Waiting for api to finish",
    });
    expect(steps.map((s) => s.id).slice(0, 4)).toEqual([
      "download",
      "verify",
      "wait",
      "snapshot",
    ]);
    expect(steps[2].detail).toBe("Waiting for api to finish");
    expect(activeStepIndex(steps, "waiting_idle")).toBe(2);
    expect(stepsFor("source", "0.7.0", { waitIdle: true })[1].id).toBe("wait");
  });
});
