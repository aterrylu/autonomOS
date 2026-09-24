// In-app update (ADR-105): out-of-band launch, idle scheduler, operator-only
// trigger, and the release-notes cache. The launcher's SUPERVISOR behavior
// (systemd-run survives a service restart; a setsid child does not) was
// measured on real supervisors before this was written — these tests pin the
// command shapes that measurement justified, with an injected runner so no
// test ever touches launchctl/systemctl (standing order).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { systemRouter } from "../routes/system.js";
import { _resetUpdateCheckForTesting, runUpdateCheck } from "../updateCheck.js";
import {
  buildLaunchPlan,
  detectSupervisor,
  launchUpgradeJob,
} from "../upgradeJob.js";
import {
  _resetSchedulerForTesting,
  _setSchedulerDepsForTesting,
  armUpgrade,
  type BusyAgent,
  getArmedUpgrade,
  IDLE_WINDOW_MS,
  tickArmedUpgrade,
} from "../upgradeScheduler.js";
import { readUpgradeStatus, upgradeStatusPath } from "../upgradeStatus.js";

let cfg: string;
let server: Server | undefined;
beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), "autonomos-inapp-"));
  _setConfigDirForTesting(cfg);
  _resetUpdateCheckForTesting();
  _resetSchedulerForTesting();
});
afterEach(async () => {
  _resetSchedulerForTesting();
  _resetUpdateCheckForTesting();
  _resetConfigDirForTesting();
  rmSync(cfg, { recursive: true, force: true });
  if (server) {
    await new Promise((r) => server?.close(r));
    server = undefined;
  }
});

const PROC = {
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  argv: ["/usr/bin/node", "/opt/autonomos/index.js", "start"],
  env: {
    HOME: "/home/u",
    PATH: "/usr/bin",
    AUTONOMOS_CONFIG_DIR: "/home/u/.autonomos",
    AUTONOMOS_TOKEN: "must-not-propagate",
  } as NodeJS.ProcessEnv,
};

describe("detectSupervisor", () => {
  // Real cgroup lines, captured on forge.
  const ownUnit = () =>
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/autonomos.service\n";
  const testUnit = () =>
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.autonomos.daemon.test.service\n";
  const gnomeTerminal = () =>
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal.slice/gnome-terminal-server.service\n";

  it("systemd only when THIS process runs in autonomOS's own unit", () => {
    assert.deepEqual(
      detectSupervisor({ INVOCATION_ID: "x" }, "linux", ownUnit),
      {
        kind: "systemd",
      },
    );
    assert.deepEqual(
      detectSupervisor(
        {
          INVOCATION_ID: "x",
          AUTONOMOS_SERVICE_LABEL: "com.autonomos.daemon.test",
        },
        "linux",
        testUnit,
      ),
      { kind: "systemd" },
    );
  });

  it("an inherited INVOCATION_ID from another unit (a terminal) is NOT supervision", () => {
    // A foreground `autonomos start` in GNOME Terminal inherits the terminal
    // unit's INVOCATION_ID; the update job would stop it with nothing to
    // restart it.
    assert.equal(
      detectSupervisor({ INVOCATION_ID: "x" }, "linux", gnomeTerminal).kind,
      "none",
    );
    // …and a test-labelled daemon doesn't count the default unit as its own.
    assert.equal(
      detectSupervisor(
        {
          INVOCATION_ID: "x",
          AUTONOMOS_SERVICE_LABEL: "com.autonomos.daemon.test",
        },
        "linux",
        ownUnit,
      ).kind,
      "none",
    );
    assert.equal(detectSupervisor({}, "linux", ownUnit).kind, "none");
  });

  it("launchd only when XPC_SERVICE_NAME is OUR label", () => {
    assert.deepEqual(
      detectSupervisor({ XPC_SERVICE_NAME: "com.autonomos.daemon" }, "darwin"),
      { kind: "launchd", label: "com.autonomos.daemon" },
    );
    for (const xpc of [
      "0",
      "application.com.apple.Terminal.1",
      "com.example.some-other-job",
    ]) {
      assert.equal(
        detectSupervisor({ XPC_SERVICE_NAME: xpc }, "darwin").kind,
        "none",
        xpc,
      );
    }
  });
});

describe("buildLaunchPlan", () => {
  it("re-invokes this process's entry with the upgrade verb, carrying the loader", () => {
    const plan = buildLaunchPlan(
      ["upgrade", "--version=0.8.0"],
      "/s.json",
      PROC,
    );
    assert.deepEqual(plan.argv, [
      "/usr/bin/node",
      "--import",
      "tsx",
      "/opt/autonomos/index.js",
      "upgrade",
      "--version=0.8.0",
      "--status-file=/s.json",
    ]);
  });
  it("propagates install-addressing env but never the auth token", () => {
    const plan = buildLaunchPlan(
      ["upgrade", "--version=0.8.0"],
      "/s.json",
      PROC,
    );
    assert.equal(plan.env.AUTONOMOS_CONFIG_DIR, "/home/u/.autonomos");
    assert.equal(plan.env.AUTONOMOS_TOKEN, undefined);
  });
});

