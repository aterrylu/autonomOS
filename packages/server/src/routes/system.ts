// /api/system/* — version, release notes, and the in-app update (ADR-105).
//
// GET    /api/system/version   → { version, platform, arch, …update fields }
//        Contract (API-conventions pass): path + {version, platform, arch}
//        frozen; the pid-file liveness probe hits this route, so it must
//        stay cheap and never block on anything remote. During the in-app
//        update's restart gap the dashboard polls THIS route to learn when
//        the new version answers.
// GET    /api/system/releases  → cached GitHub release bodies since this version
// GET    /api/system/upgrade   → progress record + armed state + busy agents
// POST   /api/system/upgrade   → { when: "idle" | "now" } — operator only
// DELETE /api/system/upgrade   → cancel an armed (waiting-for-idle) update
//
// The update NEVER runs in this process (ADR-077's in-band flaw; the old
// in-process swap-then-exit path is gone). POST launches `autonomos upgrade`
// as its own supervisor job (upgradeJob.ts) — which keeps the CLI's health
// gate + auto-rollback — and progress flows through a status file, not
// through the daemon being restarted (upgradeStatus.ts).

import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { InstallMode } from "../installInfo.js";
import { resolveInstall } from "../installInfo.js";
import { listSnapshots, snapshotForVersion } from "../snapshots.js";
import { getUpdateCheckState } from "../updateCheck.js";
import { readBundleVersion } from "../upgrade.js";
import {
  detectSupervisor,
  launchRollbackJob,
  launchUpgradeJob,
} from "../upgradeJob.js";
import {
  armUpgrade,
  disarmUpgrade,
  getArmedUpgrade,
  IDLE_WINDOW_MS,
  listBackgroundWork,
  listBusyAgents,
} from "../upgradeScheduler.js";
import { readUpgradeStatus, upgradeJobRunning } from "../upgradeStatus.js";
import { getServerVersion } from "../version.js";

export const systemRouter = new Hono();

// Memoized once: the install shape cannot change under a running daemon
// (an upgrade restarts it), and the version endpoint must stay cheap — it
// doubles as the pid-file liveness probe's target. `null` = unresolvable
// (a plain dev checkout), which the badge uses to give shape-true advice
// instead of advertising a command that would refuse.
let installModeMemo: InstallMode | null | undefined;
function installMode(): InstallMode | null {
  if (installModeMemo === undefined) {
    try {
      installModeMemo = resolveInstall().info.mode;
    } catch {
      installModeMemo = null;
    }
  }
  return installModeMemo;
}

systemRouter.get("/version", (c) => {
  // {version, platform, arch} are frozen (contract above). The update-check
  // fields and installMode are ADDITIVE and read from in-memory state — this
  // handler must never wait on anything remote.
  const update = getUpdateCheckState();
  return c.json({
    version: getServerVersion(),
    platform: process.platform,
    arch: process.arch,
    latest: update.latest,
    updateAvailable: update.updateAvailable,
    checkedAt: update.checkedAt,
    releaseUrl: update.releaseUrl,
    installMode: installMode(),
  });
});

systemRouter.get("/releases", (c) => {
  const u = getUpdateCheckState();
  return c.json({
    current: getServerVersion(),
    latest: u.latest,
    updateAvailable: u.updateAvailable,
    releaseUrl: u.releaseUrl,
    // null = notes unavailable (fetch failed / rate-limited): the dashboard
    // shows a GitHub link instead. Never blocks the update.
    releases: u.releases,
  });
});

// A run is "in flight" while its record is non-terminal and fresh. The
// staleness bound keeps a job that died without a final write (machine
// lost power mid-update) from wedging the button forever.
function upgradeInFlight(): boolean {
  // The lock covers a shell `autonomos upgrade`/`rollback` too (no status
  // file), and tells a killed job's orphaned record from a live one.
  return upgradeJobRunning();
}

systemRouter.get("/upgrade", (c) => {
  return c.json({
    current: getServerVersion(),
    supervised: detectSupervisor().kind !== "none",
    installMode: installMode(),
    status: readUpgradeStatus(),
    armed: getArmedUpgrade(),
    idleWindowMs: IDLE_WINDOW_MS,
    busy: listBusyAgents(),
    background: listBackgroundWork(),
    // Judged here, on the clock that wrote the record — a browser whose clock
    // is minutes off would otherwise declare a live job dead (or a dead one
    // live).
    inFlight: upgradeInFlight(),
  });
});

/**
 * Operator-only guard for the update trigger. Agents never get an update
 * surface: it is not an MCP tool, the internal control socket does not mount
 * /api/system, and requests an agent's tooling makes are identifiable —
 * the per-agent X-Agent-Token header, or bearer-token API calls. The trigger
 * therefore requires the dashboard's login COOKIE and refuses both.
 *
 * Honest boundary (ADR-105): an agent's MCP config carries the operator
 * token, so an agent that deliberately forges a browser request with it
 * could pass this check. That is the same trusted-fleet boundary every
 * operator route already has (ADR-067's caveat); this guard closes every
 * agent-FACING path, not a determined forgery.
 */
