import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

/**
 * scripts/ci-gate-lock.sh — the machine-wide lock around the pre-push gate.
 * Each test uses its own lock file under a temp dir, never the real
 * /tmp/autonomos-ci-gate.lock, so a real push on this box is never blocked.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ci-gate-lock.sh");
const hasTool = ["flock", "lockf"].some((t) => {
  try {
    execFileSync("sh", ["-c", `command -v ${t}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

// The ancestor check needs lsof; without it the script deliberately trusts
// the marker (see ci-gate-lock.sh), so the "only OUR holder" test can't hold.
const hasLsof = (() => {
  try {
    execFileSync("sh", ["-c", "command -v lsof"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Per test, not just per file: a hang must FAIL that test by name. A file-level
// timeout kills the file before it reports, so CI said only "ci-gate-lock.test.ts
// timed out after 300000ms" with no hint which test hung (twice, 10-08).
// Generous: the slowest real test (hung holder) needs ~2s bound + ≤10s grace.
const PER_TEST_MS = 60_000;

/** Every gate still running, so after() can reap stragglers (a failed or
 *  mutated run must not leak lock holders). */
const live = new Set<number>();

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number;
}

interface Gate {
  done: Promise<Run>;
  pid: number;
  /** Resolves once the gate's stderr matches `re`; rejects if the gate exits
   *  first (so a gate that never queues fails fast, by name). */
  stderrMatches(re: RegExp): Promise<void>;
}

function runGate(
  lock: string,
  cmd: string,
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Gate {
  const startedAt = Date.now();
  const child = spawn("bash", [SCRIPT, "bash", "-c", cmd], {
    env: {
      ...process.env,
      AUTONOMOS_CI_GATE_LOCK_PATH: lock,
      AUTONOMOS_CI_GATE_LOCK_TIMEOUT: String(opts.timeout ?? 30),
      ...opts.env,
    },
    // Own process group, so after() can reap the whole gate.
    detached: true,
  });
  if (child.pid) live.add(child.pid);
  child.on("close", () => {
    if (child.pid) live.delete(child.pid);
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  const watchers = new Set<() => void>();
  child.stderr.on("data", (d) => {
    stderr += d;
    for (const w of watchers) w();
  });
  const done = new Promise<Run>((resolve) =>
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, startedAt, endedAt: Date.now() }),
    ),
  );
  const stderrMatches = (re: RegExp) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!re.test(stderr)) return;
        watchers.delete(check);
        resolve();
      };
      watchers.add(check);
      check();
      void done.then((r) =>
        reject(new Error(`gate exited (${r.code}) before stderr matched ${re}: ${r.stderr}`)),
      );
    });
  return { done, pid: child.pid ?? -1, stderrMatches };
}

const QUEUED = /waiting for another CI gate/;

/** An env whose lock tool starts `secs` late: a gate on a loaded box, where
 *  bash startup + the probe can take longer than any fixed sleep. Forces the
 *  window a timing-based test loses (10-29: a fixed 500ms failed at load 7). */
