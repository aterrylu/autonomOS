// Verifies that a downloaded release tarball was built by OUR release
// workflow at THAT tag: the Sigstore build-provenance attestation that
// `actions/attest-build-provenance` publishes for every release tarball.
//
// Why: SHA256SUMS ships in the same release as the tarball, so anyone who can
// replace a release asset can replace both. The attestation is signed by a
// short-lived certificate that only GitHub Actions can obtain for this repo's
// `release.yml` running on the tag — it can't be forged by editing a release.
//
// Three outcomes, and the difference between the last two is the whole design:
//   verified — a valid attestation, from our workflow at this tag, names this
//              tarball's sha256.
//   invalid  — an attestation exists but FAILS: bad signature / certificate /
//              transparency-log proof, a different signer, or it names other
//              files. That's evidence of tampering: the update is refused.
//   missing  — we couldn't check: none published, GitHub's attestation API or
//              Sigstore's trust root unreachable, or a format this version
//              can't evaluate. An availability problem, never evidence — an
//              existing install proceeds with a loud warning (Terry's
//              upgrade-continuity rule), a new install stops.
//   skipped  — the operator set AUTONOMOS_SKIP_PROVENANCE=1 (mirrors,
//              air-gapped boxes). Loud, never silent.
//
// The trust root always comes LIVE from Sigstore's TUF repository (cached).
// Pinning it in the binary would turn a routine Sigstore key rotation into
// "invalid" — and refuse every later update.

import { join } from "node:path";
import { bundleFromJSON } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import {
  PolicyError,
  toSignedEntity,
  toTrustMaterial,
  VerificationError,
  Verifier,
} from "@sigstore/verify";

export type ProvenanceResult =
  | { status: "verified" }
  | { status: "invalid"; reason: string }
  | { status: "missing"; reason: string }
  | { status: "skipped"; reason: string };

export const SKIP_PROVENANCE_ENV = "AUTONOMOS_SKIP_PROVENANCE";
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_PAYLOAD = "application/vnd.in-toto+json";

/** The only signer we accept: this repo's release workflow, at this tag. */
export function expectedSigner(repo: string, version: string): string {
  return `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v${version}`;
}

/** The signer as an EXACT-match policy. @sigstore/verify matches a string
 *  policy as an UNANCHORED regular expression, so the bare string let
 *  `v0.7.0` match `v0.7.0-rc.1`, and `.` in the repo or version match any
 *  character (review catch on #445: version "0.7" verified v0.7.0's build). */
export function signerPolicy(repo: string, version: string): RegExp {
  const esc = expectedSigner(repo, version).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  // Case-insensitive because GitHub owner/repo names are (the API matches
  // `aterrylu/autonomos` too); the version is then re-checked EXACTLY below.
  return new RegExp(`^${esc}$`, "i");
}

/** Belt and braces over the library's match: the signer it returned must be
 *  our release workflow for THIS repo (case-insensitive, as GitHub is) at
 *  THIS exact tag — whatever the library's match semantics become. */
export function signerIsExactly(
  san: string | undefined,
  repo: string,
  version: string,
): boolean {
  const m =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/\.github\/workflows\/release\.yml@refs\/tags\/v(.+)$/.exec(
      san ?? "",
    );
  return (
    m !== null && m[1].toLowerCase() === repo.toLowerCase() && m[2] === version
  );
}

export type ProvenanceDeps = {
  /** The attestation bundles for a digest; null = couldn't ask (with why). */
  fetchAttestations: (
    digest: string,
  ) => Promise<{ bundles: unknown[] } | { error: string }>;
  trustedRoot: () => Promise<TrustedRoot>;
  /** Is `commit` an ancestor of the repo's main branch? */
  commitOnMain: (commit: string) => Promise<boolean | { error: string }>;
};

