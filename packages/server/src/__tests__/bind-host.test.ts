/**
 * Bind-host resolution + the loopback predicate behind the exposure note.
 *
 * Why this file exists at all: `isLoopbackBind` shipped in #221 WITH a test
 * locking it, and #264 deleted that test as collateral when it removed the
 * endpoint that called it. The helper survived with zero callers and nothing
 * asserting anything about it — a control that looks present and is inert.
 * These tests are attached to the bind logic itself, not to any one endpoint's
 * lifetime, so a future removal can't quietly strand them again.
 *
 * The invariant that matters: unset → `undefined` → the caller passes that to
 * serve(), which binds all interfaces (the server's long-standing behavior).
 * The RCE this used to enable is closed by requiring auth on /mcp, NOT by the
 * bind. The flag is an opt-in to RESTRICT to loopback, never to expose.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackBind, resolveBindHost } from "../run.js";

describe("resolveBindHost", () => {
  it("returns undefined when neither flag nor env is set (Node default: all interfaces)", () => {
    // Undefined → serve() binds `::` dual-stack, exactly as before this flag
    // existed. Deliberately NOT a loopback default: remote deploys reached over
    // Tailscale/IAP/SSH need a network interface, and auth closes the RCE.
    assert.equal(resolveBindHost(undefined, undefined), undefined);
  });

  it("uses AUTONOMOS_HOST to RESTRICT when no flag is given", () => {
    assert.equal(resolveBindHost(undefined, "127.0.0.1"), "127.0.0.1");
  });

  it("prefers the --host flag over AUTONOMOS_HOST", () => {
    assert.equal(resolveBindHost("127.0.0.1", "0.0.0.0"), "127.0.0.1");
  });

  it("treats an empty or whitespace env value as unset (undefined)", () => {
    // An exported-but-empty env var (AUTONOMOS_HOST=) must not become a literal
    // "" host — it means "not set", i.e. the Node default.
    assert.equal(resolveBindHost(undefined, ""), undefined);
    assert.equal(resolveBindHost(undefined, "   "), undefined);
  });

  it("trims a padded value rather than passing it to listen()", () => {
    assert.equal(resolveBindHost(undefined, " 127.0.0.1 "), "127.0.0.1");
  });

  it("peels surrounding quotes from a hand-quoted value", () => {
    // `tsx --env-file` keeps the quotes: AUTONOMOS_HOST="127.0.0.1" arrives as
    // the literal string "127.0.0.1", which would crash serve() with ENOTFOUND.
    assert.equal(resolveBindHost(undefined, '"127.0.0.1"'), "127.0.0.1");
    assert.equal(resolveBindHost(undefined, "'127.0.0.1'"), "127.0.0.1");
    assert.equal(resolveBindHost(undefined, ' "127.0.0.1" '), "127.0.0.1");
  });

  it("peels quotes from a service-file-baked --host arg too", () => {
    assert.equal(resolveBindHost('"0.0.0.0"', undefined), "0.0.0.0");
  });

  it("does not strip a mismatched or single quote character", () => {
    // Only a matched surrounding pair is a quoting artifact; anything else is a
    // genuinely malformed host that should reach serve() and fail loudly, not
    // be silently rewritten into something that happens to bind.
    assert.equal(resolveBindHost(undefined, '"127.0.0.1'), '"127.0.0.1');
    assert.equal(resolveBindHost(undefined, '127.0.0.1"'), '127.0.0.1"');
  });

  it("treats a value that is only quotes as unset (undefined)", () => {
    assert.equal(resolveBindHost(undefined, '""'), undefined);
  });
});

describe("isLoopbackBind", () => {
  it("treats loopback spellings as loopback (restricted → note is silent)", () => {
    for (const h of ["localhost", "127.0.0.1", "::1"]) {
      assert.equal(isLoopbackBind(h), true, `${h} should be loopback`);
    }
  });

  it("treats undefined (all-interfaces default) as NON-loopback (note fires)", () => {
    // The old code defaulted undefined→localhost, which is the bug that made the
    // exemptions look safe. Undefined means all-interfaces; say so.
    assert.equal(isLoopbackBind(undefined), false);
  });

  it("treats network-reachable binds as NON-loopback (note fires)", () => {
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
