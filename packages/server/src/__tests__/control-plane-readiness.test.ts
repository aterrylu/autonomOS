import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { buildBaseEnv } from "../providers/shared.js";
import {
  _resetServerStateForTesting,
  assertControlPlaneReady,
  ControlPlaneNotReadyError,
  getInternalSocketPath,
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "../serverState.js";

/**
 * The boot window (ADR-055).
 *
 * The public HTTP listener answers BEFORE the internal control socket binds:
 * it binds first, then pid-file arbitration runs, then the socket binds (see
 * run.ts armRuntimeInits). A spawn arriving in that gap would otherwise build
 * an agent env whose hook relay points at a socket that does not exist —
 * and hook curls are `-sf >/dev/null 2>&1`, so that agent's telemetry would
 * vanish silently.
 *
 * The contract pinned here: reaching for the socket before it is bound raises
 * a TYPED, transient error rather than an untyped invariant string. The typing
 * is the load-bearing part — routes/agents.ts keys its 503 + Retry-After off
 * `instanceof`, so a regression to a plain Error would silently downgrade the
 * response to an opaque 500 and tell a retryable caller nothing.
 */

afterEach(() => {
  _resetServerStateForTesting();
});

describe("control plane readiness", () => {
  it("throws a typed, coded error before the socket binds", () => {
    setServerPort(53919);

    assert.throws(
      () => getInternalSocketPath(),
      (err: unknown) => {
        assert.ok(
          err instanceof ControlPlaneNotReadyError,
          "must be typed — routes/agents.ts onError matches on instanceof",
        );
        assert.equal(err.code, "CONTROL_PLANE_NOT_READY");
        // The message reaches the API client verbatim, so it has to say what
        // to do, not just what went wrong.
        assert.match(err.message, /retry/i);
        return true;
      },
    );
  });

  // buildBaseEnv is the funnel EVERY spawn path goes through (POST /api/agents,
  // /:id/attach, and any future one), which is why the guard lives here rather
  // than being re-implemented per route.
  it("propagates out of buildBaseEnv so every spawn path is covered", () => {
    setServerPort(53919);
    setAuthToken("test-token-1234567890abcdef");

    assert.throws(
      () => buildBaseEnv("session-id", "Agent1"),
      ControlPlaneNotReadyError,
      "a spawn in the boot window must fail loudly, not emit an empty socket path",
    );
  });

  it("stops throwing once the socket is bound", () => {
    setServerPort(53919);
    setAuthToken("test-token-1234567890abcdef");
    setInternalSocketPath("/tmp/aos-test/control.sock");

    assert.equal(getInternalSocketPath(), "/tmp/aos-test/control.sock");
    const env = buildBaseEnv("session-id", "Agent1");
    assert.equal(env.AUTONOMOS_INTERNAL_SOCKET, "/tmp/aos-test/control.sock");
  });

  // restart-all can't ride the buildBaseEnv funnel: its per-agent catch
  // swallows respawn failures into `failures[]` and marks those agents
  // "crashed". So it asserts readiness up front, BEFORE the kill pass — a late
  // throw would either report "crashed" for "still starting", or abort
  // mid-loop and strand already-killed agents as status:"running" zombies.
  it("assertControlPlaneReady throws before the socket binds", () => {
    setServerPort(53919);
    assert.throws(() => assertControlPlaneReady(), ControlPlaneNotReadyError);
  });

  it("assertControlPlaneReady passes once bound", () => {
    setServerPort(53919);
    setInternalSocketPath("/tmp/aos-test/control.sock");
    assert.doesNotThrow(() => assertControlPlaneReady());
  });

  // The window is transient by nature; a readiness signal that never cleared
  // would be worse than the 500 it replaced.
  it("is not sticky — a reset-then-bind recovers", () => {
    setServerPort(53919);
    assert.throws(() => getInternalSocketPath(), ControlPlaneNotReadyError);
    setInternalSocketPath("/tmp/aos-test/control.sock");
    assert.doesNotThrow(() => getInternalSocketPath());
  });
});