/** Fulcio certificate extensions for GitHub Actions. Fulcio copies them from
 *  GitHub's OIDC token, so the workflow that ran CAN'T choose them — unlike
 *  the SLSA predicate, which that workflow writes. A tag on a foreign commit
 *  carries its own release.yml, and that release.yml could claim any commit
 *  in the predicate; the certificate says which commit actually ran. */
const OID_SOURCE_REPOSITORY_URI = "1.3.6.1.4.1.57264.1.12";
const OID_SOURCE_REPOSITORY_DIGEST = "1.3.6.1.4.1.57264.1.13";
const OID_SOURCE_REPOSITORY_REF = "1.3.6.1.4.1.57264.1.14";

export async function verifyReleaseProvenance(opts: {
  /** sha256 hex of the downloaded tarball. */
  digest: string;
  /** Release version, no leading "v". */
  version: string;
  repo: string;
  apiBase: string;
  /** The release asset's file name. When given, the record must vouch for
   *  this digest UNDER THIS NAME — so a genuine tarball for another platform,
   *  swapped in with a fixed-up SHA256SUMS, isn't "verified". */
  name?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<ProvenanceDeps>;
  /** Test seam: pretend to run under Bun. */
  underBun?: boolean;
}): Promise<ProvenanceResult> {
  const env = opts.env ?? process.env;
  if (env[SKIP_PROVENANCE_ENV] === "1") {
    return {
      status: "skipped",
      reason: `${SKIP_PROVENANCE_ENV}=1 is set`,
    };
  }
  // Measured: the real, valid v0.7.0 attestation fails TLOG_INCLUSION_PROMISE
  // under Bun 1.3 (verified under Node). Everything that runs this ships on
  // Node today — but if that ever changes, say "can't check", never "forged".
  if (opts.underBun ?? !!process.versions.bun) {
    return {
      status: "missing",
      reason: "the signed build record can only be checked under Node",
    };
  }
  const fetchAttestations =
    opts.deps?.fetchAttestations ??
    ((d: string) => fetchFromGitHub(opts.apiBase, opts.repo, d, env));
  const trustedRoot = opts.deps?.trustedRoot ?? liveTrustedRoot;
  const commitOnMain =
    opts.deps?.commitOnMain ??
    ((c: string) => compareWithMain(opts.apiBase, opts.repo, c, env));

  const got = await fetchAttestations(opts.digest);
  if ("error" in got) return { status: "missing", reason: got.error };
  if (got.bundles.length === 0) {
    return {
      status: "missing",
      reason: "no signed build record was found for this download",
    };
  }

  let verifier: Verifier;
  try {
    verifier = new Verifier(toTrustMaterial(await trustedRoot()));
  } catch (err) {
    return {
      status: "missing",
      reason: `couldn't load Sigstore's trust root (${errText(err)})`,
    };
  }

  let invalid: string | null = null;
  let unsupported: string | null = null;
  let cantCheckMain: string | null = null;
  for (const raw of got.bundles) {
    let bundle: ReturnType<typeof bundleFromJSON>;
    try {
      bundle = bundleFromJSON(raw);
    } catch (err) {
      unsupported ??= `unreadable attestation (${errText(err)})`;
      continue;
    }
    let signer: ReturnType<Verifier["verify"]>;
    try {
      signer = verifier.verify(toSignedEntity(bundle), {
        subjectAlternativeName: signerPolicy(opts.repo, opts.version),
        extensions: { issuer: OIDC_ISSUER },
      });
    } catch (err) {
      const c = classifyVerifyError(err);
      if (c.kind === "invalid") invalid ??= c.reason;
      else unsupported ??= c.reason;
      continue;
    }
    if (
      !signerIsExactly(
        signer.identity?.subjectAlternativeName,
        opts.repo,
        opts.version,
      )
    ) {
      invalid ??= "it was signed by a different workflow or repository";
      continue;
    }
    // Signed by us, at this tag. Now: does it vouch for THIS file?
    const subjects = attestedSubjects(bundle);
    if (subjects === null) {
      unsupported ??= "an attestation that isn't SLSA build provenance";
      continue;
    }
    const digest = opts.digest.toLowerCase();
    const same = subjects.filter((x) => x.sha256 === digest);
    if (!same.some((x) => opts.name === undefined || x.name === opts.name)) {
      invalid ??= same.length
        ? `the signed build record lists this file as ${same[0].name}, not ${opts.name}`
        : "the signed build record is for different files";
      continue;
    }
    // Built by our release.yml at this tag — but a tag is just a name: a
    // writer can put one on ANY commit (an old one, a foreign one) and the
    // workflow it carries runs. Only a commit on main went through review.
    const source = certificateSource(bundle);
    if (source === null) {
      unsupported ??= "a signing certificate without its source commit";
      continue;
    }
    if (
      source.uri.toLowerCase() !==
        `https://github.com/${opts.repo}`.toLowerCase() ||
      source.ref !== `refs/tags/v${opts.version}`
    ) {
      invalid ??= "it was built from a different repository or tag";
      continue;
    }
    const onMain = await commitOnMain(source.commit);
    if (onMain === true) return { status: "verified" };
    if (onMain === false) {
      invalid ??= `it was built from commit ${source.commit.slice(0, 12)}, which isn't on main`;
      continue;
    }
    cantCheckMain ??= onMain.error;
  }
  if (invalid) return { status: "invalid", reason: invalid };
  if (cantCheckMain) return { status: "missing", reason: cantCheckMain };
  return {
    status: "missing",
    reason: unsupported ?? "no usable signed build record",
  };
}

