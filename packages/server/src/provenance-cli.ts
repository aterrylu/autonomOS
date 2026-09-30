/**
 * The standalone provenance verifier that `install.sh` runs (ADR-126).
 *
 * Bundled into ONE file, `scripts/verify-provenance.mjs`, by
 * `scripts/build-verifier.ts` (`make verifier`). install.sh pins that file's
 * sha256, so a fresh machine needs nothing but node to check a release —
 * no `gh`, no `cosign`, no npm install. Same verifier as the in-app update:
 * this only wraps verifyReleaseProvenance.
 *
 *   node verify-provenance.mjs --file <tarball> --version <X.Y.Z>
 *        [--name <asset file name>] [--repo owner/name] [--tuf-cache <dir>]
 *
 * Prints one line on stdout and exits:
 *   0   verified   (stdout is exactly "verified")
 *   10  invalid  — present but fails: evidence of tampering
 *   11  missing  — couldn't check (none published, network, unsupported)
 *   2   usage error
 * Anything else is a crash. The exit code starts as 11: a process that ends
 * WITHOUT reaching a result — a promise that never settles, an emptied event
 * loop — must never look like success. install.sh also requires the
 * "verified" line, not just the code.
 *
 * Policy is the caller's: install.sh refuses on everything but 0 (new
 * installs fail closed) and honors AUTONOMOS_SKIP_PROVENANCE itself, before
 * running this — so the skip variable is deliberately NOT read here.
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
import {
  type ProvenanceDeps,
  type ProvenanceResult,
  verifyReleaseProvenance,
} from "./provenance.js";

const EXIT = { verified: 0, invalid: 10, missing: 11, usage: 2 } as const;

process.exitCode = EXIT.missing;

function usage(message: string): number {
  console.error(`verify-provenance: ${message}`);
  console.error(
    "usage: verify-provenance --file <tarball> --version <X.Y.Z> [--name <asset>] [--repo owner/name]",
  );
  return EXIT.usage;
}

function exitCodeFor(r: ProvenanceResult): number {
  switch (r.status) {
    case "verified":
      return EXIT.verified;
    case "invalid":
      return EXIT.invalid;
    case "missing":
    case "skipped": // unreachable (the skip var isn't passed), but never 0
      return EXIT.missing;
  }
}

async function main(): Promise<{ line: string; code: number }> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        file: { type: "string" },
        digest: { type: "string" },
        version: { type: "string" },
        name: { type: "string" },
        repo: { type: "string", default: "aterrylu/autonomOS" },
        "tuf-cache": { type: "string" },
        attestations: { type: "string" },
        "trusted-root": { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    return { line: "", code: usage((err as Error).message) };
  }
  const { file, repo } = values;
  const version = values.version?.replace(/^v/, "");
  if (!version || !repo)
    return { line: "", code: usage("--version is required") };
  if (!file === !values.digest)
    return { line: "", code: usage("give exactly one of --file or --digest") };

  let digest: string;
  if (file) {
    try {
      digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (err) {
      return {
        line: "",
        code: usage(`can't read ${file}: ${(err as Error).message}`),
      };
    }
  } else {
    digest = values.digest as string;
  }

  const deps: Partial<ProvenanceDeps> = {};
  const trustedRootPath = values["trusted-root"];
  if (trustedRootPath) {
    deps.trustedRoot = async () =>
      TrustedRoot.fromJSON(JSON.parse(readFileSync(trustedRootPath, "utf-8")));
  } else {
    // Never the user's config dir: install.sh may run before one exists, and
    // a stale cache there must not outlive this one check.
    const cachePath =
      values["tuf-cache"] ??
      join(tmpdir(), `autonomos-sigstore-tuf-${process.pid}`);
    deps.trustedRoot = () => getTrustedRoot({ cachePath, timeout: 15_000 });
  }
  const attestationsPath = values.attestations;
  if (attestationsPath) {
    deps.fetchAttestations = async () => {
      const body = JSON.parse(readFileSync(attestationsPath, "utf-8")) as {
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
    name: values.name,
    apiBase: "https://api.github.com",
    // install.sh owns the skip decision; GITHUB_TOKEN still helps rate limits.
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    deps,
  });
  return {
    line: r.status === "verified" ? "verified" : `${r.status}: ${r.reason}`,
    code: exitCodeFor(r),
  };
}

/** Exit only once the line is flushed: stdout to a pipe is asynchronous on
 *  POSIX, and install.sh reads that line. */
function finish(line: string, code: number): void {
  if (!line) process.exit(code);
  process.stdout.write(`${line}\n`, () => process.exit(code));
}

main().then(
  ({ line, code }) => finish(line, code),
  // A crash is "couldn't check", never "verified" — and install.sh refuses
  // on it either way.
  (err) =>
    finish(
      `missing: the verifier crashed (${(err as Error)?.message ?? err})`,
      EXIT.missing,
    ),
);