function slowLockTool(dir: string, secs = 1): NodeJS.ProcessEnv {
  const shimDir = join(dir, "slow-bin");
  mkdirSync(shimDir, { recursive: true });
  for (const tool of ["flock", "lockf"]) {
    let real = "";
    try {
      real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    } catch {
      continue;
    }
    const shim = join(shimDir, tool);
    writeFileSync(shim, `#!/bin/sh\nsleep ${secs}\nexec '${real}' "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return { PATH: `${shimDir}:${process.env.PATH ?? ""}` };
}

/** A gate command that holds the lock until `releaseFile` exists: the test
 *  decides when the holder finishes, so no assertion depends on timing. */
const holdUntil = (releaseFile: string, name: string) =>
  // Bounded (60s): a holder must never outlive a failed or aborted test.
  `echo ${name}-start; for _ in $(seq 1 1200); do [ -e '${releaseFile}' ] && break; sleep 0.05; done; echo ${name}-end`;

/** Resolves once some gate provably holds `lock` (a zero-timeout probe is busy). */
async function waitUntilHeld(lock: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const probe = await runGate(lock, "true", { timeout: 0 }).done;
    if (probe.code === 75) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing took ${lock}`);
}

describe("ci-gate-lock.sh", { skip: !hasTool && "no flock/lockf on this box" }, () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-gate-lock-"));
  });
  after(() => {
    for (const pid of live) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the command's output and exit code through", { timeout: PER_TEST_MS }, async () => {
    const r = await runGate(join(dir, "a.lock"), "echo hello; exit 3").done;
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), "hello");
    assert.doesNotMatch(r.stderr, /waiting/, "no contention → no waiting notice");
  });

  it("the command runs knowing which lock it holds", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "held.lock");
    const r = await runGate(lock, 'echo "$AUTONOMOS_GATE_LOCK_HELD"').done;
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), lock);
  });

  it("re-entrant: a nested call for the SAME lock runs at once (the gate's make check)", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "nested.lock");
    // Inner gate with a 2s timeout: without re-entrancy it would wait on its
    // own holder, give up (75) and fail.
    const r = await runGate(
      lock,
      `bash '${SCRIPT}' bash -c 'echo inner-ran'`,
      { timeout: 2 },
    ).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "inner-ran");
    assert.doesNotMatch(r.stderr, /waiting/);
  });

  it("a held-marker only passes through for OUR holder, not someone else's", {
    timeout: PER_TEST_MS,
    skip: !hasLsof && "no lsof: the script trusts the marker by design",
  }, async () => {
    const lock = join(dir, "stale.lock");
    const releaseH = join(dir, "stale.releaseH");
    // H: an unrelated gate holding the lock (another agent's push).
    const h = runGate(lock, holdUntil(releaseH, "H"));
    await waitUntilHeld(lock);
    // A carries a marker naming this lock (inherited, stale). The lock IS
    // busy, but not by A's ancestor: A must queue, never run alongside H.
    // A starts slow on purpose; H is released only once A has provably queued.
    const a = runGate(lock, "echo A-ran", {
      env: { AUTONOMOS_GATE_LOCK_HELD: lock, ...slowLockTool(dir) },
    });
    await a.stderrMatches(QUEUED);
    writeFileSync(releaseH, "");
    const [rh, ra] = await Promise.all([h.done, a.done]);
    assert.equal(rh.code, 0);
    assert.equal(ra.code, 0, ra.stderr);
    assert.match(ra.stderr, QUEUED, "A must queue");
    assert.ok(ra.endedAt >= rh.endedAt, "A ran only after H released");
  });

  it("a HUNG holder is stopped at the run bound and the next gate proceeds", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "hung.lock");
    // The holder never finishes (a runner kept alive by a leaked handle).
    const h = runGate(lock, "sleep 600", {
      env: { AUTONOMOS_CI_GATE_RUN_TIMEOUT: "2" },
    });
    await waitUntilHeld(lock);
    const b = runGate(lock, "echo B-ran");
    const [rh, rb] = await Promise.all([h.done, b.done]);
    assert.equal(rh.code, 124, rh.stderr);
    assert.match(rh.stderr, /exceeded 2s/);
    assert.equal(rb.code, 0, rb.stderr);
    assert.equal(rb.stdout.trim(), "B-ran");
    assert.ok(rb.endedAt >= rh.endedAt, "B ran once the hung holder was stopped");
  });

  it("an unusable lock exports an 'unlocked' marker (fleet tests refuse on it)", { timeout: PER_TEST_MS }, async () => {
    const r = await runGate(
      join(dir, "no-such-dir", "y.lock"),
      'echo "held=$AUTONOMOS_GATE_LOCK_HELD"',
    ).done;
    assert.equal(r.stdout.trim(), "held=unlocked");
  });

  it("an unusable lock file never blocks the push: it runs unlocked, with a warning", { timeout: PER_TEST_MS }, async () => {
    const r = await runGate(
      join(dir, "no-such-dir", "x.lock"),
      "echo gate-ran; exit 4",
    ).done;
    assert.equal(r.code, 4, "the gate's own exit code, not the lock tool's");
    assert.equal(r.stdout.trim(), "gate-ran");
    assert.match(r.stderr, /cannot use the lock file .*running WITHOUT/);
  });

  it("concurrent gates QUEUE: the second runs only after the first releases", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "b.lock");
    const release = join(dir, "b.release");
    const a = runGate(lock, holdUntil(release, "A"));
    await waitUntilHeld(lock);
    const b = runGate(lock, "echo B-ran", { env: slowLockTool(dir) });
    let bDone = false;
    void b.done.then(() => {
      bDone = true;
    });
    await b.stderrMatches(QUEUED);
    assert.equal(bDone, false, "B cannot finish while A holds the lock");
    writeFileSync(release, "");
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.ok(rb.endedAt >= ra.endedAt, "B finished no earlier than A");
    assert.match(rb.stderr, QUEUED);
    assert.match(rb.stdout, /B-ran/);
  });

  it("a killed holder frees the lock at once (no wedged pushes)", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "c.lock");
    const a = runGate(lock, holdUntil(join(dir, "c.never"), "A"));
    await waitUntilHeld(lock);
    process.kill(-a.pid, "SIGKILL"); // the whole gate process group, like a crash
    await a.done;
    // A 5s budget, while A would have held forever: success here can only
    // mean the kernel released the lock when A died.
    const b = await runGate(lock, "echo acquired", { timeout: 5 }).done;
    assert.equal(b.code, 0, `B acquired after the crash: ${b.stderr}`);
    assert.equal(b.stdout.trim(), "acquired");
  });

  it("gives up with a clear message after the timeout instead of hanging", { timeout: PER_TEST_MS }, async () => {
    const lock = join(dir, "d.lock");
    const release = join(dir, "d.release");
    const a = runGate(lock, holdUntil(release, "A"));
    await waitUntilHeld(lock);
    const b = await runGate(lock, "echo should-not-run", { timeout: 1 }).done;
    writeFileSync(release, "");
    await a.done;
    assert.equal(b.code, 75, "EX_TEMPFAIL");
    assert.doesNotMatch(b.stdout, /should-not-run/);
    assert.match(b.stderr, /gave up after 1s waiting for the CI gate lock/);
  });
});

