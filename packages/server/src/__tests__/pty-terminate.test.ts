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
  PTY_KILL_AFTER_MS,
  PTY_TERM_AFTER_MS,
  terminatePty,
} from "../agents/ptyTerminate.js";

const IGNORE = (sigs: string[]) =>
  sigs.map((s) => `process.on(${JSON.stringify(s)}, () => {});`).join(" ");
const IDLE = "setInterval(() => {}, 1000);";
const CHILD = (body: string) =>
  `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(body)}], { stdio: "ignore" });`;

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

async function start(body: string): Promise<IPty> {
  const pty = spawn(process.execPath, ["-e", body], {
    name: "xterm",
    cols: 80,
    rows: 24,
    env: process.env as Record<string, string>,
  });
  started.push(pty);
  await new Promise<void>((resolve) => {
    const sub = pty.onData((d) => {
      if (d.includes("READY")) {
        sub.dispose();
        resolve();
      }
    });
  });
  // Let a relaunched child finish starting.
  await new Promise((r) => setTimeout(r, 150));
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

async function groupEmpty(pgid: number, withinMs = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < withinMs) {
    if (group(pgid).length === 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return group(pgid).length === 0;
}

describe("terminatePty", { timeout: 10_000 }, () => {
  it("ends a gemini-shaped wrapper that leader-only SIGHUP cannot", async () => {
    const pty = await start(STUBS.gemini);
    assert.equal(group(pty.pid).length, 2, "precondition: wrapper + child");

    // The old behavior, for contrast: leader-only SIGHUP leaves both alive.
    pty.kill();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(group(pty.pid).length, 2, "leader-only SIGHUP was enough?");

    const t0 = Date.now();
    await terminatePty(pty);
    assert.ok(
      Date.now() - t0 < PTY_TERM_AFTER_MS,
      "the group SIGHUP stage ended it",
    );
    assert.ok(await groupEmpty(pty.pid));
  });

  it("escalates to SIGKILL for a group that ignores SIGHUP and SIGTERM", async () => {
    const pty = await start(STUBS.stubborn);
    assert.equal(group(pty.pid).length, 2, "precondition: leader + grandchild");
    const t0 = Date.now();
    await terminatePty(pty);
    assert.ok(
      Date.now() - t0 >= PTY_KILL_AFTER_MS - 50,
      "ended before SIGKILL?",
    );
    assert.ok(await groupEmpty(pty.pid), "the grandchild outlived the kill");
  });

  it("stops escalating once the PTY exits — nothing is signalled after exit", async () => {
    const pty = await start(STUBS.polite);
    const sent: NodeJS.Signals[] = [];
    await terminatePty(pty, {
      signal: (pid, sig) => {
        sent.push(sig);
        process.kill(pid, sig);
      },
    });
    // Outlast both escalation timers: had either survived the exit, it would
    // have fired by now — at a pid that may already belong to someone else.
    await new Promise((r) => setTimeout(r, PTY_KILL_AFTER_MS + 200));
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
      while (warnings.length === 0 && Date.now() - t0 < 2_000) {
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
    const first = terminatePty(pty, { signal });
    assert.equal(terminatePty(pty, { signal }), first);
    await first;
    assert.deepEqual(sent, ["SIGHUP"]);
  });

  it("awaitPtyExits waits for every PTY being terminated, bounded", async () => {
    const stubborn = await start(STUBS.stubborn);
    void terminatePty(stubborn);
    // Below the SIGKILL stage: still alive at the cap.
    assert.deepEqual(await awaitPtyExits(100), [`pid ${stubborn.pid}`]);
    // Past it: gone.
    assert.deepEqual(await awaitPtyExits(PTY_KILL_AFTER_MS + 1_000), []);
  });
});
