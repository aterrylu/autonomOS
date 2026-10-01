/**
 * terminatePty — group escalation that no agent CLI survives, and that never
 * signals after the PTY has exited.
 *
 * Real PTYs running node stubs shaped like the measured CLIs:
 *  - "gemini": a wrapper that ignores SIGHUP and relaunches a child that does
 *    not — `pty.kill()` (leader-only SIGHUP) left both alive.
 *  - "stubborn": ignores SIGHUP and SIGTERM, with a grandchild that does too —
 *    only the SIGKILL stage ends it.
 *  - "polite": exits on SIGHUP — the escalation must stop there.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { type IPty, spawn } from "node-pty";
import {
  awaitPtyExits,
  type EscalationTimers,
  PTY_KILL_AFTER_MS,
  PTY_TERM_AFTER_MS,
  terminatePty,
} from "../agents/ptyTerminate.js";

const IGNORE = (sigs: string[]) =>
  sigs.map((s) => `process.on(${JSON.stringify(s)}, () => {});`).join(" ");
const IDLE = "setInterval(() => {}, 1000);";
// A child that announces itself on the PTY ("CHILD_READY") once it runs, so a
// test waits for it instead of sleeping and hoping it started.
const CHILD = (body: string) =>
  `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`console.log("CHILD_READY"); ${body}`)}], { stdio: ["ignore", "inherit", "ignore"] });`;

const STUBS = {
  // Wrapper ignores SIGHUP; its child does not. Mirrors gemini.
  gemini: `${IGNORE(["SIGHUP"])} const c = ${CHILD(IDLE).slice(0, -1)}; c.on("exit", () => process.exit(0)); console.log("READY"); ${IDLE}`,
  stubborn: `${IGNORE(["SIGHUP", "SIGTERM"])} ${CHILD(`${IGNORE(["SIGHUP", "SIGTERM"])} ${IDLE}`)} console.log("READY"); ${IDLE}`,
  polite: `console.log("READY"); ${IDLE}`,
};

// Every PTY a test starts, so a failing (or mutation-tested) case can't leak
// its process group or hold the runner open.
const started: IPty[] = [];
afterEach(() => {
  for (const pty of started.splice(0)) {
    try {
      process.kill(-pty.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/** Generous but bounded: a loaded CI box can take seconds to start a node. */
const READY_WITHIN_MS = 20_000;

/**
 * Escalation timers a test fires on cue (ptyTerminate's `timers` seam): no
 * stage depends on how fast a loaded box runs. `fire(ms)` runs the stages
 * scheduled at that delay that haven't been cleared.
 */
function virtualTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: EscalationTimers = {
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      scheduled.push(t);
      return t;
    },
    clear: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  };
  return {
    timers,
    live: () => scheduled.filter((t) => !t.cleared).map((t) => t.ms),
    fire: (ms: number) => {
      for (const t of scheduled) if (t.ms === ms && !t.cleared) t.fn();
    },
  };
}

async function start(body: string): Promise<IPty> {
  const pty = spawn(process.execPath, ["-e", body], {
    name: "xterm",
    cols: 80,
    rows: 24,
    env: process.env as Record<string, string>,
  });
  started.push(pty);
  // Every process the stub starts says so: the leader "READY", each child
  // "CHILD_READY". Wait for all of them, never a fixed sleep.
  const children = (body.match(/CHILD_READY/g) ?? []).length;
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const t = setTimeout(
      () => reject(new Error(`stub never became ready: ${out.slice(-200)}`)),
      READY_WITHIN_MS,
    );
    const sub = pty.onData((d) => {
      out += d;
      const leader = out.replaceAll("CHILD_READY", "").includes("READY");
      const kids = (out.match(/CHILD_READY/g) ?? []).length;
      if (leader && kids >= children) {
        clearTimeout(t);
        sub.dispose();
        resolve();
      }
    });
  });
  return pty;
}

function group(pgid: number): number[] {
  return execFileSync("ps", ["-axo", "pid=,pgid="])
    .toString()
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([, g]) => g === pgid)
    .map(([p]) => p);
}