function operatorOnly(c: Context): Response | null {
  if (c.req.header("X-Agent-Token")) {
    return c.json(
      { error: "Agents cannot trigger updates.", code: "OPERATOR_ONLY" },
      403,
    );
  }
  if (!getCookie(c, "autonomos_token")) {
    return c.json(
      {
        error:
          "The in-app update is dashboard-only. From a shell, run `autonomos upgrade`.",
        code: "OPERATOR_ONLY",
      },
      403,
    );
  }
  // CSRF: the cookie is SameSite=Lax, which browsers still attach to requests
  // from OTHER PORTS of the same host (site = scheme + host, port ignored) —
  // e.g. an agent's dev server on :5173 could POST here with the operator's
  // cookie. The dashboard itself is always same-origin.
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  let crossOrigin = fetchSite !== undefined && fetchSite !== "same-origin";
  if (!crossOrigin && origin) {
    try {
      crossOrigin = new URL(origin).host !== c.req.header("Host");
    } catch {
      crossOrigin = true;
    }
  }
  // A JSON content type forces a CORS preflight on any cross-origin POST,
  // which fails (no CORS here) — the belt to the headers' braces for clients
  // that send neither.
  const notJson =
    c.req.method === "POST" &&
    !(c.req.header("Content-Type") ?? "").includes("application/json");
  if (crossOrigin || notJson) {
    return c.json(
      {
        error: "Update requests must come from the dashboard itself.",
        code: "CROSS_ORIGIN",
      },
      403,
    );
  }
  return null;
}

systemRouter.post("/upgrade", async (c) => {
  const denied = operatorOnly(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const when = body?.when === "now" ? "now" : "idle";

  const u = getUpdateCheckState();
  if (!u.updateAvailable || !u.latest) {
    return c.json({ error: "No update available.", code: "NO_UPDATE" }, 409);
  }
  // The dialog showed notes (and any storage-format callout) for one
  // version; if the daily check moved `latest` since, don't install a
  // different one behind that screen.
  if (
    typeof body?.expectedVersion === "string" &&
    body.expectedVersion !== u.latest
  ) {
    return c.json(
      {
        error: `A newer release (v${u.latest}) appeared since you opened this. Review its notes first.`,
        code: "VERSION_CHANGED",
        latest: u.latest,
      },
      409,
    );
  }
  if (detectSupervisor().kind === "none") {
    return c.json(
      {
        error:
          "This autonomOS isn't running as a service, so it can't restart itself. Run `autonomos upgrade` in a terminal.",
        code: "NOT_SUPERVISED",
      },
      409,
    );
  }
  if (upgradeInFlight()) {
    return c.json(
      { error: "An update is already running.", code: "IN_FLIGHT" },
      409,
    );
  }

  if (when === "idle") {
    const armed = armUpgrade(u.latest);
    return c.json({ ok: true, armed });
  }
  disarmUpgrade();
  const r = launchUpgradeJob(u.latest);
  if (!r.ok) {
    return c.json({ error: r.message, code: "LAUNCH_FAILED" }, 500);
  }
  return c.json({ ok: true, launched: true });
});

/**
 * What the in-app Restore would put back: the version the last upgrade
 * replaced (bundle `.previous`, or the source marker's previousVersion) and
 * whether a state snapshot pairs with it. null = nothing to restore.
 */
function rollbackTarget(): {
  version: string;
  snapshotId: string | null;
} | null {
  try {
    const install = resolveInstall();
    const version =
      install.info.mode === "source"
        ? (install.info.previousVersion ?? null)
        : readBundleVersion(`${install.bundleDir}.previous`);
    if (!version || version === "unknown") return null;
    return { version, snapshotId: snapshotForVersion(version)?.id ?? null };
  } catch (err) {
    // Dev checkouts land here by design; a corrupt install.json also does,
    // and would otherwise read as "nothing to restore" with no trace.
    if (!warnedRollbackTarget) {
      warnedRollbackTarget = true;
      console.warn(
        `[upgrade] no Restore target: ${err instanceof Error ? err.message : err}`,
      );
    }
    return null;
  }
}
let warnedRollbackTarget = false;

systemRouter.get("/snapshots", (c) => {
  return c.json({
    // Manifests without the per-agent baseline (ids/threads are internal).
    snapshots: listSnapshots().map(({ agents, ...m }) => ({
      ...m,
      agentCount: agents.length,
    })),
    rollback: rollbackTarget(),
  });
});

systemRouter.post("/rollback", (c) => {
  const denied = operatorOnly(c);
  if (denied) return denied;
  const target = rollbackTarget();
  if (!target) {
    return c.json(
      { error: "There's no previous version to restore.", code: "NO_ROLLBACK" },
      409,
    );
  }
  if (detectSupervisor().kind === "none") {
    return c.json(
      {
        error:
          "This autonomOS isn't running as a service, so it can't restart itself. Run `autonomos rollback` in a terminal.",
        code: "NOT_SUPERVISED",
      },
      409,
    );
  }
  if (upgradeInFlight()) {
    return c.json(
      { error: "An update is already running.", code: "IN_FLIGHT" },
      409,
    );
  }
  disarmUpgrade();
  const r = launchRollbackJob(target.version);
  if (!r.ok) {
    return c.json({ error: r.message, code: "LAUNCH_FAILED" }, 500);
  }
  return c.json({ ok: true, launched: true, target });
});

systemRouter.delete("/upgrade", (c) => {
  const denied = operatorOnly(c);
  if (denied) return denied;
  // Lost the race with the idle tick: the job already launched. Saying
  // "cancelled" here would let the operator walk away from a restart.
  if (!getArmedUpgrade() && upgradeInFlight()) {
    return c.json(
      {
        error: "The update already started and can't be cancelled.",
        code: "LAUNCHED",
      },
      409,
    );
  }
  disarmUpgrade();
  return c.json({ ok: true });
});
