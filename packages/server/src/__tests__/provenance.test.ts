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
  githubGet,
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
  commitOnMain: async () => true,
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

  /** The commit the v0.7.0 build ran from, per its Fulcio certificate. */
  const V070_COMMIT = "a1351c300f8f61271ebf07259c92c3efe69caf4e";

  it("asks whether the CERTIFICATE's source commit is on main — the sha, never the tag name", async () => {
    const asked: string[] = [];
    const r = await check({
      deps: offline({
        commitOnMain: async (c) => {
          asked.push(c);
          return true;
        },
      }),
    });
    assert.deepEqual(r, { status: "verified" });
    // A tag moved after signing can't change what's compared: this is the
    // commit Fulcio stamped from GitHub's OIDC token.
    assert.deepEqual(asked, [V070_COMMIT]);
  });

  it("a genuine build from a commit that isn't on main is INVALID (a writer's tag off an old or foreign commit)", async () => {
    const r = await check({
      deps: offline({ commitOnMain: async () => false }),
    });
    assert.equal(r.status, "invalid");
    assert.match(
      (r as { reason: string }).reason,
      /commit a1351c300f8f, which isn't on main/,
    );
  });

  it("couldn't confirm main (GitHub unreachable, rate-limited) is MISSING, not invalid", async () => {
    const r = await check({
      deps: offline({
        commitOnMain: async () => ({ error: "couldn't reach GitHub" }),
      }),
    });
    assert.deepEqual(r, { status: "missing", reason: "couldn't reach GitHub" });
  });

  it("main is asked about only AFTER the record fully verifies — not for a wrong tag, file or name", async () => {
    let asked = 0;
    const deps = offline({
      commitOnMain: async () => {
        asked++;
        return true;
      },
    });
    for (const over of [
      { version: "0.7.1" },
      { digest: "0".repeat(64) },
      { name: "autonomos-darwin-arm64.tar.gz" },
    ]) {
      assert.equal((await check({ ...over, deps })).status, "invalid");
    }
    assert.equal(asked, 0);
  });

  it("under Bun it says it can't check — never 'invalid' (Bun fails the real attestation)", async () => {
    const r = await check({ underBun: true });
    assert.equal(r.status, "missing");
    assert.match(
      (r as { reason: string }).reason,
      /only be checked under Node/,
    );
    assert.equal((r as { lasting?: boolean }).lasting, true);
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
    // Retrying can't make a record appear (a release from before v0.5.0).
    assert.equal((r as { lasting?: boolean }).lasting, true);
  });

  it("GitHub unreachable is MISSING, with the reason", async () => {
    const r = await check({
      deps: offline({
        fetchAttestations: async () => ({ error: "couldn't reach GitHub" }),
      }),
    });
    // deepEqual: no `lasting` — a network hiccup IS worth retrying.
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
    assert.equal((r as { lasting?: boolean }).lasting, undefined);
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
      deps: { trustedRoot: async () => ROOT, commitOnMain: async () => true },
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
      deps: { trustedRoot: async () => ROOT, commitOnMain: async () => true },
    });
    assert.deepEqual(r, { status: "verified" });
  });

  it("out-of-line bundles are fetched in parallel and capped — a flood can't stall the update", async () => {
    let blobs = 0;
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/blob")) {
        blobs++;
        // Each takes 400ms: one after another, 25 would take 10s.
        setTimeout(() => res.end(JSON.stringify({ nonsense: true })), 400);
        return;
      }
      const a = server?.address() as { port: number };
      res.end(
        JSON.stringify({
          attestations: [
            ...Array.from({ length: 25 }, (_, i) => ({
              bundle: null,
              bundle_url: `http://127.0.0.1:${a.port}/blob${i}`,
            })),
            ...ATT.attestations,
          ],
        }),
      );
    });
    await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
    const a = server.address() as { port: number };
    const t0 = Date.now();
    const r = await check({
      apiBase: `http://127.0.0.1:${a.port}`,
      deps: { trustedRoot: async () => ROOT, commitOnMain: async () => true },
    });
    assert.deepEqual(r, { status: "verified" });
    assert.equal(blobs, 10);
    assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0}ms`);
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
      deps: { trustedRoot: async () => ROOT, commitOnMain: async () => true },
    });
    assert.equal(r.status, "verified");
    assert.equal(auth, undefined);
  });

  it("404 (none published) → missing; 5xx → missing with the status", async () => {
    let code = 404;
    const base = await serve(() => ({ status: code, body: {} }));
    const deps = {
      trustedRoot: async () => ROOT,
      commitOnMain: async () => true,
    };
    const none = await check({ apiBase: base, deps });
    assert.equal(none.status, "missing");
    assert.equal((none as { lasting?: boolean }).lasting, true, "404: lasting");
    code = 502;
    const r = await check({ apiBase: base, deps });
    assert.equal(r.status, "missing");
    assert.equal((r as { lasting?: boolean }).lasting, undefined, "502: retry");
    assert.match((r as { reason: string }).reason, /HTTP 502/);
  });
});

describe("verifyReleaseProvenance — is the build's commit on main? (GitHub compare)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  const COMMIT = "a1351c300f8f61271ebf07259c92c3efe69caf4e";

  async function github(compare: { status: number; body?: unknown }) {
    const seen: string[] = [];
    server = createServer((req, res) => {
      const url = req.url ?? "";
      seen.push(url);
      res.setHeader("content-type", "application/json");
      if (url.includes("/compare/")) {
        res.statusCode = compare.status;
        res.end(compare.body === undefined ? "" : JSON.stringify(compare.body));
        return;
      }
      res.end(JSON.stringify(ATT));
    });
    await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
    const a = server.address() as { port: number };
    const r = await check({
      apiBase: `http://127.0.0.1:${a.port}`,
      deps: { trustedRoot: async () => ROOT },
    });
    return { r, seen };
  }

  it("compares the certificate's commit against main in the configured repo", async () => {
    const { r, seen } = await github({
      status: 200,
      body: { status: "ahead" },
    });
    assert.deepEqual(r, { status: "verified" });
    assert.ok(
      seen.includes(`/repos/${REPO}/compare/${COMMIT}...main`),
      seen.join(" "),
    );
  });

  it("main contains it (ahead / identical) → verified; it isn't on main (behind / diverged / unknown commit) → INVALID", async () => {
    for (const status of ["ahead", "identical"]) {
      assert.equal(
        (await github({ status: 200, body: { status } })).r.status,
        "verified",
        status,
      );
      server?.close();
    }
    for (const compare of [
      { status: 200, body: { status: "behind" } },
      { status: 200, body: { status: "diverged" } },
      // Not in the repository at all, so it can't be on main.
      { status: 404, body: { message: "Not Found" } },
    ]) {
      const { r } = await github(compare);
      assert.equal(r.status, "invalid", JSON.stringify(compare));
      assert.match((r as { reason: string }).reason, /isn't on main/);
      server?.close();
    }
  });

  it("GitHub not answering the question → MISSING, never invalid", async () => {
    for (const compare of [
      { status: 502 },
      { status: 403, body: { message: "rate limit" } },
      { status: 200, body: { status: "something-new" } },
      { status: 200, body: "not json" },
    ]) {
      const { r } = await github(compare);
      assert.equal(r.status, "missing", JSON.stringify(compare));
      assert.match(
        (r as { reason: string }).reason,
        /confirm the build came from main/,
      );
      server?.close();
    }
  });
});

