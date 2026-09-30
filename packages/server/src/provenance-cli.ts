/**
 * The standalone provenance verifier that `install.sh` runs (ADR-122).
 *
 * Bundled into ONE file, `scripts/verify-provenance.mjs`, by
 * `scripts/build-verifier.ts` (`make verifier`). install.sh pins that file's
 * sha256, so a fresh machine needs nothing but node to check a release —
 * no `gh`, no `cosign`, no npm install. Same verifier as the in-app update:
 * this only wraps verifyReleaseProvenance.
 *
 *   node verify-provenance.mjs --file <tarball> --version <X.Y.Z>
 *        [--repo owner/name] [--tuf-cache <dir>]
 *
 * Prints one line and exits:
 *   0   verified
 *   10  invalid  — present but fails: evidence of tampering
 *   11  missing  — couldn't check (none published, network, unsupported)
 *   2   usage error
 *
 * Policy is the caller's: install.sh refuses on BOTH 10 and 11 (new installs
 * fail closed) and honors AUTONOMOS_SKIP_PROVENANCE itself, before running
 * this — so the skip variable is deliberately NOT read here.
 *
 * Test seams (offline, used by the repo's own tests): --attestations <json>
 * (a GitHub attestations API response), --trusted-root <json>, and
 * --digest <sha256> in place of --file (the fixture's real tarballs aren't
 * in the repo). None crosses a trust boundary: the caller is install.sh.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { type ProvenanceDeps, verifyReleaseProvenance } from "./provenance.js";

const EXIT = { verified: 0, invalid: 10, missing: 11, usage: 2 } as const;

async function main(): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        file: { type: "string" },
        digest: { type: "string" },
        version: { type: "string" },
        repo: { type: "string", default: "aterrylu/autonomOS" },
        "tuf-cache": { type: "string" },
        attestations: { type: "string" },
        "trusted-root": { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`verify-provenance: ${(err as Error).message}`);
    return EXIT.usage;
  }
  const { file, repo } = values;
  const version = values.version?.replace(/^v/, "");
  if ((!file && !values.digest) || !version || !repo) {
    console.error(
      "usage: verify-provenance --file <tarball> --version <X.Y.Z> [--repo owner/name]",
    );
    return EXIT.usage;
  }

  let digest: string;
  try {
    digest =
      values.digest ??
      createHash("sha256")
        .update(readFileSync(file as string))
        .digest("hex");
  } catch (err) {
    console.error(
      `verify-provenance: can't read ${file}: ${(err as Error).message}`,
    );
    return EXIT.usage;
  }

  const deps: Partial<ProvenanceDeps> = {
    // Never the user's config dir: install.sh may run before one exists, and
    // a stale cache there must not outlive this one check.
    trustedRoot: values["trusted-root"]
      ? async () =>
          TrustedRoot.fromJSON(
            JSON.parse(readFileSync(values["trusted-root"] as string, "utf-8")),
          )
      : () =>
          getTrustedRoot({
            cachePath:
              values["tuf-cache"] ??
              join(tmpdir(), `autonomos-sigstore-tuf-${process.pid}`),
            timeout: 15_000,
          }),
  };
  if (values.attestations) {
    const path = values.attestations;
    deps.fetchAttestations = async () => {
      const body = JSON.parse(readFileSync(path, "utf-8")) as {
        attestations?: { bundle?: unknown }[];
      };
      return {
        bundles: (body.attestations ?? [])
          .map((a) => a.bundle)
          .filter((b) => b != null),
      };
    };
  }

  const r = await verifyReleaseProvenance({
    digest,
    version,
    repo,
    apiBase: "https://api.github.com",
    // install.sh owns the skip decision; GITHUB_TOKEN still helps rate limits.
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    deps,
  });
  console.log(
    r.status === "verified" ? "verified" : `${r.status}: ${r.reason}`,
  );
  return r.status === "invalid"
    ? EXIT.invalid
    : r.status === "verified"
      ? EXIT.verified
      : EXIT.missing;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // A crash is "couldn't check", never "verified" — and install.sh
    // refuses on it either way.
    console.log(
      `missing: the verifier crashed (${(err as Error)?.message ?? err})`,
    );
    process.exit(EXIT.missing);
  },
);