/** What a verifier error means. Only evidence of tampering is "invalid" —
 *  a wrong signer, or a signature / certificate / log proof that doesn't
 *  hold. Anything that says "I can't evaluate this" (a feature not
 *  implemented, a DSSE/entry/Rekor format this library version doesn't
 *  know — thrown as TLOG_BODY_ERROR "unsupported …") is "unsupported" and
 *  lands as missing: a future format must never refuse updates.
 *  Node only: the verifier is tested under Node, and the release bundle,
 *  install.sh and the in-app job all run under Node. */
export function classifyVerifyError(err: unknown): {
  kind: "invalid" | "unsupported";
  reason: string;
} {
  if (err instanceof PolicyError) {
    return {
      kind: "invalid",
      reason: "it was signed by a different workflow or repository",
    };
  }
  if (err instanceof VerificationError) {
    const cantEvaluate =
      // Not thrown by @sigstore/verify 4.x; kept for other versions.
      err.code === "NOT_IMPLEMENTED_ERROR" ||
      // A DSSE / entry kind / Rekor format this version doesn't know.
      (err.code === "TLOG_BODY_ERROR" && /^unsupported /i.test(err.message)) ||
      // A timestamp or log entry shape it silently skips, then misses its
      // threshold: "expected 1 timestamps, got 0".
      (err.code === "TIMESTAMP_ERROR" &&
        /^expected \d+ timestamps/i.test(err.message)) ||
      // A log key the trust root doesn't carry (a stale or partial cache).
      ((err.code === "TLOG_ERROR" || err.code === "PUBLIC_KEY_ERROR") &&
        /key not found/i.test(err.message));
    if (!cantEvaluate) {
      return {
        kind: "invalid",
        reason: `its signature doesn't verify (${err.code})`,
      };
    }
  }
  return {
    kind: "unsupported",
    reason: `an attestation this version can't evaluate (${errText(err)})`,
  };
}

/** The sha256 digests an in-toto SLSA provenance statement vouches for, or
 *  null when the bundle isn't one. */
