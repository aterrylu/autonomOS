import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  _resetAgentCredentialsForTesting,
  agentTokenFilePath,
  getAgentToken,
  mintAgentToken,
  revokeAgentToken,
  verifyAgentToken,
  writeAgentTokenFile,
} from "../agentCredentials.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

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

/**
 * Per-session token FILE (ADR-055 follow-up) — the channel-server's delivery
 * path. This is what fixes Gemini (its MCP subprocess env strips `*TOKEN*`) and
 * keeps the Codex token off world-readable argv. The security-relevant facts:
 * the file holds the SAME token the store minted, is mode 0600 (other users
 * can't read it), lives under the config dir, resolves per-session, and is
 * unlinked on revoke so a dead session leaves no secret on disk.
 */
describe("agent token file", () => {
  let dir: string;

  afterEach(() => {
    _resetAgentCredentialsForTesting();
    _resetConfigDirForTesting();
  });

  const isolate = () => {
    dir = mkdtempSync(join(tmpdir(), "autonomos-tokenfile-"));
    _setConfigDirForTesting(dir);
  };

  it("writes the minted token to <configDir>/agent-tokens/<sessionId>", () => {
    isolate();
    const path = writeAgentTokenFile("sess-file-a");
    assert.equal(path, join(dir, "agent-tokens", "sess-file-a"));
    // The file content must be exactly the token the store verifies against —
    // this is the value the channel-server presents in its gateway register.
    const onDisk = readFileSync(path, "utf8");
    assert.ok(verifyAgentToken("sess-file-a", onDisk));
    assert.equal(onDisk, getAgentToken("sess-file-a"));
  });

  it("writes the file mode 0600 (other users can't read it)", () => {
    isolate();
    const path = writeAgentTokenFile("sess-file-b");
    // 0o777 masks off the type bits; the token must not be group/other readable.
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("is idempotent with a prior mint — file matches the hook-path token", () => {
    isolate();
    // buildBaseEnv mints for the hook curl before spawn writes the file; both
    // must carry the same value or the hook and channel planes disagree.
    const minted = mintAgentToken("sess-file-c");
    const onDisk = readFileSync(writeAgentTokenFile("sess-file-c"), "utf8");
    assert.equal(onDisk, minted);
  });

  it("revoke unlinks the file — no stale secret on disk", () => {
    isolate();
    const path = writeAgentTokenFile("sess-file-d");
    assert.ok(existsSync(path));
    revokeAgentToken("sess-file-d");
    assert.equal(existsSync(path), false);
  });

  it("revoke of a session that never wrote a file does not throw", () => {
    isolate();
    mintAgentToken("sess-file-e");
    // In-memory only (no channel server) — unlink is best-effort.
    assert.doesNotThrow(() => revokeAgentToken("sess-file-e"));
  });

  it("rejects a sessionId that isn't a safe filename (path traversal)", () => {
    isolate();
    // sessionId is attacker-influenceable on the resume/adopt path and lands as
    // a path segment — a `/` or `..` must fail loud, never traverse.
    assert.throws(() => agentTokenFilePath("../escape"));
    assert.throws(() => agentTokenFilePath("a/b"));
    assert.throws(() => agentTokenFilePath("with space"));
    // A normal UUID-shaped id is fine.
    assert.doesNotThrow(() =>
      agentTokenFilePath("6f1e2d3c-4b5a-6789-0abc-def012345678"),
    );
  });
});
