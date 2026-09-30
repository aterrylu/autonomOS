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
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import {
  PolicyError,
  toSignedEntity,
  toTrustMaterial,
  VerificationError,
  Verifier,
} from "@sigstore/verify";
import { getConfigDir } from "./configDir.js";

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

export type ProvenanceDeps = {
  /** The attestation bundles for a digest; null = couldn't ask (with why). */
  fetchAttestations: (
    digest: string,
  ) => Promise<{ bundles: unknown[] } | { error: string }>;
  trustedRoot: () => Promise<TrustedRoot>;
};

export async function verifyReleaseProvenance(opts: {
  /** sha256 hex of the downloaded tarball. */
  digest: string;
  /** Release version, no leading "v". */
  version: string;
  repo: string;
  apiBase: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<ProvenanceDeps>;
}): Promise<ProvenanceResult> {
  const env = opts.env ?? process.env;
  if (env[SKIP_PROVENANCE_ENV] === "1") {
    return {
      status: "skipped",
      reason: `${SKIP_PROVENANCE_ENV}=1 is set`,
    };
  }
  const fetchAttestations =
    opts.deps?.fetchAttestations ??
    ((d: string) => fetchFromGitHub(opts.apiBase, opts.repo, d, env));
  const trustedRoot = opts.deps?.trustedRoot ?? liveTrustedRoot;

  const got = await fetchAttestations(opts.digest);
  if ("error" in got) return { status: "missing", reason: got.error };
  if (got.bundles.length === 0) {
    return {
      status: "missing",
      reason: "no signed build record was published for this download",
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

  const signer = expectedSigner(opts.repo, opts.version);
  let invalid: string | null = null;
  let unsupported: string | null = null;
  for (const raw of got.bundles) {
    let bundle: ReturnType<typeof bundleFromJSON>;
    try {
      bundle = bundleFromJSON(raw);
    } catch (err) {
      unsupported ??= `unreadable attestation (${errText(err)})`;
      continue;
    }
    try {
      verifier.verify(toSignedEntity(bundle), {
        subjectAlternativeName: signer,
        extensions: { issuer: OIDC_ISSUER },
      });
    } catch (err) {
      if (err instanceof PolicyError) {
        invalid ??= "it was signed by a different workflow or repository";
      } else if (
        err instanceof VerificationError &&
        err.code !== "NOT_IMPLEMENTED_ERROR"
      ) {
        invalid ??= `its signature doesn't verify (${err.code})`;
      } else {
        unsupported ??= `an attestation this version can't evaluate (${errText(err)})`;
      }
      continue;
    }
    // Signed by us, at this tag. Now: does it vouch for THIS file?
    const names = subjectDigests(bundle);
    if (names === null) {
      unsupported ??= "an attestation that isn't SLSA build provenance";
      continue;
    }
    if (names.includes(opts.digest.toLowerCase()))
      return { status: "verified" };
    invalid ??= "the signed build record is for different files";
  }
  if (invalid) return { status: "invalid", reason: invalid };
  return {
    status: "missing",
    reason: unsupported ?? "no usable signed build record",
  };
}

/** The sha256 digests an in-toto SLSA provenance statement vouches for, or
 *  null when the bundle isn't one. */
function subjectDigests(
  bundle: ReturnType<typeof bundleFromJSON>,
): string[] | null {
  const content = bundle.content;
  if (content.$case !== "dsseEnvelope") return null;
  const env = content.dsseEnvelope;
  if (env.payloadType !== IN_TOTO_PAYLOAD) return null;
  let stmt: {
    predicateType?: unknown;
    subject?: { digest?: { sha256?: unknown } }[];
  };
  try {
    stmt = JSON.parse(Buffer.from(env.payload).toString("utf-8"));
  } catch {
    return null;
  }
  if (stmt.predicateType !== SLSA_PROVENANCE_V1) return null;
  return (stmt.subject ?? [])
    .map((s) => s.digest?.sha256)
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.toLowerCase());
}

async function fetchFromGitHub(
  apiBase: string,
  repo: string,
  digest: string,
  env: Record<string, string | undefined>,
): Promise<{ bundles: unknown[] } | { error: string }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  // Optional: only raises the rate limit. The endpoint is public.
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const resp = await fetch(
      `${apiBase}/repos/${repo}/attestations/sha256:${digest}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    // 404 = no attestation for this digest (GitHub's answer for "none").
    if (resp.status === 404) return { bundles: [] };
    if (!resp.ok) {
      return {
        error: `GitHub's attestation service answered HTTP ${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      attestations?: { bundle?: unknown }[];
    };
    return {
      bundles: (body.attestations ?? [])
        .map((a) => a.bundle)
        .filter((b) => b !== undefined),
    };
  } catch (err) {
    return {
      error: `couldn't reach GitHub's attestation service (${errText(err)})`,
    };
  }
}

/** Sigstore's trust root, from its TUF repository (cached under the config
 *  dir; the first fetch is ~300ms). */
async function liveTrustedRoot(): Promise<TrustedRoot> {
  return getTrustedRoot({
    cachePath: join(getConfigDir(), "sigstore-tuf"),
    timeout: 15_000,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
