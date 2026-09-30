/**
 * Builds `scripts/verify-provenance.mjs` — the single-file provenance
 * verifier install.sh runs on a fresh machine (ADR-126) — and keeps the
 * sha256 pinned in install.sh in step with it.
 *
 *   tsx scripts/build-verifier.ts           # rebuild + re-pin (make verifier)
 *   tsx scripts/build-verifier.ts --check   # exit 1 if stale or unpinned
 *
 * Why it's committed rather than built at deploy time: install.sh must pin
 * the exact bytes it runs, and the site deploy copies both files together
 * (site.yml), so the pin and the file can never ship apart.
 *
 * --check rebuilds and requires the committed file to match BYTE FOR BYTE:
 * nobody reads a minified body in review, so the only proof it came from the
 * reviewed source is that the source rebuilds into exactly it. esbuild is
 * pinned exactly (root package.json) so that holds; bumping it means
 * `make verifier` and committing the result. The header also carries a stamp
 * — sha256 over every file esbuild read, sigstore's dependencies included —
 * so a failure can say WHY: sources changed, or the bytes did.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build } from "esbuild";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERIFIER = join(repo, "scripts/verify-provenance.mjs");
export const INSTALL_SH = join(repo, "scripts/install.sh");
const ENTRY = "packages/server/src/provenance-cli.ts";

const STAMP_RE = /^\/\/ inputs-sha256: ([0-9a-f]{64})$/m;
/** install.sh's pin line. bash honors the LAST assignment, so --check
 *  insists on exactly one. */
const PIN_LINE_RE = /^(?:readonly )?VERIFIER_SHA256=.*$/gm;
const PIN_RE = /^readonly VERIFIER_SHA256="([0-9a-f]{64})"$/m;

const OPTIONS: BuildOptions = {
  absWorkingDir: repo,
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Inlined CJS deps require() node builtins; esbuild's ESM output would
  // otherwise shim require to a throw (same as channel-server/dist.mjs).
  banner: {
    js: "import { createRequire as __vpCreateRequire } from 'node:module'; const require = __vpCreateRequire(import.meta.url);",
  },
  metafile: true,
  write: false,
  logLevel: "warning",
};

/** Bundles the verifier; returns its code and the inputs stamp. */
export async function bundleVerifier(): Promise<{ code: string; stamp: string }> {
  const out = await build(OPTIONS);
  const h = createHash("sha256");
  const { metafile: _m, write: _w, ...opts } = OPTIONS;
  h.update(JSON.stringify({ ...opts, absWorkingDir: "." }));
  for (const input of Object.keys(out.metafile?.inputs ?? {}).sort()) {
    h.update(`\0${input}\0`);
    h.update(readFileSync(join(repo, input)));
  }
  const text = out.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild produced no output");
  return { code: text, stamp: h.digest("hex") };
}

export function withHeader(code: string, stamp: string): string {
  return [
    "// autonomOS release-provenance verifier (ADR-126). GENERATED from",
    `// ${ENTRY} by scripts/build-verifier.ts — do not edit; run \`make verifier\`.`,
    "// install.sh pins this file's sha256.",
    `// inputs-sha256: ${stamp}`,
    code,
  ].join("\n");
}

export function sha256(b: string | Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export function readStamp(verifierText: string): string | null {
  return STAMP_RE.exec(verifierText)?.[1] ?? null;
}

/** The pin, or null unless install.sh has exactly one well-formed pin line. */
export function readPin(installSh: string): string | null {
  if ((installSh.match(PIN_LINE_RE) ?? []).length !== 1) return null;
  return PIN_RE.exec(installSh)?.[1] ?? null;
}

/** Problems with the committed pair, empty when consistent. */
export async function checkVerifier(): Promise<string[]> {
  const problems: string[] = [];
  const committed = readFileSync(VERIFIER, "utf-8");
  const pin = readPin(readFileSync(INSTALL_SH, "utf-8"));
  if (!pin)
    problems.push(
      'install.sh needs exactly one `readonly VERIFIER_SHA256="<sha256>"` line',
    );
  else if (pin !== sha256(committed))
    problems.push(
      "install.sh's VERIFIER_SHA256 doesn't match scripts/verify-provenance.mjs — every fresh install would refuse",
    );
  const { code, stamp } = await bundleVerifier();
  if (readStamp(committed) !== stamp)
    problems.push(
      "scripts/verify-provenance.mjs is stale: its sources or sigstore dependencies changed since it was built",
    );
  else if (withHeader(code, stamp) !== committed)
    problems.push(
      "scripts/verify-provenance.mjs differs from a rebuild of its sources (edited by hand, or built with another esbuild)",
    );
  return problems;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const problems = await checkVerifier();
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) {
      console.error(
        "  Fix: make verifier (rebuilds and re-pins), then commit both files.",
      );
      process.exit(1);
    }
    console.log("✓ verify-provenance.mjs is current and pinned");
    return;
  }
  const sh = readFileSync(INSTALL_SH, "utf-8");
  // Check before writing anything, so a failure can't leave the pair split.
  if (readPin(sh) === null)
    throw new Error(
      'install.sh needs exactly one `readonly VERIFIER_SHA256="<sha256>"` line to update',
    );
  const { code, stamp } = await bundleVerifier();
  const text = withHeader(code, stamp);
  const pin = sha256(text);
  writeFileSync(VERIFIER, text);
  writeFileSync(INSTALL_SH, sh.replace(PIN_RE, `readonly VERIFIER_SHA256="${pin}"`));
  console.log(
    `✓ wrote scripts/verify-provenance.mjs (${Math.round(text.length / 1024)} KB), pinned ${pin.slice(0, 12)}…`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
