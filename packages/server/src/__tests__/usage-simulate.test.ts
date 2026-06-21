import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RateLimitData } from "../plugins/claude-usage/scanner.js";
import {
  getRateLimits,
  getUsageOverride,
  setUsageOverride,
} from "../plugins/claude-usage/scanner.js";
import { applySimulatedClear, usageQueueRouter } from "../routes/usageQueue.js";

const SIM_FLAG = "AUTONOMOS_ENABLE_USAGE_SIMULATION";

function fakeUsage(utilization: number): RateLimitData {
  return {
    fiveHour: { utilization, resetsAt: "2026-06-20T05:00:00Z" },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("usage override (scanner)", () => {
  afterEach(() => setUsageOverride(null));

  it("short-circuits getRateLimits with the override — no network", async () => {
    const fake = fakeUsage(100);
    setUsageOverride(fake);
    // A fetcher that throws proves the real query path is never reached.
    const data = await getRateLimits(() => {
      throw new Error("must not fetch when overridden");
    });
    assert.equal(data, fake);
  });

  it("clearing the override resumes real reads", () => {
    setUsageOverride(fakeUsage(100));
    assert.ok(getUsageOverride());
    setUsageOverride(null);
    assert.equal(getUsageOverride(), null);
  });
});

describe("POST /_simulate", () => {
  beforeEach(() => {
    delete process.env[SIM_FLAG];
    setUsageOverride(null);
  });
  afterEach(() => {
    delete process.env[SIM_FLAG];
    setUsageOverride(null);
  });

  it("404s and sets nothing when simulation is disabled", async () => {
    const res = await usageQueueRouter.request("/_simulate?state=capped", {
      method: "POST",
    });
    assert.equal(res.status, 404);
    assert.equal(getUsageOverride(), null, "gated off → no override set");
  });

  it("sets a capped override when the flag is enabled", async () => {
    process.env[SIM_FLAG] = "1";
    const res = await usageQueueRouter.request("/_simulate?state=capped", {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.equal(getUsageOverride()?.fiveHour?.utilization, 100);
  });

  it("sets a cleared override (a small non-zero, so the drop is unambiguous)", async () => {
    process.env[SIM_FLAG] = "1";
    await usageQueueRouter.request("/_simulate?state=cleared", {
      method: "POST",
    });
    const util = getUsageOverride()?.fiveHour?.utilization;
    assert.ok(
      util != null && util < 80,
      "cleared is below the queue's exit threshold",
    );
  });

  it("clears the override on state=off", async () => {
    process.env[SIM_FLAG] = "1";
    setUsageOverride(fakeUsage(100));
    const res = await usageQueueRouter.request("/_simulate?state=off", {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.equal(getUsageOverride(), null);
  });

  it("rejects an unknown state", async () => {
    process.env[SIM_FLAG] = "1";
    const res = await usageQueueRouter.request("/_simulate?state=bogus", {
      method: "POST",
    });
    assert.equal(res.status, 400);
  });
});

describe("timed simulation reset", () => {
  beforeEach(() => {
    process.env[SIM_FLAG] = "1";
    setUsageOverride(null);
  });
  afterEach(async () => {
    // state=off also cancels any pending auto-clear timer this test scheduled.
    await usageQueueRouter.request("/_simulate?state=off", { method: "POST" });
    delete process.env[SIM_FLAG];
    setUsageOverride(null);
  });

  it("capped with resetInSec sets a near-future reset hint", async () => {
    const before = Date.now();
    const res = await usageQueueRouter.request(
      "/_simulate?state=capped&resetInSec=120",
      { method: "POST" },
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resetInSec, 120);

    const ov = getUsageOverride();
    assert.equal(ov?.fiveHour?.utilization, 100);
    const resetMs = new Date(ov?.fiveHour?.resetsAt ?? 0).getTime();
    // ~120s out (allow generous slack for test timing).
    assert.ok(resetMs > before + 100_000 && resetMs < before + 140_000);
  });

  it("ignores resetInSec for a non-capped state", async () => {
    const res = await usageQueueRouter.request(
      "/_simulate?state=cleared&resetInSec=60",
      { method: "POST" },
    );
    assert.equal((await res.json()).resetInSec, null, "no timer for 'cleared'");
  });

  it("ignores a non-positive / non-numeric resetInSec", async () => {
    const res = await usageQueueRouter.request(
      "/_simulate?state=capped&resetInSec=nope",
      { method: "POST" },
    );
    assert.equal((await res.json()).resetInSec, null);
  });

  it("applySimulatedClear flips the override to cleared (what the timer runs)", async () => {
    setUsageOverride(null);
    await usageQueueRouter.request("/_simulate?state=capped", {
      method: "POST",
    });
    assert.equal(getUsageOverride()?.fiveHour?.utilization, 100);

    await applySimulatedClear();
    const util = getUsageOverride()?.fiveHour?.utilization;
    assert.ok(
      util != null && util < 80,
      "cleared is below the queue's exit threshold so an armed pane fires",
    );
  });
});
