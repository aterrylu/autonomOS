/**
 * Release provenance (Sigstore build-provenance attestations).
 *
 * Runs OFFLINE against REAL data: the attestation GitHub published for the
 * v0.7.0 release tarballs, and a snapshot of Sigstore's trusted root taken
 * the day it was recorded (production always fetches the root live via
 * TUF — pinning it would turn a key rotation into "invalid"). The Rekor
 * inclusion proof ships inside the bundle, so the full cryptographic check
 * runs without a network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { PolicyError, VerificationError } from "@sigstore/verify";
import {
  classifyVerifyError,
  expectedSigner,
  type ProvenanceDeps,
  verifyReleaseProvenance,
} from "../provenance.js";

// Not import.meta.dirname: that needs Node 20.11, and this suite also runs
// on the Node 20 floor to prove the verifier works there.
const FIX = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "provenance",
);
const ATT = JSON.parse(
  readFileSync(join(FIX, "v0.7.0-attestations.json"), "utf-8"),
) as { attestations: { bundle: Record<string, unknown> }[] };
const ROOT = TrustedRoot.fromJSON(
  JSON.parse(readFileSync(join(FIX, "trusted-root.json"), "utf-8")),
);

const REPO = "aterrylu/autonomOS";
/** sha256 of the real autonomos-linux-x64.tar.gz in the v0.7.0 release. */
const LINUX_X64 =
  "ce4245b1a48b818f89ca3ac9e682a14b649b21fec76abfea029c0bc46c50e8a1";

const bundles = () =>
  ATT.attestations.map((a) => structuredClone(a.bundle) as unknown);
const offline = (
  over: Partial<ProvenanceDeps> = {},
): Partial<ProvenanceDeps> => ({
  fetchAttestations: async () => ({ bundles: bundles() }),
  trustedRoot: async () => ROOT,
  ...over,
});
const check = (
  over: Partial<Parameters<typeof verifyReleaseProvenance>[0]> = {},
) =>
  verifyReleaseProvenance({
    digest: LINUX_X64,
    version: "0.7.0",
    repo: REPO,
    apiBase: "http://unused",
    env: {},
    deps: offline(),
    ...over,
  });