describe("githubGet — the token never follows a redirect", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  async function listen(
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void,
  ): Promise<string> {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  }

  it("a redirect on a token-bearing request is re-asked bare — the other origin never sees the token", async () => {
    const seenElsewhere: (string | undefined)[] = [];
    const elsewhere = await listen((req, res) => {
      seenElsewhere.push(req.headers.authorization);
      res.end(JSON.stringify({ ok: true }));
    });
    const firstAuth: (string | undefined)[] = [];
    const api = await listen((req, res) => {
      firstAuth.push(req.headers.authorization);
      res.statusCode = 302;
      res.setHeader("location", `${elsewhere}/moved`);
      res.end();
    });
    const resp = await githubGet(
      api,
      "/x",
      { GITHUB_TOKEN: "ghp_secret" },
      api,
    );
    assert.equal(resp.status, 200);
    // The trusted API got the token once, then the bare retry.
    assert.deepEqual(firstAuth, ["Bearer ghp_secret", undefined]);
    assert.deepEqual(seenElsewhere, [undefined]);
  });

  it("without a token, redirects are followed as usual (GitHub's repo-rename redirects)", async () => {
    const target = await listen((_req, res) => res.end("{}"));
    const api = await listen((_req, res) => {
      res.statusCode = 301;
      res.setHeader("location", `${target}/renamed`);
      res.end();
    });
    assert.equal((await githubGet(api, "/x", {}, api)).status, 200);
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
