// /api/system/* — version + upgrade endpoints.
//
// GET  /api/system/version    → { version, platform, arch }
//      Contract (agreed with the API-conventions pass): path and these three
//      fields are stable; the pid-file liveness probe hits this route, so it
//      must stay cheap and never block on anything remote.
// POST /api/system/upgrade    → trigger an in-process upgrade
//
// The in-process path follows the stage-then-exit(0) discipline (ADR-071):
// the swap is pure filesystem work (safe in-process), the response is sent,
// and then the process EXITS — it never calls launchctl/systemctl on itself
// (an in-band supervisor restart kills the process mid-call; see the OpenClaw
// postmortems cited in the ADR). The supervisor (launchd KeepAlive / systemd
// Restart=always) revives it on the new bundle. Exit happens ONLY on status
// "upgraded" — an up-to-date no-op must not bounce the daemon.
//
// What this path deliberately lacks (vs the CLI): the post-restart health
// gate + auto-rollback — the process that would run them is gone. The
// backstops are StartLimitIntervalSec=0 (supervisor never stops retrying)
// and `autonomos rollback` from a shell. That asymmetry is why the dashboard
// gets no Update button in v1.

import { Hono } from "hono";
import { type ResolvedInstall, resolveInstall } from "../installInfo.js";
import { detectPlatform, performUpgrade } from "../upgrade.js";
import { getServerVersion } from "../version.js";

export const systemRouter = new Hono();

systemRouter.get("/version", (c) =>
  c.json({
    version: getServerVersion(),
    platform: process.platform,
    arch: process.arch,
  }),
);

// At most one in-process upgrade at a time: concurrent runs share a staging
// dir keyed by pid (the second's cleanup clobbers the first's download) and
// would race the same renames — a race can strand the install with no live
// bundle. In-process latch suffices for same-process requests; a CLI upgrade
// racing the route is out of scope (single-operator boxes).
let upgradeInFlight = false;

systemRouter.post("/upgrade", async (c) => {
  if (upgradeInFlight) {
    return c.json(
      { status: "error", message: "An upgrade is already in progress." },
      409,
    );
  }
  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    return c.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
  if (install.info.mode === "source") {
    return c.json(
      {
        status: "error",
        message:
          "This is a source (git clone) install — upgrade it from a shell " +
          "with `git pull && make prod` (source-mode upgrade backend ships " +
          "in a later release).",
      },
      400,
    );
  }

  let platform: ReturnType<typeof detectPlatform>;
  try {
    platform = detectPlatform();
  } catch (err) {
    return c.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }

  upgradeInFlight = true;
  let result: Awaited<ReturnType<typeof performUpgrade>>;
  try {
    result = await performUpgrade({
      bundleDir: install.bundleDir,
      currentVersion: getServerVersion(),
      platform,
      installInfo: install.info,
    });
  } finally {
    // Released even on "upgraded": the exit below is scheduled, not certain
    // (an unsupervised daemon keeps living until then), and a stuck latch
    // would block retries forever.
    upgradeInFlight = false;
  }

  if (result.status === "upgraded") {
    // Send response first, then exit. Under launchd KeepAlive / systemd
    // Restart=always the supervisor revives us on the new bundle. A daemon
    // started FOREGROUND (no service installed) stays down after this exit —
    // the server cannot see its own supervisor from in here, so say so in
    // the response instead of promising a restart.
    setTimeout(() => {
      console.log("[upgrade] Restarting to apply new bundle...");
      process.exit(0);
    }, 500);
    return c.json({
      ...result,
      note:
        "Daemon exits in ~500ms. A supervised install (launchd/systemd) " +
        "restarts automatically; a foreground daemon must be started again " +
        "with `autonomos start`.",
    });
  }

  return c.json(result);
});
