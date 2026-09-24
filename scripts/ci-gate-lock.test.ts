import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runGate(
  lock: string,
  cmd: string,
  opts: { timeout?: number } = {},
): { done: Promise<Run>; pid: number } {
  const startedAt = Date.now();
  const child = spawn("bash", [SCRIPT, "bash", "-c", cmd], {
    env: {
      ...process.env,
      AUTONOMOS_CI_GATE_LOCK_PATH: lock,
      AUTONOMOS_CI_GATE_LOCK_TIMEOUT: String(opts.timeout ?? 30),
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
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const done = new Promise<Run>((resolve) =>
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, startedAt, endedAt: Date.now() }),
    ),
  );
  return { done, pid: child.pid ?? -1 };
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

  it("passes the command's output and exit code through", async () => {
    const r = await runGate(join(dir, "a.lock"), "echo hello; exit 3").done;
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), "hello");
    assert.doesNotMatch(r.stderr, /waiting/, "no contention → no waiting notice");
  });

  it("concurrent gates QUEUE: the second runs only after the first releases", async () => {
    const lock = join(dir, "b.lock");
    const release = join(dir, "b.release");
    const a = runGate(lock, holdUntil(release, "A"));
    await waitUntilHeld(lock);
    const b = runGate(lock, "echo B-ran");
    let bDone = false;
    void b.done.then(() => {
      bDone = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bDone, false, "B cannot finish while A holds the lock");
    writeFileSync(release, "");
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.ok(rb.endedAt >= ra.endedAt, "B finished no earlier than A");
    assert.match(rb.stderr, /waiting for another CI gate/);
    assert.match(rb.stdout, /B-ran/);
  });

  it("a killed holder frees the lock at once (no wedged pushes)", async () => {
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

  it("gives up with a clear message after the timeout instead of hanging", async () => {
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

