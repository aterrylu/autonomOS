/**
 * Builds `scripts/verify-provenance.mjs` — the single-file provenance
 * verifier install.sh runs on a fresh machine (ADR-122) — and keeps the
 * sha256 pinned in install.sh in step with it.
 *
 *   tsx scripts/build-verifier.ts           # rebuild + re-pin (make verifier)
 *   tsx scripts/build-verifier.ts --check   # exit 1 if stale or unpinned
 *
 * Why it's committed rather than built at deploy time: install.sh must pin
 * the exact bytes it runs, and the site deploy copies both files together
 * (site.yml), so the pin and the file can never ship apart.
 *
 * Staleness is judged by what went IN, not by rebuilding byte-for-byte: the
 * bundle carries a stamp — sha256 over every source file esbuild read (the
 * metafile's inputs, sigstore's dependencies included) plus the build
 * options. So a changed verifier source or a bumped sigstore dependency
 * fails --check, while an esbuild upgrade that merely re-orders the output
 * doesn't.
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
const PIN_RE = /^VERIFIER_SHA256="([0-9a-f]{64})"$/m;

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
    "// autonomOS release-provenance verifier (ADR-122). GENERATED from",
    `// ${ENTRY} by scripts/build-verifier.ts — do not edit; run \`make verifier\`.`,
    "// install.sh pins this file's sha256.",
    `// inputs-sha256: ${stamp}`,
    code,
  ].join("\n");
}

export const sha256 = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
export const readStamp = (verifierText: string) =>
  STAMP_RE.exec(verifierText)?.[1] ?? null;
export const readPin = (installSh: string) => PIN_RE.exec(installSh)?.[1] ?? null;

/** Problems with the committed pair, empty when consistent. */
export async function checkVerifier(): Promise<string[]> {
  const problems: string[] = [];
  const committed = readFileSync(VERIFIER);
  const pin = readPin(readFileSync(INSTALL_SH, "utf-8"));
  if (!pin) problems.push('install.sh has no VERIFIER_SHA256="<sha256>" line');
  else if (pin !== sha256(committed))
    problems.push(
      "install.sh's VERIFIER_SHA256 doesn't match scripts/verify-provenance.mjs — every fresh install would refuse",
    );
  const { stamp } = await bundleVerifier();
  if (readStamp(committed.toString("utf-8")) !== stamp)
    problems.push(
      "scripts/verify-provenance.mjs is stale: its sources or sigstore dependencies changed since it was built",
    );
  return problems;
}

async function main() {
  if (process.argv.includes("--check")) {
    const problems = await checkVerifier();
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) {
      console.error("  Fix: make verifier (rebuilds and re-pins), then commit both files.");
      process.exit(1);
    }
    console.log("✓ verify-provenance.mjs is current and pinned");
    return;
  }
  const { code, stamp } = await bundleVerifier();
  const text = withHeader(code, stamp);
  writeFileSync(VERIFIER, text);
  const sh = readFileSync(INSTALL_SH, "utf-8");
  if (!PIN_RE.test(sh)) throw new Error('install.sh has no VERIFIER_SHA256="…" line to update');
  writeFileSync(INSTALL_SH, sh.replace(PIN_RE, `VERIFIER_SHA256="${sha256(text)}"`));
  console.log(
    `✓ wrote scripts/verify-provenance.mjs (${Math.round(text.length / 1024)} KB), pinned ${sha256(text).slice(0, 12)}…`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
