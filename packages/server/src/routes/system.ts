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
import { resolveInstall } from "../installInfo.js";
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

systemRouter.post("/upgrade", async (c) => {
  let install: ReturnType<typeof resolveInstall>;
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

  const result = await performUpgrade({
    bundleDir: install.bundleDir,
    currentVersion: getServerVersion(),
    platform,
    installInfo: install.info,
  });

  if (result.status === "upgraded") {
    // Send response first, then exit. The supervisor will restart us with
    // the new bundle. Give the response a moment to flush.
    setTimeout(() => {
      console.log("[upgrade] Restarting to apply new bundle...");
      process.exit(0);
    }, 500);
  }

  return c.json(result);
});