describe("verifyReleaseProvenance — real v0.7.0 attestation, offline", () => {
  it("verifies the real tarball against OUR release workflow at ITS tag", async () => {
    assert.deepEqual(await check(), { status: "verified" });
    assert.equal(
      expectedSigner(REPO, "0.7.0"),
      "https://github.com/aterrylu/autonomOS/.github/workflows/release.yml@refs/tags/v0.7.0",
    );
  });

  it("a file the attestation doesn't name is INVALID (signed for different files)", async () => {
    const r = await check({ digest: "0".repeat(64) });
    assert.equal(r.status, "invalid");
    assert.match((r as { reason: string }).reason, /different files/);
  });

  it("the right file under the WRONG tag is INVALID (a replayed older build)", async () => {
    const r = await check({ version: "0.7.1" });
    assert.equal(r.status, "invalid");
    assert.match((r as { reason: string }).reason, /different workflow/);
  });

  it("the signer match is EXACT: a version prefix, a sibling tag or a look-alike repo is INVALID", async () => {
    // @sigstore/verify treats a string policy as an unanchored regex; these
    // all "verified" v0.7.0's real build before the policy was anchored.
    for (const over of [
      { version: "0.7" },
      { version: "0" },
      { version: "0.7.0-rc" },
      { repo: "aterrylu.autonomOS" },
      { repo: "aterrylu/autonom" },
    ]) {
      const r = await check(over);
      assert.equal(r.status, "invalid", JSON.stringify(over));
    }
  });

  it("the repo is matched case-insensitively (as GitHub does); the version is not", async () => {
    assert.deepEqual(await check({ repo: "ATERRYLU/autonomos" }), {
      status: "verified",
    });
    assert.equal((await check({ version: "V0.7.0" })).status, "invalid");
  });

  it("binds the record to the asset NAME: another platform's genuine build is INVALID", async () => {
    assert.deepEqual(await check({ name: "autonomos-linux-x64.tar.gz" }), {
      status: "verified",
    });
    // The real linux-x64 bytes served as the darwin-arm64 asset (a swapped
    // asset with a fixed-up SHA256SUMS).
    const r = await check({ name: "autonomos-darwin-arm64.tar.gz" });
    assert.equal(r.status, "invalid");
    assert.match(
      (r as { reason: string }).reason,
      /lists this file as autonomos-linux-x64\.tar\.gz, not autonomos-darwin-arm64/,
    );
  });

  it("under Bun it says it can't check — never 'invalid' (Bun fails the real attestation)", async () => {
    const r = await check({ underBun: true });
    assert.equal(r.status, "missing");
    assert.match(
      (r as { reason: string }).reason,
      /only be checked under Node/,
    );
  });

  it("a fork's name is INVALID: the signer must be the configured repo", async () => {
    const r = await check({ repo: "someone/autonomOS" });
    assert.equal(r.status, "invalid");
  });

  it("a payload edited after signing is INVALID (the signature no longer matches)", async () => {
    const tampered = bundles().map((b) => {
      const env = (b as { dsseEnvelope: { payload: string } }).dsseEnvelope;
      const stmt = JSON.parse(Buffer.from(env.payload, "base64").toString());
      stmt.subject[0].digest.sha256 = "f".repeat(64);
      env.payload = Buffer.from(JSON.stringify(stmt)).toString("base64");
      return b;
    });
    const r = await check({
      deps: offline({
        fetchAttestations: async () => ({ bundles: tampered }),
      }),
    });
    assert.equal(r.status, "invalid");
    assert.match((r as { reason: string }).reason, /signature doesn't verify/);
  });

  it("no attestation published is MISSING, not invalid", async () => {
    const r = await check({
      deps: offline({ fetchAttestations: async () => ({ bundles: [] }) }),
    });
    assert.equal(r.status, "missing");
    assert.match((r as { reason: string }).reason, /no signed build record/);
  });

  it("GitHub unreachable is MISSING, with the reason", async () => {
    const r = await check({
      deps: offline({
        fetchAttestations: async () => ({ error: "couldn't reach GitHub" }),
      }),
    });
    assert.deepEqual(r, { status: "missing", reason: "couldn't reach GitHub" });
  });

  it("Sigstore's trust root unreachable is MISSING — never 'invalid'", async () => {
    const r = await check({
      deps: offline({
        trustedRoot: async () => {
          throw new Error("ENOTFOUND tuf-repo-cdn.sigstore.dev");
        },
      }),
    });
    assert.equal(r.status, "missing");
    assert.match((r as { reason: string }).reason, /trust root/);
  });

  it("an attestation this version can't read is MISSING, not tamper evidence", async () => {
    const r = await check({
      deps: offline({
        fetchAttestations: async () => ({ bundles: [{ nonsense: true }] }),
      }),
    });
    assert.equal(r.status, "missing");
  });

  it("one good attestation among bad ones still verifies", async () => {
    const r = await check({
      deps: offline({
        fetchAttestations: async () => ({
          bundles: [{ nonsense: true }, ...bundles()],
        }),
      }),
    });
    assert.deepEqual(r, { status: "verified" });
  });

  it("AUTONOMOS_SKIP_PROVENANCE=1 skips the check — and says so", async () => {
    let asked = false;
    const r = await check({
      env: { AUTONOMOS_SKIP_PROVENANCE: "1" },
      deps: offline({
        fetchAttestations: async () => {
          asked = true;
          return { bundles: [] };
        },
      }),
    });
    assert.equal(r.status, "skipped");
    assert.equal(asked, false);
  });
});

describe("verifyReleaseProvenance — the GitHub attestations API", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(
    handler: (url: string) => { status: number; body?: unknown },
  ): Promise<string> {
    server = createServer((req, res) => {
      const r = handler(req.url ?? "");
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
    await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
    const a = server.address();
    if (!a || typeof a !== "object") throw new Error("no port");
    return `http://127.0.0.1:${a.port}`;
  }

  it("asks the repo-scoped endpoint for exactly this digest, and verifies what it gets", async () => {
    let asked = "";
    const base = await serve((url) => {
      asked = url;
      return { status: 200, body: ATT };
    });
    const r = await check({
      apiBase: base,
      deps: { trustedRoot: async () => ROOT },
    });
    assert.equal(
      asked,
      `/repos/${REPO}/attestations/sha256:${LINUX_X64}?per_page=100`,
    );
    assert.deepEqual(r, { status: "verified" });
  });

  it("follows bundle_url when GitHub stores the bundle out of line; skips a null bundle", async () => {
    let base = "";
    base = await serve((url) => {
      if (url === "/blob")
        return { status: 200, body: ATT.attestations[0].bundle };
      return {
        status: 200,
        body: {
          attestations: [
            { bundle: null },
            { bundle: null, bundle_url: `${base}/blob` },
          ],
        },
      };
    });
    const r = await check({
      apiBase: base,
      deps: { trustedRoot: async () => ROOT },
    });
    assert.deepEqual(r, { status: "verified" });
  });

  it("never sends GITHUB_TOKEN to a non-GitHub API base (a mirror, a fixture)", async () => {
    let auth: string | undefined = "unset";
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ATT));
    });
    await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
    const a = server.address();
    if (!a || typeof a !== "object") throw new Error("no port");
    const r = await check({
      apiBase: `http://127.0.0.1:${a.port}`,
      env: { GITHUB_TOKEN: "ghp_secret" },
      deps: { trustedRoot: async () => ROOT },
    });
    assert.equal(r.status, "verified");
    assert.equal(auth, undefined);
  });

  it("404 (none published) → missing; 5xx → missing with the status", async () => {
    let code = 404;
    const base = await serve(() => ({ status: code, body: {} }));
    const deps = { trustedRoot: async () => ROOT };
    assert.equal((await check({ apiBase: base, deps })).status, "missing");
    code = 502;
    const r = await check({ apiBase: base, deps });
    assert.equal(r.status, "missing");
    assert.match((r as { reason: string }).reason, /HTTP 502/);
  });
});

