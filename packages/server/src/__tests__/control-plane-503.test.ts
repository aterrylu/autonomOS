import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The boot-window 503 (ADR-055) — asserted through the real route, not by
 * inspection of the handler.
 *
 * A spawn that arrives before the control socket binds used to surface as an
 * opaque 500 carrying an internal invariant string, which tells a caller
 * nothing about whether retrying helps. It must be a 503 with a stable code
 * and Retry-After, because the condition is transient and clears on its own
 * within a moment of boot.
 *
 * This exercises the whole chain — POST /api/agents → spawnAgent → buildEnv →
 * getInternalSocketPath() throws → the route's local catch re-throws →
 * agentsRouter.onError maps it. Each link is a place the 503 could be lost
 * (most easily by the local catch swallowing it into its generic 500), so the
 * wiring is what's under test, not the error type alone.
 *
 * NOTE: config dir is isolated BEFORE importing the router — configDir.ts
 * reads the env at module load. The spawn dies at buildEnv (runtime.ts:742),
 * which runs before both the record insert (:830) and any PTY spawn, so this
 * persists nothing and starts no process — the temp config dir stays empty.
 */

const TEST_DIR = join(tmpdir(), `aos-503-${randomUUID().slice(0, 8)}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

// HOME is redirected here, at module scope, for the same module-load reason as
// the config dir above, but for a different consumer: providers/shared.ts builds
// BINARY_DIRS — the candidate list resolveBinary() searches — in a top-level
// IIFE that reads HOME once at import. Do NOT move this into before(). The
// `beforeEach(() => { process.env.HOME = tmp })` idiom in
// resume-fresh-fallback.test.ts is correct for its consumer, which reads HOME
// per call, but runs far too late for this one — and the breakage is invisible
// on any box that has a real `claude`.
const PREV_HOME = process.env.HOME;
const TEST_HOME = join(TEST_DIR, "home");
process.env.HOME = TEST_HOME;

const { agentsRouter } = await import("../routes/agents.js");
const { _resetServerStateForTesting, setAuthToken, setServerPort } =
  await import("../serverState.js");
const { getProvider } = await import("../providers/index.js");

describe("spawn during the boot window returns 503, not 500", () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // spawnAgent resolves the provider binary BEFORE it reaches buildEnv, so on
    // a box with no `claude` the spawn dies at resolution with "claude binary
    // not found" — which spawnErrorStatus maps to 404, and the 503 under test is
    // never reached. That made the assertion host-dependent: green wherever a
    // real `claude` exists (dev machines, the PR runner), red where it doesn't
    // (the Version workflow's runner). The stub removes the dependency —
    // `.local/bin` is the first BINARY_DIRS entry, and
    // resolveBinaryFromCandidates only existsSync()s its candidates, never
    // executes them, so an empty file suffices. Written here rather than at
    // module scope to keep filesystem writes out of import. It stays inert only
    // because this spawn dies at buildEnv: with the socket bound, node-pty would
    // fork spawn-helper against a non-executable file and hang.
    const stubBinDir = join(TEST_HOME, ".local", "bin");
    mkdirSync(stubBinDir, { recursive: true });
    writeFileSync(join(stubBinDir, "claude"), "");

    // Enforce the precondition rather than trusting it. Redirecting HOME narrows
    // the candidate list but does NOT isolate resolution: four BINARY_DIRS
    // entries are absolute (/usr/local/bin, /opt/homebrew/bin, /snap/bin,
    // /usr/bin) and the `which` fallback inherits PATH, which HOME never
    // touches. So on any box that has a real claude — every dev machine, and the
    // PR runner, which npm-installs one — deleting this stub or moving the HOME
    // assignment into a hook would leave the test green while quietly restoring
    // the host dependency this file exists to remove. Nothing downstream would
    // catch that: the Version workflow was the only CI run on a claude-less box,
    // and it no longer runs the suite (see version.yml). This assertion is what
    // makes that regression loud, and it names the real cause instead of
    // resurfacing as the 404-vs-503 puzzle that produced this test.
    assert.equal(
      getProvider("claude-code").resolveBinary(),
      join(stubBinDir, "claude"),
      "the stub must be what resolves — otherwise the 503 below is being proven " +
        "against the host's own claude, not this test's fixture",
    );
    // Port + token are set (public listener is up) but the socket is NOT —
    // exactly the state between `serve()`'s callback and the socket bind.
    setServerPort(53920);
    setAuthToken("test-token-1234567890abcdef");
  });

  after(() => {
    _resetServerStateForTesting();
    if (PREV_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = PREV_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("answers 503 with a retryable code and Retry-After", async () => {
    const res = await agentsRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: tmpdir() }),
    });

    assert.equal(
      res.status,
      503,
      "a spawn before the control plane is ready must be 503, not an opaque 500",
    );
    assert.equal(res.headers.get("retry-after"), "1");

    const body = (await res.json()) as {
      error: string;
      code: string;
      retryable: boolean;
    };
    assert.equal(body.code, "CONTROL_PLANE_NOT_READY");
    assert.equal(
      body.retryable,
      true,
      "unlike CACHE_POISONED, this clears on its own — say so",
    );
    assert.match(body.error, /retry/i);
  });
});