function attestedSubjects(
  bundle: ReturnType<typeof bundleFromJSON>,
): { name: string; sha256: string }[] | null {
  // Never throws: a signed-but-odd payload is "can't evaluate", not a crash
  // that would fail the update for an unrelated reason.
  try {
    const content = bundle.content;
    if (content.$case !== "dsseEnvelope") return null;
    const env = content.dsseEnvelope;
    if (env.payloadType !== IN_TOTO_PAYLOAD) return null;
    const stmt = JSON.parse(Buffer.from(env.payload).toString("utf-8")) as {
      predicateType?: unknown;
      subject?: unknown;
    } | null;
    if (!stmt || stmt.predicateType !== SLSA_PROVENANCE_V1) return null;
    if (!Array.isArray(stmt.subject)) return null;
    return stmt.subject.flatMap((x) => {
      const sub = x as { name?: unknown; digest?: { sha256?: unknown } } | null;
      const sha256 = sub?.digest?.sha256;
      return typeof sha256 === "string"
        ? [{ name: String(sub?.name ?? ""), sha256: sha256.toLowerCase() }]
        : [];
    });
  } catch {
    return null;
  }
}

/** The source repository, commit and ref from the (already verified) leaf
 *  certificate, or null when it doesn't carry them. Never throws. */
function certificateSource(
  bundle: ReturnType<typeof bundleFromJSON>,
): { uri: string; commit: string; ref: string } | null {
  try {
    const vm = bundle.verificationMaterial.content;
    const raw =
      vm.$case === "certificate"
        ? vm.certificate.rawBytes
        : vm.$case === "x509CertificateChain"
          ? vm.x509CertificateChain.certificates[0]?.rawBytes
          : undefined;
    if (!raw) return null;
    const cert = X509Certificate.parse(Buffer.from(raw));
    const text = (oid: string) => {
      const v = cert.extension(oid)?.value;
      return v ? derUtf8String(Buffer.from(v)) : null;
    };
    const uri = text(OID_SOURCE_REPOSITORY_URI);
    const commit = text(OID_SOURCE_REPOSITORY_DIGEST);
    const ref = text(OID_SOURCE_REPOSITORY_REF);
    if (!uri || !ref || !commit || !/^[0-9a-f]{40}$/.test(commit)) return null;
    return { uri, commit, ref };
  } catch {
    return null;
  }
}

/** A DER UTF8String (tag 0x0c, short or long-form length) → its text. */
function derUtf8String(der: Buffer): string | null {
  if (der[0] !== 0x0c || der.length < 2) return null;
  let len = der[1];
  let off = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || der.length < 2 + n) return null;
    len = n === 1 ? der[2] : (der[2] << 8) | der[3];
    off = 2 + n;
  }
  return off + len === der.length ? der.subarray(off).toString("utf-8") : null;
}

/** Only GitHub itself ever gets the token. `apiBase` follows the release
 *  override (a mirror, a test fixture), and nothing else in the update sends
 *  a credential there. */
const GITHUB_API = "https://api.github.com";
const MAX_OUT_OF_LINE_BUNDLES = 10;

/** GET a GitHub API path. The token only ever goes to GitHub itself, and a
 *  stale one (401 on a PUBLIC endpoint — which would quietly turn every check
 *  into "couldn't check") is retried bare. A token-bearing request never
 *  FOLLOWS a redirect: it's retried bare instead, so the token's safety never
 *  rests on the HTTP client stripping it from a cross-origin hop.
 *  `trustedApi` is a test seam; callers leave it as api.github.com. */
