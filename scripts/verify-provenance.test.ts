/**
 * The COMMITTED scripts/verify-provenance.mjs — the exact bytes install.sh
 * pins and runs on a fresh machine (ADR-122). These run that file under node,
 * offline, against the real v0.7.0 attestation and a snapshot of Sigstore's
 * trust root, so a bundle that builds but can't verify (a missing builtin
 * shim, a broken dependency) fails here instead of on a newcomer's install.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVerifier, INSTALL_SH, readPin, sha256, VERIFIER } from "./build-verifier.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(repo, "packages/server/src/__tests__/fixtures/provenance");
/** sha256 of the real autonomos-linux-x64.tar.gz in the v0.7.0 release. */
const LINUX_X64 = "ce4245b1a48b818f89ca3ac9e682a14b649b21fec76abfea029c0bc46c50e8a1";

const tmp = mkdtempSync(join(tmpdir(), "verify-provenance-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], attestations = join(FIX, "v0.7.0-attestations.json")) {
  const r = spawnSync(
    process.execPath,
    [
      VERIFIER,
      "--attestations",
      attestations,
      "--trusted-root",
      join(FIX, "trusted-root.json"),
      ...args,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

describe("scripts/verify-provenance.mjs (the file install.sh pins)", () => {
  it("is current with its sources and pinned by install.sh", async () => {
    assert.deepEqual(await checkVerifier(), []);
    assert.equal(readPin(readFileSync(INSTALL_SH, "utf-8")), sha256(readFileSync(VERIFIER)));
  });

  it("verifies the real v0.7.0 build → exit 0", () => {
    const r = run(["--digest", LINUX_X64, "--version", "v0.7.0"]);
    assert.deepEqual(r, { code: 0, out: "verified" });
  });

  it("the right file under another tag (a replayed older build) → exit 10, invalid", () => {
    for (const version of ["0.7.1", "0.7"]) {
      const r = run(["--digest", LINUX_X64, "--version", version]);
      assert.equal(r.code, 10, version);
      assert.match(r.out, /^invalid: .*different workflow/);
    }
  });

  it("a file the attestation doesn't name → exit 10, invalid (hashes --file itself)", () => {
    const f = join(tmp, "forged.tar.gz");
    writeFileSync(f, "not the release");
    const r = run(["--file", f, "--version", "0.7.0"]);
    assert.equal(r.code, 10);
    assert.match(r.out, /^invalid: .*different files/);
  });

  it("nothing published → exit 11, missing (install.sh refuses; the updater only warns)", () => {
    const none = join(tmp, "none.json");
    writeFileSync(none, JSON.stringify({ attestations: [] }));
    const r = run(["--digest", LINUX_X64, "--version", "0.7.0"], none);
    assert.equal(r.code, 11);
    assert.match(r.out, /^missing: /);
  });

  it("an unreadable file or missing argument is a usage error, never 'verified'", () => {
    assert.equal(run(["--file", join(tmp, "absent"), "--version", "0.7.0"]).code, 2);
    assert.equal(run(["--digest", LINUX_X64]).code, 2);
    assert.equal(run(["--digest", LINUX_X64, "--version", "0.7.0", "--bogus"]).code, 2);
  });

  it("ignores AUTONOMOS_SKIP_PROVENANCE — install.sh owns that decision", () => {
    const f = join(tmp, "forged-skip.tar.gz");
    writeFileSync(f, "not the release");
    const r = spawnSync(
      process.execPath,
      [
        VERIFIER,
        "--attestations",
        join(FIX, "v0.7.0-attestations.json"),
        "--trusted-root",
        join(FIX, "trusted-root.json"),
        "--file",
        f,
        "--version",
        "0.7.0",
      ],
      { encoding: "utf-8", env: { ...process.env, AUTONOMOS_SKIP_PROVENANCE: "1" } },
    );
    assert.equal(r.status, 10);
  });
});