describe("launchUpgradeJob", () => {
  function recorder() {
    const calls: { cmd: string; args: string[] }[] = [];
    return {
      calls,
      run: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { status: 0, stderr: "" };
      },
    };
  }

  it("systemd: a transient user unit (own cgroup) with $ escaped for systemd", () => {
    const r = recorder();
    const proc = {
      ...PROC,
      argv: ["/usr/bin/node", "/opt/$weird/index.js"],
      env: { ...PROC.env, HOME: "/home/$user" },
    };
    const res = launchUpgradeJob("0.8.0", {
      supervisor: { kind: "systemd" },
      run: r.run,
      configDir: cfg,
      proc,
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].cmd, "systemd-run");
    const a = r.calls[0].args;
    assert.ok(a.includes("--user") && a.includes("--collect"));
    assert.ok(a.some((x) => x.startsWith("--unit=autonomos-upgrade-")));
    assert.ok(
      a.includes("/opt/$$weird/index.js"),
      "systemd would expand a bare $",
    );
    // …but --setenv values are literal (measured): never escaped.
    assert.ok(a.includes("--setenv=HOME=/home/$user"), a.join(" "));
    assert.equal(readUpgradeStatus(upgradeStatusPath(cfg))?.phase, "launching");
  });

  it("launchd: a one-shot job labelled from the daemon's own label (test daemons stay test-labelled)", () => {
    const r = recorder();
    launchUpgradeJob("0.8.0", {
      supervisor: { kind: "launchd", label: "com.autonomos.daemon.test" },
      run: r.run,
      configDir: cfg,
      proc: PROC,
    });
    assert.deepEqual(
      r.calls.map((c) => c.args[0]),
      ["bootout", "bootstrap"],
      "clear a stale finished job, then bootstrap",
    );
    assert.ok(
      r.calls[0].args[1].endsWith("/com.autonomos.daemon.test.upgrade"),
    );
    const plist = readFileSync(join(cfg, "upgrade-job.plist"), "utf-8");
    assert.match(
      plist,
      /<string>com\.autonomos\.daemon\.test\.upgrade<\/string>/,
    );
    assert.doesNotMatch(plist, /KeepAlive/, "one-shot: must not be revived");
    assert.doesNotMatch(plist, /must-not-propagate/);
  });

  it("refuses when not supervised — nothing could restart the daemon", () => {
    const r = recorder();
    const res = launchUpgradeJob("0.8.0", {
      supervisor: { kind: "none" },
      run: r.run,
      configDir: cfg,
    });
    assert.equal(res.ok, false);
    assert.equal(r.calls.length, 0);
  });

  it("a failed launch lands a 'failed' record the dashboard can show", () => {
    const res = launchUpgradeJob("0.8.0", {
      supervisor: { kind: "systemd" },
      run: () => ({ status: 1, stderr: "Failed to connect to bus" }),
      configDir: cfg,
      proc: PROC,
    });
    assert.equal(res.ok, false);
    const rec = readUpgradeStatus(upgradeStatusPath(cfg));
    assert.equal(rec?.phase, "failed");
    assert.match(rec?.message ?? "", /Failed to connect to bus/);
  });
});

describe("armed update waits for a continuous idle window", () => {
  it(`launches only after ${IDLE_WINDOW_MS / 1000}s of continuous idle; a new turn resets the window`, () => {
    let now = 1_000_000;
    let busy: BusyAgent[] = [
      { id: "a", name: "api-refactor", status: "working" },
    ];
    const launched: string[] = [];
    _setSchedulerDepsForTesting({
      now: () => now,
      busy: () => busy,
      launch: (t) => {
        launched.push(t);
        return { ok: true };
      },
    });
    armUpgrade("0.8.0");
    assert.equal(getArmedUpgrade()?.idleSince, null, "busy at arm time");

    busy = [];
    now += 2_000;
    tickArmedUpgrade(); // idle window starts
    now += IDLE_WINDOW_MS - 1;
    tickArmedUpgrade();
    assert.equal(launched.length, 0, "one ms short of the window");

    busy = [{ id: "a", name: "api-refactor", status: "tool_running" }];
    now += 1;
    tickArmedUpgrade(); // a new turn resets
    busy = [];
    now += 1;
    tickArmedUpgrade(); // window restarts here
    now += IDLE_WINDOW_MS;
    const r = tickArmedUpgrade();
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(launched, ["0.8.0"]);
    assert.equal(getArmedUpgrade(), null, "disarmed after launching");
  });
});

