// OOM containment (agents/oomGuard.ts) against a FAKE /proc and cgroup tree,
// so the decisions run on any OS. The real kernel + systemd behavior is the
// CI job in .github/workflows/oom-isolation.yml (scripts/oom-isolation-ci.sh).

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AGENT_OOM_SCORE_RAISE,
  OomGuard,
  SERVER_LEAF,
} from "../agents/oomGuard.js";
import {
  OOM_RESUME_WINDOW_MS,
  oomAutoResumeAllowed,
  oomExitNotice,
} from "../agents/runtime.js";
import { detectSupervisor } from "../upgradeJob.js";

const SELF = 100;
const UNIT =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/autonomos.service";

let root: string;
let proc: string;
let cg: string;
let unitDir: string;

/** A process in the fake /proc: its stat (ppid) and current OOM score. */
function addProc(pid: number, ppid: number, comm = "node") {
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(
    join(proc, String(pid), "stat"),
    `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1`,
  );
  writeFileSync(join(proc, String(pid), "oom_score_adj"), "200");
}

function setEvents(dir: string, oomKill: number) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "memory.events"),
    `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${oomKill}\noom_group_kill 0\n`,
  );
}

function guard(env: NodeJS.ProcessEnv = { AUTONOMOS_CGROUP_DELEGATED: "1" }) {
  const logs: string[] = [];
  const g = new OomGuard({
    platform: "linux",
    env,
    procRoot: proc,
    cgroupRoot: cg,
    selfPid: SELF,
    log: (m) => logs.push(m),
  });
  return { g, logs };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oom-guard-"));
  proc = join(root, "proc");
  cg = join(root, "cgroup");
  unitDir = join(cg, UNIT);
  mkdirSync(join(proc, "self"), { recursive: true });
  writeFileSync(join(proc, "self", "oom_score_adj"), "200");
  addProc(SELF, 1);
  addProc(101, SELF, "tsx wrapper"); // a second process of the unit
  writeFileSync(join(proc, String(SELF), "cgroup"), `0::${UNIT}\n`);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "cgroup.procs"), `${SELF}\n101\n`);
  writeFileSync(join(unitDir, "cgroup.controllers"), "cpu memory pids\n");
  writeFileSync(join(unitDir, "cgroup.subtree_control"), "");
  setEvents(unitDir, 0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("OomGuard: the OOM score", () => {
  it("raises an agent's whole process tree to base+500; the server keeps its own", () => {
    const { g } = guard({});
    g.init();
    addProc(500, SELF); // the PTY child
    addProc(501, 500, "bash (build)"); // what it already started
    addProc(502, 501, "cc1plus");
    addProc(600, SELF); // an unrelated sibling: untouched
    g.attach("agent-a", 500);
    for (const p of [500, 501, 502]) {
      assert.equal(
        readFileSync(join(proc, String(p), "oom_score_adj"), "utf-8"),
        String(200 + AGENT_OOM_SCORE_RAISE),
      );
    }
    assert.equal(
      readFileSync(join(proc, "600", "oom_score_adj"), "utf-8"),
      "200",
    );
    assert.equal(
      readFileSync(join(proc, "self", "oom_score_adj"), "utf-8"),
      "200",
    );
  });

  it("caps at 1000 (the kernel's maximum)", () => {
    writeFileSync(join(proc, "self", "oom_score_adj"), "800");
    const { g } = guard({});
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    assert.equal(
      readFileSync(join(proc, "500", "oom_score_adj"), "utf-8"),
      "1000",
    );
  });

  it("off Linux: touches no process, but an outside SIGKILL is still reported (macOS jetsam kills with it)", () => {
    const g = new OomGuard({
      platform: "darwin",
      procRoot: proc,
      cgroupRoot: cg,
      selfPid: SELF,
    });
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    assert.equal(
      readFileSync(join(proc, "500", "oom_score_adj"), "utf-8"),
      "200",
    );
    assert.equal(existsSync(join(unitDir, SERVER_LEAF)), false);
    assert.equal(g.exitVerdict("a", 9), "sigkill");
    assert.equal(g.exitVerdict("a", 15), null);
  });
});

describe("OomGuard: per-agent cgroups (delegated unit)", () => {
  it("without the template's marker, never touches the cgroup tree", () => {
    const { g } = guard({});
    g.init();
    assert.equal(g.isolated, false);
    assert.equal(existsSync(join(unitDir, SERVER_LEAF)), false);
    assert.equal(
      readFileSync(join(unitDir, "cgroup.subtree_control"), "utf-8"),
      "",
    );
  });

  it("moves EVERY unit process into the server leaf, then enables memory+pids for children", () => {
    const { g } = guard();
    g.init();
    assert.equal(g.isolated, true);
    // The fake records the last write; the real cgroupfs moves one pid per
    // write. Both unit processes were written (the wrapper last).
    assert.equal(
      readFileSync(join(unitDir, SERVER_LEAF, "cgroup.procs"), "utf-8"),
      "101",
    );
    assert.equal(
      readFileSync(join(unitDir, "cgroup.subtree_control"), "utf-8"),
      "+memory +pids",
    );
  });

  it("refuses isolation when the memory controller isn't delegated (score still raised)", () => {
    writeFileSync(join(unitDir, "cgroup.controllers"), "cpu pids\n");
    const { g, logs } = guard();
    g.init();
    assert.equal(g.isolated, false);
    assert.match(logs.join("\n"), /memory controller isn't delegated/);
    addProc(500, SELF);
    g.attach("a", 500);
    assert.equal(
      readFileSync(join(proc, "500", "oom_score_adj"), "utf-8"),
      "700",
    );
  });

  it("a server restarted inside its leaf treats the parent as the unit", () => {
    writeFileSync(
      join(proc, String(SELF), "cgroup"),
      `0::${UNIT}/${SERVER_LEAF}\n`,
    );
    mkdirSync(join(unitDir, SERVER_LEAF), { recursive: true });
    writeFileSync(join(unitDir, SERVER_LEAF, "cgroup.procs"), `${SELF}\n`);
    const { g } = guard();
    g.init();
    assert.equal(g.isolated, true);
    addProc(500, SELF);
    g.attach("a", 500);
    assert.ok(existsSync(join(unitDir, "agent-a", "cgroup.procs")));
  });

  it("each agent gets its own cgroup, holding its processes", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    addProc(700, SELF);
    g.attach("a", 500);
    g.attach("b", 700);
    assert.equal(
      readFileSync(join(unitDir, "agent-a", "cgroup.procs"), "utf-8"),
      "500",
    );
    assert.equal(
      readFileSync(join(unitDir, "agent-b", "cgroup.procs"), "utf-8"),
      "700",
    );
  });

  it("an id can't escape the unit's cgroup dir", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("../../evil", 500);
    assert.ok(existsSync(join(unitDir, "agent-______evil")));
    // Nothing was created above or beside the unit's cgroup.
    assert.equal(existsSync(join(unitDir, "..", "evil")), false);
    assert.equal(existsSync(join(unitDir, "..", "..", "evil")), false);
  });
});

