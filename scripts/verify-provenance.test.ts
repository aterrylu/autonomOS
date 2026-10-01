/**
 * The COMMITTED scripts/verify-provenance.mjs — the exact bytes install.sh
 * pins and runs on a fresh machine (ADR-126). These run that file under node,
 * offline, against the real v0.7.0 attestation and a snapshot of Sigstore's
 * trust root, so a bundle that builds but can't verify (a missing builtin
 * shim, a broken dependency) fails here instead of on a newcomer's install.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVerifier, INSTALL_SH, readPin, sha256, VERIFIER } from "./build-verifier.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(repo, "packages/server/src/__tests__/fixtures/provenance");
/** sha256 of the real autonomos-linux-x64.tar.gz in the v0.7.0 release. */
const LINUX_X64 = "ce4245b1a48b818f89ca3ac9e682a14b649b21fec76abfea029c0bc46c50e8a1";

// No fs writes at import time: set up in before().
let tmp = "";
let onMain = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "verify-provenance-test-"));
  onMain = join(tmp, "compare-ahead.json");
  writeFileSync(onMain, JSON.stringify({ status: "ahead" }));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(
  args: string[],
  opts: {
    attestations?: string;
    compare?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const r = spawnSync(
    process.execPath,
    [
      VERIFIER,
      "--attestations",
      opts.attestations ?? join(FIX, "v0.7.0-attestations.json"),
      "--trusted-root",
      join(FIX, "trusted-root.json"),
      "--compare",
      opts.compare ?? onMain,
      ...args,
    ],
    { encoding: "utf-8", timeout: 60_000, env: opts.env ?? process.env },
  );
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("scripts/verify-provenance.mjs (the file install.sh pins)", () => {
  it("is current with its sources and pinned by install.sh", async () => {
    assert.deepEqual(await checkVerifier(), []);
    assert.equal(readPin(readFileSync(INSTALL_SH, "utf-8")), sha256(readFileSync(VERIFIER)));
  });

  it("verifies the real v0.7.0 build → exit 0", () => {
    const r = run(["--digest", LINUX_X64, "--version", "v0.7.0"]);
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: "verified" });
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

  it("nothing published → exit 11, missing (install.sh refuses; the updater postpones)", () => {
    const none = join(tmp, "none.json");
    writeFileSync(none, JSON.stringify({ attestations: [] }));
    const r = run(["--digest", LINUX_X64, "--version", "0.7.0"], {
      attestations: none,
    });
    assert.equal(r.code, 11);
    assert.match(r.out, /^missing: /);
  });

  it("binds to the asset name: the right bytes under another platform's name → 10", () => {
    assert.equal(
      run(["--digest", LINUX_X64, "--version", "0.7.0", "--name", "autonomos-linux-x64.tar.gz"]).out,
      "verified",
    );
    const r = run(["--digest", LINUX_X64, "--version", "0.7.0", "--name", "autonomos-darwin-arm64.tar.gz"]);
    assert.equal(r.code, 10);
    assert.match(r.out, /lists this file as autonomos-linux-x64\.tar\.gz/);
  });

  it("a genuine build from a commit that isn't on main → exit 10, invalid", () => {
    const off = join(tmp, "compare-diverged.json");
    writeFileSync(off, JSON.stringify({ status: "diverged" }));
    const r = run(["--digest", LINUX_X64, "--version", "0.7.0"], { compare: off });
    assert.equal(r.code, 10);
    assert.match(r.out, /^invalid: .*isn't on main/);
  });

  it("an unreadable file or bad arguments are a usage error, never 'verified'", () => {
    for (const args of [
      ["--file", join(tmp, "absent"), "--version", "0.7.0"],
      ["--digest", LINUX_X64],
      ["--digest", LINUX_X64, "--version", "0.7.0", "--bogus"],
      // Both sources at once is ambiguous — refuse rather than pick one.
      ["--digest", LINUX_X64, "--file", VERIFIER, "--version", "0.7.0"],
    ]) {
      const r = run(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.equal(r.out, "", args.join(" "));
    }
  });

  it("works with HOME unset (sudo-stripped env): nothing reads the config dir", () => {
    const { HOME: _home, ...env } = process.env;
    const r = run(["--digest", LINUX_X64, "--version", "0.7.0"], { env });
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: "verified" });
  });

  it("ignores AUTONOMOS_SKIP_PROVENANCE — install.sh owns that decision", () => {
    const f = join(tmp, "forged-skip.tar.gz");
    writeFileSync(f, "not the release");
    const r = run(["--file", f, "--version", "0.7.0"], {
      env: { ...process.env, AUTONOMOS_SKIP_PROVENANCE: "1" },
    });
    assert.equal(r.code, 10);
  });
});

describe("install.sh's pin line", () => {
  const good = `readonly VERIFIER_SHA256="${"a".repeat(64)}"`;
  it("is read only when there's exactly one, well-formed", () => {
    assert.equal(readPin(`x\n${good}\ny`), "a".repeat(64));
    // bash honors the LAST assignment: a second line must not pass --check.
    assert.equal(readPin(`${good}\nVERIFIER_SHA256="${"b".repeat(64)}"`), null);
    assert.equal(readPin(`VERIFIER_SHA256="${"a".repeat(64)}"`), null);
    assert.equal(readPin(`readonly VERIFIER_SHA256=""`), null);
  });
});