describe("POST /api/system/upgrade is operator-only", () => {
  const app = new Hono();
  app.route("/api/system", systemRouter);

  it("refuses a request carrying an agent token", async () => {
    const res = await app.request("/api/system/upgrade", {
      method: "POST",
      headers: { "X-Agent-Token": "t", Cookie: "autonomos_token=x" },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "OPERATOR_ONLY");
  });

  it("refuses bearer-only API calls (the shape agent tooling uses)", async () => {
    const res = await app.request("/api/system/upgrade", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
    });
    assert.equal(res.status, 403);
  });

  // What the dashboard's own fetch sends.
  const DASHBOARD = {
    Cookie: "autonomos_token=x",
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    Origin: "http://localhost:3100",
    Host: "localhost:3100",
  };

  it("a dashboard (cookie) request passes the guard to the real checks", async () => {
    const res = await app.request("/api/system/upgrade", {
      method: "POST",
      headers: DASHBOARD,
      body: JSON.stringify({ when: "now" }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_UPDATE");
  });

  describe("CSRF: the Lax cookie also rides requests from other ports", () => {
    const attempts: [string, Record<string, string>][] = [
      [
        "a cross-site fetch (Sec-Fetch-Site)",
        {
          ...DASHBOARD,
          "Sec-Fetch-Site": "same-site",
          Origin: "http://localhost:5173",
        },
      ],
      [
        "an older browser: Origin from another port of the same host",
        (() => {
          const { "Sec-Fetch-Site": _, ...h } = DASHBOARD;
          return { ...h, Origin: "http://localhost:5173" };
        })(),
      ],
      [
        "a form-style POST with no JSON content type (no preflight)",
        (() => {
          const {
            "Content-Type": _,
            "Sec-Fetch-Site": __,
            Origin: ___,
            ...h
          } = DASHBOARD;
          return { ...h, "Content-Type": "text/plain" };
        })(),
      ],
    ];
    for (const [label, headers] of attempts) {
      it(`refuses ${label}`, async () => {
        for (const path of ["/api/system/upgrade", "/api/system/rollback"]) {
          const res = await app.request(path, {
            method: "POST",
            headers,
            body: JSON.stringify({ when: "now" }),
          });
          assert.equal(res.status, 403, path);
          assert.equal((await res.json()).code, "CROSS_ORIGIN", path);
        }
      });
    }

    it("refuses a cross-site cancel (DELETE)", async () => {
      const res = await app.request("/api/system/upgrade", {
        method: "DELETE",
        headers: { ...DASHBOARD, "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, "CROSS_ORIGIN");
    });
  });

  it("DELETE (cancel) is guarded the same way", async () => {
    const res = await app.request("/api/system/upgrade", {
      method: "DELETE",
      headers: { "X-Agent-Token": "t" },
    });
    assert.equal(res.status, 403);
  });
});

describe("release notes cache (one source: GitHub release bodies)", () => {
  async function serve(routes: Record<string, unknown>, status = 200) {
    server = createServer((req, res) => {
      const key = Object.keys(routes).find((k) => req.url?.startsWith(k));
      res.statusCode = key ? status : 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(key ? routes[key] : {}));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const a = server?.address();
    if (!a || typeof a !== "object") throw new Error("no port");
    return `http://127.0.0.1:${a.port}`;
  }

  it("keeps every published release in (current, latest], newest first, bodies verbatim", async () => {
    const base = await serve({
      "/repos/o/r/releases/latest": { tag_name: "v9.9.9" },
      "/repos/o/r/releases?": [
        { tag_name: "v0.0.1", body: "ancient" },
        {
          tag_name: "v9.9.8",
          body: "## Middle\n- one",
          html_url: "u8",
          name: "v9.9.8",
        },
        {
          tag_name: "v9.9.9",
          body: "## Newest",
          html_url: "u9",
          name: "v9.9.9",
        },
        { tag_name: "v9.9.7-rc.1", body: "rc", prerelease: true },
        { tag_name: "v9.9.6", body: "draft", draft: true },
        { tag_name: "v99.0.0", body: "beyond latest" },
      ],
    });
    const s = await runUpdateCheck(base, "o/r");
    assert.deepEqual(
      s.releases?.map((r) => [r.version, r.body]),
      [
        ["9.9.9", "## Newest"],
        ["9.9.8", "## Middle\n- one"],
      ],
    );
  });

  it("a notes fetch failure yields null (fallback), never hides the update", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/repos/o/r/releases/latest")) {
        res.end(JSON.stringify({ tag_name: "v9.9.9" }));
      } else {
        res.statusCode = 403; // rate-limited
        res.end("{}");
      }
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const a = server.address();
    if (!a || typeof a !== "object") throw new Error("no port");
    const s = await runUpdateCheck(`http://127.0.0.1:${a.port}`, "o/r");
    assert.equal(s.updateAvailable, true);
    assert.equal(s.releases, null);
  });
});
