// /api/system/* — version + upgrade endpoints.
//
// GET  /api/system/version    → { version, platform }
// POST /api/system/upgrade    → trigger an in-process upgrade
//
// On a successful upgrade the daemon exits AFTER the response is sent, on the
// assumption that it's running under a supervisor (launchd KeepAlive=true /
// systemd Restart=always) that will restart it with the new bundle. If the
// daemon is running in the foreground without a supervisor, the upgrade still
// succeeds but the user has to start the daemon themselves.

import { Hono } from "hono";
import { deriveBundleDir, detectPlatform, performUpgrade } from "../upgrade.js";
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
  let bundleDir: string;
  try {
    bundleDir = deriveBundleDir();
  } catch (err) {
    return c.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
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
    bundleDir,
    currentVersion: getServerVersion(),
    platform,
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
