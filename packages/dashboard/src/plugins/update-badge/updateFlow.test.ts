import { describe, expect, it } from "vitest";
import type { ReleaseNote } from "../../api/system";
import {
  activeStepIndex,
  compareVersions,
  consequenceFor,
  inAppNotes,
  joinNames,
  resurfacedFlag,
  sortNewestFirst,
  stageDetail,
  stageFor,
  stepsFor,
  takeUpdatedFlag,
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

  it("maps statuses to their restart consequence", () => {
    expect(consequenceFor("working")).toBe(
      "Its current task stops. Prompt it to continue.",
    );
    // Same outcome, same words, whichever CLI runs the command.
    expect(consequenceFor("tool_running", "codex")).toBe(
      consequenceFor("tool_running", "claude-code"),
    );
    expect(consequenceFor("tool_running")).toMatch(/running command stops/);
    expect(consequenceFor("needs_input")).toMatch(/question to you is cleared/);
    expect(consequenceFor("idle")).toBe(
      "Restarts and picks up where it left off.",
    );
    expect(consequenceFor("ready")).toBe(consequenceFor("idle"));
  });

  it("maps every phase to one of three stages, and says what it's doing", () => {
    expect(
      (
        [
          "launching",
          "fetching",
          "downloading",
          "verifying",
          "waiting_idle",
          "snapshotting",
          "installing",
          "building",
        ] as const
      ).map(stageFor),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(stageFor("restarting")).toBe(1);
    // The new daemon's health check is still "Restarting".
    expect(stageFor("health_check")).toBe(1);
    expect(stageFor("done")).toBe(2);
    expect(stageFor(undefined)).toBe(0);
    expect(stageDetail("downloading", "0.7.0")).toBe("Downloading v0.7.0");
    expect(stageDetail("health_check", "0.7.0")).toBe(
      "Making sure v0.7.0 started",
    );
    expect(
      stageDetail("waiting_idle", "0.7.0", { message: "Waiting for api" }),
    ).toBe("Waiting for api");
    expect(stageDetail("installing", "0.6.1", { rollback: true })).toBe(
      "Putting v0.6.1 back in place",
    );
  });

  it("drops the GitHub install footer from notes shown inside the dialog", () => {
    const body = [
      "- 🚀 new thing",
      "- 🩹 fix",
      "",
      "---",
      "📦 **Install / upgrade:** `curl -fsSL https://x/install.sh | sh`",
      "💾 **Manual download:** grab the tarball from the assets below (verify against SHA256SUMS)",
    ].join("\n");
    expect(inAppNotes(body)).toBe("- 🚀 new thing\n- 🩹 fix");
    // A rule followed by real notes stays.
    expect(inAppNotes("a\n---\nb")).toBe("a\n---\nb");
    // A changelog bullet that merely MENTIONS the installer stays (nox's
    // catch: the old filter dropped any line with install.sh / SHA256SUMS)…
    const real = [
      "- fix(install): install.sh no longer skips the Claude check",
      "- verify SHA256SUMS on download",
    ].join("\n");
    expect(inAppNotes(real)).toBe(real);
    // …while a footer-SHAPED stray line (no rule above it) still goes.
    expect(
      inAppNotes(
        "- a fix\n📦 **Install / upgrade:** `curl … install.sh | sh`\n- b",
      ),
    ).toBe("- a fix\n- b");
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

describe("the post-update flag and its resurfacing (ADR-122)", () => {
  const done = (extra: Record<string, unknown>) =>
    ({
      current: "0.7.0",
      status: {
        phase: "done",
        from: "0.6.1",
        to: "0.7.0",
        startedAt: "s1",
        updatedAt: "u",
        ...extra,
      },
    }) as never;

  it("resurfaces for an unchecked build record even with no agent problems", () => {
    const f = resurfacedFlag(
      done({
        verification: { checkedAt: "x", checked: 1, problems: [] },
        provenance: {
          status: "skipped",
          reason: "AUTONOMOS_SKIP_PROVENANCE=1 is set",
        },
      }),
      null,
    );
    expect(f?.provenance).toEqual({
      status: "skipped",
      reason: "AUTONOMOS_SKIP_PROVENANCE=1 is set",
    });
    // A verified update with no problems has nothing to say.
    expect(
      resurfacedFlag(
        done({
          verification: { checkedAt: "x", checked: 1, problems: [] },
          provenance: { status: "verified" },
        }),
        null,
      ),
    ).toBeNull();
  });

  it("an unrecognized provenance status in the flag fails CLOSED (a warning, never green)", () => {
    sessionStorage.setItem(
      "autonomos:updated",
      JSON.stringify({
        updatedTo: "0.7.0",
        interruptedNames: [],
        provenance: { status: "some-future-status" },
      }),
    );
    expect(takeUpdatedFlag()?.provenance).toEqual({
      status: "missing",
      reason: "an unrecognized check result",
    });
  });
});