describe("OomGuard: telling the operator which agent", () => {
  it("an agent killed by SIGKILL with its cgroup's OOM counter up → 'oom'", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    setEvents(join(unitDir, "agent-a"), 0);
    g.attach("a", 500); // re-read baseline (fake has no counter until now)
    setEvents(join(unitDir, "agent-a"), 1);
    assert.equal(g.exitVerdict("a", 9), "oom");
  });

  it("a kill BEFORE this life of the agent isn't news (respawn reuses the cgroup)", () => {
    setEvents(join(unitDir, "agent-a"), 3);
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    assert.equal(g.exitVerdict("a", 9), "sigkill");
  });

  it("SIGKILL with no OOM counted → 'sigkill' (systemd-oomd, kill -9)", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    setEvents(join(unitDir, "agent-a"), 0);
    g.attach("a", 500);
    assert.equal(g.exitVerdict("a", 9), "sigkill");
  });

  it("a normal exit or another signal is not an outside kill", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    setEvents(join(unitDir, "agent-a"), 0);
    g.attach("a", 500);
    setEvents(join(unitDir, "agent-a"), 1);
    assert.equal(g.exitVerdict("a", undefined), null);
    assert.equal(g.exitVerdict("a", 15), null);
  });

  it("without per-agent cgroups, a unit-level OOM kill makes it 'oom-likely'", () => {
    const { g } = guard({});
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    setEvents(unitDir, 1);
    assert.equal(g.exitVerdict("a", 9), "oom-likely");
  });

  it("a build an agent survives is reported once, for that agent only", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    addProc(700, SELF);
    setEvents(join(unitDir, "agent-a"), 0);
    setEvents(join(unitDir, "agent-b"), 0);
    g.attach("a", 500);
    g.attach("b", 700);
    setEvents(join(unitDir, "agent-a"), 2);
    assert.deepEqual(g.pollKills(() => true).perAgent, [
      { agentId: "a", kills: 2 },
    ]);
    assert.deepEqual(g.pollKills(() => true).perAgent, []);
  });

  it("without per-agent cgroups, a unit-level kill is reported unattributed", () => {
    const { g } = guard({});
    g.init();
    setEvents(unitDir, 1);
    assert.equal(g.pollKills(() => true).unattributed, 1);
    assert.equal(g.pollKills(() => true).unattributed, 0);
  });

  it("release removes the agent's cgroup once it's empty", async () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("a", 500);
    rmSync(join(unitDir, "agent-a"), { recursive: true }); // emulate "emptied"
    mkdirSync(join(unitDir, "agent-a"));
    g.release("a", 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(join(unitDir, "agent-a")), false);
  });
});

describe("runtime: what the operator is told", () => {
  it("names the agent and says the rest weren't affected", () => {
    const t = oomExitNotice("api-worker", "oom", true);
    assert.match(t, /^api-worker was killed: out of memory/);
    assert.match(t, /Other agents and the server weren't affected/);
    assert.match(t, /Resuming it in the same conversation/);
  });

  it("an outside SIGKILL without an OOM count names the platform's usual cause", () => {
    assert.match(oomExitNotice("w", "sigkill", true, "linux"), /systemd-oomd/);
    assert.match(
      oomExitNotice("w", "sigkill", true, "darwin"),
      /reclaiming memory/,
    );
  });

  it("a second kill inside the window isn't auto-resumed, and says so", () => {
    assert.match(
      oomExitNotice("w", "oom", false),
      /Not resuming it automatically/,
    );
    assert.equal(oomAutoResumeAllowed("never-killed"), true);
  });

  it("the resume window is 10 minutes", () => {
    assert.equal(OOM_RESUME_WINDOW_MS, 600_000);
  });
});

describe("upgradeJob: the server in its leaf is still 'our unit'", () => {
  it("detectSupervisor accepts …/autonomos.service/server", () => {
    const sup = detectSupervisor({ INVOCATION_ID: "x" }, "linux", {
      readCgroup: () => `0::${UNIT}/${SERVER_LEAF}\n`,
    });
    assert.equal(sup.kind, "systemd");
  });

  it("…but not some other unit's leaf named server", () => {
    const sup = detectSupervisor({ INVOCATION_ID: "x" }, "linux", {
      readCgroup: () => "0::/user.slice/app.slice/other.service/server\n",
    });
    assert.equal(sup.kind, "none");
  });
});