export async function githubGet(
  apiBase: string,
  path: string,
  env: Record<string, string | undefined>,
  trustedApi: string = GITHUB_API,
): Promise<Response> {
  const ask = (withToken: boolean) =>
    fetch(`${apiBase}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        // Optional: only raises the rate limit (the endpoints are public).
        ...(withToken && { Authorization: `Bearer ${env.GITHUB_TOKEN}` }),
      },
      redirect: withToken ? "manual" : "follow",
      signal: AbortSignal.timeout(15_000),
    });
  const token = !!env.GITHUB_TOKEN && apiBase === trustedApi;
  if (!token) return ask(false);
  const resp = await ask(true);
  const redirected = resp.status >= 300 && resp.status < 400;
  return resp.status === 401 || redirected ? ask(false) : resp;
}

/** Is `commit` an ancestor of main? true / false, or why it couldn't tell.
 *  Only an answer from GitHub is a "false": a network error, a rate limit or
 *  an odd reply is "couldn't check" — never tamper evidence. */
async function compareWithMain(
  apiBase: string,
  repo: string,
  commit: string,
  env: Record<string, string | undefined>,
): Promise<boolean | { error: string }> {
  try {
    // base...head = commit...main: "ahead"/"identical" means main contains it.
    const resp = await githubGet(
      apiBase,
      `/repos/${repo}/compare/${commit}...main`,
      env,
    );
    // 404: the commit isn't in the repository, so it can't be on main.
    if (resp.status === 404) return false;
    if (!resp.ok) {
      return {
        error: `couldn't confirm the build came from main (GitHub answered HTTP ${resp.status})`,
      };
    }
    const status = ((await resp.json()) as { status?: unknown } | null)?.status;
    if (status === "ahead" || status === "identical") return true;
    if (status === "behind" || status === "diverged") return false;
    return {
      error:
        "couldn't confirm the build came from main (an unexpected answer from GitHub)",
    };
  } catch (err) {
    return {
      error: `couldn't reach GitHub to confirm the build came from main (${errText(err)})`,
    };
  }
}

async function fetchFromGitHub(
  apiBase: string,
  repo: string,
  digest: string,
  env: Record<string, string | undefined>,
): Promise<{ bundles: unknown[] } | { error: string }> {
  try {
    // per_page=100: the default 30 would let a flood of junk attestations
    // push the real one off page 1.
    const resp = await githubGet(
      apiBase,
      `/repos/${repo}/attestations/sha256:${digest}?per_page=100`,
      env,
    );
    // 404 = no attestation for this digest (GitHub's answer for "none").
    if (resp.status === 404) return { bundles: [] };
    if (!resp.ok) {
      return {
        error: `GitHub's attestation service answered HTTP ${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      attestations?: { bundle?: unknown; bundle_url?: unknown }[];
    };
    const list = body.attestations ?? [];
    const inline = list.flatMap((a) => (a.bundle != null ? [a.bundle] : []));
    // Large bundles are stored out of line. Fetch them in parallel under ONE
    // deadline, and only the first few: fetched one after another, a page of
    // 100 could stall the update for 25 minutes. (No token: the URL is
    // pre-signed blob storage, not GitHub's API. Only a writer to OUR repo
    // can create attestations for it, and ours are stored inline.)
    const deadline = AbortSignal.timeout(15_000);
    const outOfLine = await Promise.all(
      list
        .filter((a) => a.bundle == null && typeof a.bundle_url === "string")
        .slice(0, MAX_OUT_OF_LINE_BUNDLES)
        .map(async (a) => {
          try {
            const b = await fetch(a.bundle_url as string, { signal: deadline });
            return b.ok ? [(await b.json()) as unknown] : [];
          } catch {
            // One unreachable bundle is not tamper evidence; others may verify.
            return [];
          }
        }),
    );
    return { bundles: [...inline, ...outOfLine.flat()] };
  } catch (err) {
    return {
      error: `couldn't reach GitHub's attestation service (${errText(err)})`,
    };
  }
}

/** Sigstore's trust root, from its TUF repository (cached under the config
 *  dir; the first fetch is ~300ms). configDir is imported lazily: it throws
 *  AT IMPORT when HOME is unset, and install.sh's standalone verifier (which
 *  brings its own trust root) must not crash on a sudo-stripped env. */
async function liveTrustedRoot(): Promise<TrustedRoot> {
  const { getConfigDir } = await import("./configDir.js");
  return getTrustedRoot({
    cachePath: join(getConfigDir(), "sigstore-tuf"),
    timeout: 15_000,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
