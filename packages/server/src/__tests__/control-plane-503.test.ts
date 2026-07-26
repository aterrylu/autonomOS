import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
 * reads the env at module load. The spawn dies at buildEnv, which runs after
 * the agent record is written but BEFORE any PTY spawn, so this creates a
 * throwaway record in the temp dir and starts no process.
 */

const TEST_DIR = join(tmpdir(), `aos-503-${randomUUID().slice(0, 8)}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { agentsRouter } = await import("../routes/agents.js");
const { _resetServerStateForTesting, setAuthToken, setServerPort } =
  await import("../serverState.js");

describe("spawn during the boot window returns 503, not 500", () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Port + token are set (public listener is up) but the socket is NOT —
    // exactly the state between `serve()`'s callback and the socket bind.
    setServerPort(53920);
    setAuthToken("test-token-1234567890abcdef");
  });

  after(() => {
    _resetServerStateForTesting();
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
