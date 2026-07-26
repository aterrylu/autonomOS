import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  _resetAgentCredentialsForTesting,
  getAgentToken,
  mintAgentToken,
  revokeAgentToken,
  verifyAgentToken,
} from "../agentCredentials.js";

/**
 * Per-agent credential store (ADR-055 PR B, layer 3).
 *
 * The store is the source of truth the gateway `register` and hook ingest both
 * verify against, so its guarantees are the security contract: idempotent mint
 * (both injection sites get the same token), fail-closed verify (unknown
 * session / missing / wrong all reject), and revoke-on-exit.
 */

afterEach(() => {
  _resetAgentCredentialsForTesting();
});

describe("agent credentials", () => {
  it("mints a token and verifies it", () => {
    const t = mintAgentToken("sess-a");
    assert.ok(t.length >= 32, "token should be substantial");
    assert.ok(verifyAgentToken("sess-a", t));
  });

  it("is idempotent per session — both injection sites get the same token", () => {
    // buildEnv (hook curl) and buildArgs (gateway register) each call mint for
    // the same session and MUST agree, in whichever order they run.
    const first = mintAgentToken("sess-b");
    const second = mintAgentToken("sess-b");
    assert.equal(first, second);
  });

  it("mints distinct tokens for distinct sessions", () => {
    assert.notEqual(mintAgentToken("sess-c"), mintAgentToken("sess-d"));
  });

  it("fails closed: unknown session", () => {
    assert.equal(verifyAgentToken("never-minted", "anything"), false);
  });

  it("fails closed: missing / empty presented token", () => {
    mintAgentToken("sess-e");
    assert.equal(verifyAgentToken("sess-e", undefined), false);
    assert.equal(verifyAgentToken("sess-e", null), false);
    assert.equal(verifyAgentToken("sess-e", ""), false);
  });

  it("fails closed: wrong token", () => {
    mintAgentToken("sess-f");
    assert.equal(verifyAgentToken("sess-f", "wrong"), false);
  });

  it("length-mismatched token does not throw (timingSafeEqual guard)", () => {
    const t = mintAgentToken("sess-g");
    // A shorter/longer candidate must return false, not throw — timingSafeEqual
    // requires equal-length buffers, so the length pre-check matters.
    assert.equal(verifyAgentToken("sess-g", `${t}extra`), false);
    assert.equal(verifyAgentToken("sess-g", t.slice(0, 10)), false);
  });

  it("revoke drops the token — a dead session can't be replayed", () => {
    const t = mintAgentToken("sess-h");
    assert.ok(verifyAgentToken("sess-h", t));
    revokeAgentToken("sess-h");
    assert.equal(verifyAgentToken("sess-h", t), false);
    assert.equal(getAgentToken("sess-h"), undefined);
  });

  it("re-mint after revoke yields a fresh token (resume path)", () => {
    const before = mintAgentToken("sess-i");
    revokeAgentToken("sess-i");
    const after = mintAgentToken("sess-i");
    assert.notEqual(before, after);
    assert.equal(verifyAgentToken("sess-i", before), false);
    assert.ok(verifyAgentToken("sess-i", after));
  });
});
