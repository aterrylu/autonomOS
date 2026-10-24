// OOM containment (agents/oomGuard.ts) against a FAKE /proc and cgroup tree,
// so the decisions run on any OS. The real kernel + systemd behavior is the
// CI step "OOM isolation (real systemd)" in .github/workflows/test.yml
// (scripts/oom-isolation-ci.sh).

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
  /** A delegated guard with agent `id` attached at `pid` and its counter at 0. */
  function attached(id = "a", pid = 500) {
    const { g, logs } = guard();
    g.init();
    addProc(pid, SELF);
    setEvents(join(unitDir, `agent-${id}`), 0);
    g.attach(id, pid, { leader: true });
    return {
      g,
      logs,
      bump: (n: number) => setEvents(join(unitDir, `agent-${id}`), n),
    };
  }

  it("SIGKILL with the agent's cgroup counting an OOM kill → 'oom'", () => {
    const { g, bump } = attached();
    bump(1);
    assert.equal(g.exitVerdict("a", 9), "oom");
  });

  it("a crash that ISN'T a SIGKILL after an OOM kill → still 'oom' (the Codex daemon died, its TUI exited 1)", () => {
    const { g, bump } = attached();
    bump(1);
    assert.equal(g.exitVerdict("a", undefined, 1), "oom");
  });

  it("a clean exit after a process it started was OOM-killed → 'oom-then-exited' (reported, not resumed)", () => {
    const { g, bump } = attached();
    bump(1);
    assert.equal(g.exitVerdict("a", undefined, 0), "oom-then-exited");
  });

  it("a kill BEFORE this life of the agent isn't news (respawn reuses the cgroup)", () => {
    setEvents(join(unitDir, "agent-a"), 3);
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("a", 500, { leader: true });
    assert.equal(g.exitVerdict("a", 9), "sigkill");
  });

  it("SIGKILL with no OOM counted → 'sigkill' (systemd-oomd, kill -9)", () => {
    const { g } = attached();
    assert.equal(g.exitVerdict("a", 9), "sigkill");
  });

  it("an ordinary exit or another signal with no OOM counted → null", () => {
    const { g } = attached();
    assert.equal(g.exitVerdict("a", undefined, 0), null);
    assert.equal(g.exitVerdict("a", undefined, 1), null);
    assert.equal(g.exitVerdict("a", 15), null);
  });

  it("the poll leaves an agent whose main process is already gone to its exit verdict (no double, wrong report)", () => {
    const { g, bump } = attached();
    bump(1);
    // The kernel killed the leader; node-pty hasn't run onExit yet, so the
    // agent is still "live" to the poll. It's a zombie until reaped.
    writeFileSync(
      join(proc, "500", "stat"),
      `500 (node) Z ${SELF} 500 500 0 -1`,
    );
    assert.deepEqual(g.pollKills(() => true).perAgent, []);
    assert.equal(g.exitVerdict("a", 9), "oom");
  });

  it("a build an agent survives is reported once, for that agent only", () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    addProc(700, SELF);
    setEvents(join(unitDir, "agent-a"), 0);
    setEvents(join(unitDir, "agent-b"), 0);
    g.attach("a", 500, { leader: true });
    g.attach("b", 700, { leader: true });
    setEvents(join(unitDir, "agent-a"), 2);
    assert.deepEqual(g.pollKills(() => true).perAgent, [
      { agentId: "a", kills: 2 },
    ]);
    assert.deepEqual(g.pollKills(() => true).perAgent, []);
  });

  it("isolated: a kill in the SERVER's leaf is reported, unattributed", () => {
    setEvents(join(unitDir, SERVER_LEAF), 0);
    const { g } = guard();
    g.init();
    setEvents(join(unitDir, SERVER_LEAF), 1);
    assert.equal(g.pollKills(() => true).unattributed, 1);
    assert.equal(g.pollKills(() => true).unattributed, 0);
  });

  it("isolated: a released agent's leftovers are still watched", () => {
    const { g, bump } = attached();
    g.release("a", 60_000);
    bump(1);
    assert.equal(g.pollKills(() => true).unattributed, 1);
  });

  it("a failed move into the agent's cgroup is reported for THAT agent, and its verdict doesn't trust the empty cgroup", () => {
    const { g, logs } = guard();
    g.init();
    addProc(500, SELF);
    mkdirSync(join(unitDir, "agent-a", "cgroup.procs"), { recursive: true }); // writes fail (EISDIR)
    g.attach("a", 500, { leader: true });
    addProc(700, SELF);
    mkdirSync(join(unitDir, "agent-b", "cgroup.procs"), { recursive: true });
    g.attach("b", 700, { leader: true });
    const text = logs.join("\n");
    assert.match(text, /agent a \(pid 500\)/);
    assert.match(text, /agent b \(pid 700\)/);
    assert.equal(g.exitVerdict("a", 9), "sigkill");
  });

  it("without per-agent cgroups, an exit claims the unit-level kill → 'oom-likely', and the poll doesn't report it again", () => {
    const { g } = guard({});
    g.init();
    addProc(500, SELF);
    g.attach("a", 500, { leader: true });
    setEvents(unitDir, 1);
    assert.equal(g.pollKills(() => true, 1_000, 5_000).unattributed, 0); // held a cycle
    assert.equal(g.exitVerdict("a", 9), "oom-likely");
    assert.equal(g.pollKills(() => true, 10_000, 5_000).unattributed, 0);
  });

  it("without per-agent cgroups, an unclaimed unit-level kill is reported after a cycle", () => {
    const { g } = guard({});
    g.init();
    setEvents(unitDir, 1);
    assert.equal(g.pollKills(() => true, 1_000, 5_000).unattributed, 0);
    assert.equal(g.pollKills(() => true, 6_000, 5_000).unattributed, 1);
    assert.equal(g.pollKills(() => true, 12_000, 5_000).unattributed, 0);
  });

  it("outside a systemd service (a terminal's scope), unrelated kills aren't reported as ours", () => {
    const scope =
      "/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-x.scope";
    writeFileSync(join(proc, String(SELF), "cgroup"), `0::${scope}\n`);
    mkdirSync(join(cg, scope), { recursive: true });
    writeFileSync(join(cg, scope, "cgroup.procs"), `${SELF}\n`);
    setEvents(join(cg, scope), 0);
    const { g } = guard({});
    g.init();
    setEvents(join(cg, scope), 4);
    assert.equal(g.pollKills(() => true, 1_000, 0).unattributed, 0);
    assert.equal(g.pollKills(() => true, 9_000, 0).unattributed, 0);
  });

  it("release removes the agent's cgroup once it's empty", async () => {
    const { g } = guard();
    g.init();
    addProc(500, SELF);
    g.attach("a", 500, { leader: true });
    rmSync(join(unitDir, "agent-a"), { recursive: true }); // emulate "emptied"
    mkdirSync(join(unitDir, "agent-a"));
    g.release("a", 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(join(unitDir, "agent-a")), false);
  });
});

describe("OomGuard: delegation is all or nothing", () => {
  it("if controllers can't be enabled, every process goes BACK to the unit and the reason is kept", () => {
    rmSync(join(unitDir, "cgroup.subtree_control"));
    mkdirSync(join(unitDir, "cgroup.subtree_control")); // the write fails
    const { g } = guard();
    g.init();
    assert.equal(g.isolated, false);
    assert.ok(g.degradedReason);
    // Moved back: the fake unit's cgroup.procs (it was "100\n101\n") now
    // holds the last pid written back from the leaf. (Real cgroupfs would
    // also let the emptied leaf be removed; a fake dir with files can't.)
    assert.equal(readFileSync(join(unitDir, "cgroup.procs"), "utf-8"), "101");
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
