/**
 * Bind-host resolution + the loopback predicate behind the exposure warning.
 *
 * Why this file exists at all: `isLoopbackBind` shipped in #221 WITH a test
 * locking it, and #264 deleted that test as collateral when it removed the
 * endpoint that called it. The helper survived with zero callers and nothing
 * asserting anything about it — a control that looks present and is inert.
 * These tests are attached to the bind logic itself, not to any one endpoint's
 * lifetime, so a future removal can't quietly strand them again.
 *
 * The invariant that matters: THE DEFAULT BIND IS LOOPBACK. Node's listen()
 * with no host binds 0.0.0.0/::, which is how the dashboard — and every agent
 * it can spawn — ended up reachable from any network the machine was on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackBind, resolveBindHost } from "../run.js";

describe("resolveBindHost", () => {
  it("defaults to loopback when neither flag nor env is set", () => {
    // The load-bearing assertion. If this ever returns undefined/""/0.0.0.0,
    // the server is exposed to the network by default.
    assert.equal(resolveBindHost(undefined, undefined), "127.0.0.1");
  });

  it("uses AUTONOMOS_HOST when no flag is given", () => {
    assert.equal(resolveBindHost(undefined, "0.0.0.0"), "0.0.0.0");
  });

  it("prefers the --host flag over AUTONOMOS_HOST", () => {
    assert.equal(resolveBindHost("127.0.0.1", "0.0.0.0"), "127.0.0.1");
  });

  it("falls back to loopback for an empty or whitespace env value", () => {
    // An exported-but-empty env var (HOST=) must not read as "bind everything".
    assert.equal(resolveBindHost(undefined, ""), "127.0.0.1");
    assert.equal(resolveBindHost(undefined, "   "), "127.0.0.1");
  });

  it("trims a padded env value rather than passing it to listen()", () => {
    assert.equal(resolveBindHost(undefined, " 0.0.0.0 "), "0.0.0.0");
  });

  it("peels surrounding quotes from a hand-quoted env value", () => {
    // `tsx --env-file` keeps the quotes: AUTONOMOS_HOST="0.0.0.0" arrives as
    // the literal string "0.0.0.0", which would crash serve() with ENOTFOUND
    // on the very deploy where someone is enabling network exposure.
    assert.equal(resolveBindHost(undefined, '"0.0.0.0"'), "0.0.0.0");
    assert.equal(resolveBindHost(undefined, "'0.0.0.0'"), "0.0.0.0");
    assert.equal(resolveBindHost(undefined, ' "0.0.0.0" '), "0.0.0.0");
  });

  it("peels quotes from a service-file-baked --host arg too", () => {
    assert.equal(resolveBindHost('"127.0.0.1"', undefined), "127.0.0.1");
  });

  it("does not strip a mismatched or single quote character", () => {
    // Only a matched surrounding pair is a quoting artifact; anything else is a
    // genuinely malformed host that should reach serve() and fail loudly, not
    // be silently rewritten into something that happens to bind.
    assert.equal(resolveBindHost(undefined, '"0.0.0.0'), '"0.0.0.0');
    assert.equal(resolveBindHost(undefined, '0.0.0.0"'), '0.0.0.0"');
  });

  it("falls back to loopback when a value is only quotes", () => {
    assert.equal(resolveBindHost(undefined, '""'), "127.0.0.1");
  });
});

describe("isLoopbackBind", () => {
  it("treats loopback spellings as loopback", () => {
    for (const h of ["localhost", "127.0.0.1", "::1"]) {
      assert.equal(isLoopbackBind(h), true, `${h} should be loopback`);
    }
  });

  it("treats an undefined bind host as loopback", () => {
    assert.equal(isLoopbackBind(undefined), true);
  });

  it("treats network-reachable binds as NON-loopback (warning fires)", () => {
    for (const h of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "100.69.245.108", // a tailnet address: reachable, so not loopback
      "forge",
    ]) {
      assert.equal(isLoopbackBind(h), false, `${h} should NOT be loopback`);
    }
  });
});
