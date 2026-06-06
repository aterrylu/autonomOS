import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetServerStateForTesting,
  getAuthToken,
  getServerPort,
  setAuthToken,
  setServerPort,
} from "../serverState.js";

/**
 * Regression coverage for the Built-in (embedded) mode bug where the server
 * bound to an OS-assigned port (--port=0) but spawned Claude Code sessions
 * read `process.env.PORT || "3000"` to compute their hook + MCP-gateway URLs.
 *
 * The fix routes both port and auth-token discovery through this module so
 * spawn-time code sees the actual bound port + the in-process token, not env.
 */

describe("serverState", () => {
  afterEach(() => _resetServerStateForTesting());

  describe("setServerPort / getServerPort", () => {
    it("round-trips an integer port", () => {
      setServerPort(53917);
      assert.equal(getServerPort(), 53917);
    });

    it("accepts the documented edge ports (1, 65535)", () => {
      setServerPort(1);
      assert.equal(getServerPort(), 1);
      setServerPort(65535);
      assert.equal(getServerPort(), 65535);
    });

    it("rejects non-integers, negatives, zero, and out-of-range", () => {
      assert.throws(() => setServerPort(0), /invalid port/);
      assert.throws(() => setServerPort(-1), /invalid port/);
      assert.throws(() => setServerPort(65536), /invalid port/);
      assert.throws(() => setServerPort(3.14 as number), /invalid port/);
      assert.throws(() => setServerPort(Number.NaN as number), /invalid port/);
    });

    it("throws when read before set — surfacing the boot-ordering bug loudly", () => {
      assert.throws(() => getServerPort(), /called before setServerPort/);
    });

    it("subsequent sets overwrite — supports test reset / restart flows", () => {
      setServerPort(3101);
      setServerPort(7777);
      assert.equal(getServerPort(), 7777);
    });
  });

  describe("setAuthToken / getAuthToken", () => {
    it("round-trips a token", () => {
      setAuthToken("abcdef1234567890");
      assert.equal(getAuthToken(), "abcdef1234567890");
    });

    it("rejects empty / falsy tokens — guards against silent miswiring", () => {
      assert.throws(() => setAuthToken(""), /non-empty/);
    });

    it("throws when read before set", () => {
      assert.throws(() => getAuthToken(), /called before setAuthToken/);
    });
  });

  describe("_resetServerStateForTesting", () => {
    it("returns the module to its pristine state", () => {
      setServerPort(1234);
      setAuthToken("hello");
      _resetServerStateForTesting();
      assert.throws(() => getServerPort());
      assert.throws(() => getAuthToken());
    });
  });
});