describe("classifyVerifyError — tamper evidence vs. can't-evaluate", () => {
  const ve = (code: string, message: string) =>
    new VerificationError({ code: code as never, message });

  it("a wrong signer and failed crypto are INVALID", () => {
    assert.equal(
      classifyVerifyError(
        new PolicyError({ code: "UNTRUSTED_SIGNER_ERROR", message: "x" }),
      ).kind,
      "invalid",
    );
    for (const code of [
      "SIGNATURE_ERROR",
      "CERTIFICATE_ERROR",
      "TLOG_INCLUSION_PROOF_ERROR",
      "TLOG_BODY_ERROR",
      "TIMESTAMP_ERROR",
    ]) {
      assert.equal(
        classifyVerifyError(ve(code, "mismatch")).kind,
        "invalid",
        code,
      );
    }
  });

  it("a format this version can't evaluate is NOT tampering (a future bundle must never refuse updates)", () => {
    for (const [code, msg] of [
      ["NOT_IMPLEMENTED_ERROR", "not implemented"],
      ["TLOG_BODY_ERROR", "unsupported dsse version: 0.0.2"],
      ["TLOG_BODY_ERROR", "unsupported kind: rekor-v3"],
      ["TIMESTAMP_ERROR", "expected 1 timestamps, got 0"],
      ["TLOG_ERROR", "key not found: c0d23d6ad406973f"],
      ["PUBLIC_KEY_ERROR", "key not found: abc"],
    ]) {
      assert.equal(
        classifyVerifyError(ve(code, msg)).kind,
        "unsupported",
        `${code} ${msg}`,
      );
    }
    assert.equal(
      classifyVerifyError(new TypeError("boom")).kind,
      "unsupported",
    );
  });
});
