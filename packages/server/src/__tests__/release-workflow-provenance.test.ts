/**
 * Every installed autonomOS verifies an update's build-provenance
 * attestation against ONE signer: `.github/workflows/release.yml` at the
 * release tag (ADR-126). Moving the attest step (say, into a reusable
 * workflow) or renaming release.yml changes the signer, and every existing
 * install would then REFUSE every later update as "signed by a different
 * workflow". That change needs two releases (docs/RELEASE.md) — this test
 * makes sure it can't happen by accident.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { expectedSigner } from "../provenance.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("release.yml stays the provenance signer (ADR-126)", () => {
  it("release.yml attests every release tarball", () => {
    const wf = readFileSync(
      join(repoRoot, ".github/workflows/release.yml"),
      "utf-8",
    );
    assert.match(
      wf,
      /uses:\s*actions\/attest-build-provenance@/,
      "the attest step left release.yml: every installed verifier expects release.yml as the signer. See docs/RELEASE.md (a signer change needs two releases).",
    );
    assert.match(wf, /subject-path:[\s\S]*release\/autonomos-\*\.tar\.gz/);
    assert.match(wf, /id-token:\s*write/);
    assert.match(wf, /attestations:\s*write/);
  });

  it("the verifier expects exactly that workflow", () => {
    assert.equal(
      expectedSigner("aterrylu/autonomOS", "1.2.3"),
      "https://github.com/aterrylu/autonomOS/.github/workflows/release.yml@refs/tags/v1.2.3",
    );
  });
});