async function groupEmpty(
  pgid: number,
  withinMs = READY_WITHIN_MS,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < withinMs) {
    if (group(pgid).length === 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return group(pgid).length === 0;
}

// A hang guard for the WHOLE suite (node:test applies a describe timeout to
// the suite, not per test): several cases deliberately wait out the 2s SIGKILL.
describe("terminatePty", { timeout: 180_000 }, () => {
  it("ends a gemini-shaped wrapper that leader-only SIGHUP cannot", async () => {
    const pty = await start(STUBS.gemini);
    assert.equal(group(pty.pid).length, 2, "precondition: wrapper + child");

    // The old behavior, for contrast: leader-only SIGHUP leaves both alive.
    pty.kill();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(group(pty.pid).length, 2, "leader-only SIGHUP was enough?");

    // Virtual timers: no SIGTERM/SIGKILL stage can fire on its own, so ending
    // proves the group SIGHUP did it — however slow the box is.
    const clock = virtualTimers();
    const sent: NodeJS.Signals[] = [];
    await terminatePty(pty, {
      timers: clock.timers,
      signal: (pid, sig) => {
        sent.push(sig);
        process.kill(pid, sig);
      },
    });
    assert.deepEqual(sent, ["SIGHUP"], "the group SIGHUP stage ended it");
    assert.ok(await groupEmpty(pty.pid));
  });

  it("escalates to SIGKILL for a group that ignores SIGHUP and SIGTERM", async () => {
    const pty = await start(STUBS.stubborn);
    assert.equal(group(pty.pid).length, 2, "precondition: leader + grandchild");
    const clock = virtualTimers();
    const sent: NodeJS.Signals[] = [];
    let exited = false;
    const done = terminatePty(pty, {
      timers: clock.timers,
      signal: (pid, sig) => {
        sent.push(sig);
        process.kill(pid, sig);
      },
    }).then(() => {
      exited = true;
    });
    clock.fire(PTY_TERM_AFTER_MS); // SIGTERM stage
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(exited, false, "it ignores SIGHUP and SIGTERM: still alive");
    clock.fire(PTY_KILL_AFTER_MS); // SIGKILL stage
    await done;
    assert.deepEqual(sent, ["SIGHUP", "SIGTERM", "SIGKILL"]);
    assert.ok(await groupEmpty(pty.pid), "the grandchild outlived the kill");
  });

  it("stops escalating once the PTY exits — nothing is signalled after exit", async () => {
    const pty = await start(STUBS.polite);
    const sent: NodeJS.Signals[] = [];
    const clock = virtualTimers();
    await terminatePty(pty, {
      timers: clock.timers,
      signal: (pid, sig) => {
        sent.push(sig);
        process.kill(pid, sig);
      },
    });
    // The exit must have CLEARED both stages: none is left to fire at a pid
    // that may already belong to someone else.
    assert.deepEqual(clock.live(), [], "a stage survived the exit");
    for (const ms of [PTY_TERM_AFTER_MS, PTY_KILL_AFTER_MS]) clock.fire(ms);
    assert.deepEqual(sent, ["SIGHUP"]);
  });

  it("a gone group (ESRCH) ends the escalation — the bare pid is NEVER signalled", async () => {
    // node-pty reaps the leader up to ~200ms before emitting exit; in that
    // window the group signal fails ESRCH, and a fallback to the bare pid could
    // reach a reused one. Simulate the gone group and prove nothing follows.
    const pty = await start(STUBS.polite);
    const targets: number[] = [];
    const exited = terminatePty(pty, {
      termAfterMs: 50,
      killAfterMs: 100,
      signal: (pid) => {
        targets.push(pid);
        throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      },
    });
    await new Promise((r) => setTimeout(r, 300)); // past both stages
    assert.deepEqual(targets, [-pty.pid], "signalled again after ESRCH");
    process.kill(pty.pid, "SIGKILL"); // let the PTY settle
    await exited;
  });

  it("reports group members that outlive the leader by command name", async () => {
    // Leader dies to SIGHUP; its child ignores SIGHUP and stays in the group.
    const pty = await start(
      `${CHILD(`${IGNORE(["SIGHUP"])} ${IDLE}`)} console.log("READY"); ${IDLE}`,
    );
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warnings.push(a.join(" "));
    };
    try {
      await terminatePty(pty, { label: "demo [fake] (00000000)" });
      const t0 = Date.now();
      while (warnings.length === 0 && Date.now() - t0 < READY_WITHIN_MS) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      console.warn = orig;
    }
    const line = warnings.find((w) => w.includes("outlived it"));
    assert.ok(line, `no straggler warning: ${warnings.join(" | ")}`);
    assert.match(line, /demo \[fake\] \(00000000\)/);
    assert.match(line, /1 process\(es\).*\(node\)/);
    assert.doesNotMatch(line, /setInterval|-e/, "args leaked into the log");
  });
  it("is idempotent per PTY — a second call adds no escalation", async () => {
    const pty = await start(STUBS.polite);
    const sent: NodeJS.Signals[] = [];
    const signal = (pid: number, sig: NodeJS.Signals) => {
      sent.push(sig);
      process.kill(pid, sig);
    };
    const clock = virtualTimers();
    const first = terminatePty(pty, { signal, timers: clock.timers });
    assert.equal(terminatePty(pty, { signal, timers: clock.timers }), first);
    await first;
    assert.deepEqual(sent, ["SIGHUP"]);
    assert.deepEqual(clock.live(), [], "one escalation, cleared on exit");
  });

  it("awaitPtyExits waits for every PTY being terminated, bounded", async () => {
    const stubborn = await start(STUBS.stubborn);
    const clock = virtualTimers();
    void terminatePty(stubborn, { timers: clock.timers });
    // No SIGKILL until we fire it: still alive at the cap, however slow the box.
    assert.deepEqual(await awaitPtyExits(100), [`pid ${stubborn.pid}`]);
    clock.fire(PTY_KILL_AFTER_MS);
    // After it: gone (bounded generously for a loaded box).
    assert.deepEqual(await awaitPtyExits(READY_WITHIN_MS), []);
  });
});
