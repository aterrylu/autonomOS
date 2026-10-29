// Builds an autonomos-server Node-runtime JS bundle.
//
// IMPORTANT (Phase 1A.1 finding): the Bun *runtime* cannot load node-pty's
// prebuilt native binding (Bun 1.3.10 ABI 137 vs node-pty ABI 141). This blocks
// both `bun build --compile` (static binary) AND `bun build --target=bun`
// (runnable JS bundle). The path that works today is `--target=node`: bundle
// produced for Node, run via `node dist/<platform>/index.js`. Node loads
// node-pty's prebuilt cleanly because they share an ABI lineage.
//
// For Phase 1B (Electron desktop), this is what's needed: Electron bundles
// Node + this JS bundle in the .app, spawns it as a child process. The
// `--compile` static binary aspiration is deferred until either Bun's ABI
// matches node-pty or we switch PTY implementation to Bun's native API.
//
// Default behavior (no args): bundles for the current host platform.
// Pass --all to also produce builds tagged with each release target name
// (the underlying bundle is platform-agnostic JS; the suffix is just for
// downstream consumers who want one named artifact per platform).
//
// Prerequisite: packages/server/src/_embedded_dashboard/ must exist
// (see build/embed-dashboard.ts). This script does NOT run that step itself
// to keep responsibilities clean — the root build:binary script chains them.

import { $ } from "bun";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_SCRIPTS } from "../src/scriptPaths.js";
import { currentTarget, stageNodePtyNative } from "./stage-node-pty.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "../..");
// Phase 1C: the CLI is the top-level entry — it dispatches to server runServer()
// for the `start` subcommand (or argv-only invocation per Phase 1B contract).
// One bundle produces both the CLI tools (status/stop/install-service/...)
// AND the server it manages.
const entry = resolve(repoRoot, "packages/cli/src/index.ts");
const distDir = resolve(serverRoot, "dist");
const embeddedDashboard = resolve(serverRoot, "src/_embedded_dashboard");

// Bun's CLI eats unknown long-flags before passing argv to the script, so we
// use an env var instead. Set TARBALL=1 to produce per-platform .tar.gz
// alongside the bundle directories.
const wantTarball = process.env.TARBALL === "1";

if (!existsSync(embeddedDashboard)) {
  console.error(
    `[build-binary] Missing embedded dashboard at ${embeddedDashboard}.\n` +
      `Run "bun run build:dashboard && bun packages/server/build/embed-dashboard.ts" first,\n` +
      `or use the root "bun run build:binary" script which chains both steps.`,
  );
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });

const ALL_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;


const wantAll = process.argv.includes("--all");
const targets = wantAll ? [...ALL_TARGETS] : [currentTarget()];


// Runtime-loaded .mjs scripts (statusline renderer, MCP channel-server) are
// referenced by PATH, not import — bun never sees them, so like the embedded
// dashboard they must be copied in by hand. The bundle concatenates every
// module into index.js, so each script's `resolve(import.meta.dirname, rel)`
// in src/scriptPaths.ts resolves against the BUNDLE dir at runtime; staging
// each script at the same relative path keeps source + bundle consistent by
// construction. Missing source file aborts the build — shipping without one
// reproduces the silent desktop statusline outage this guards against.
function stageRuntimeScripts(outdir: string): void {
  for (const rel of RUNTIME_SCRIPTS) {
    const src = resolve(serverRoot, "src", rel);
    if (!existsSync(src)) {
      throw new Error(
        `[build-binary] runtime script missing at ${src}. ` +
          `RUNTIME_SCRIPTS in src/scriptPaths.ts is out of sync with the tree.`,
      );
    }
    const dest = resolve(outdir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  // Manifest of what this build staged, one path per line. smoke-test-bundle.sh
  // loops over it instead of hardcoding a second copy of the list — so adding
  // an entry to RUNTIME_SCRIPTS automatically extends the bundle-side check.
  writeFileSync(
    resolve(outdir, "runtime-scripts.manifest"),
    `${RUNTIME_SCRIPTS.join("\n")}\n`,
  );
  console.log(
    `[build-binary] ✓ staged runtime scripts: ${RUNTIME_SCRIPTS.join(", ")}`,
  );
}

for (const target of targets) {
  const suffix = target.replace("bun-", "");
  const outdir = resolve(distDir, suffix);
  console.log(`[build-binary] Bundling into ${outdir} ...`);
  await $`bun build ${entry} --target=node --outdir=${outdir}`.cwd(serverRoot);
  // bun build only outputs JS + native .node assets it sees. The dashboard
  // static files aren't reachable through `import` so we copy them in by hand.
  const dashCopy = resolve(outdir, "_embedded_dashboard");
  rmSync(dashCopy, { recursive: true, force: true });
  cpSync(embeddedDashboard, dashCopy, { recursive: true });
  // Also write a minimal package.json so the bundled version-reader and the
  // upgrade flow can read the version string at runtime.
  const serverPkg = JSON.parse(
    readFileSync(resolve(serverRoot, "package.json"), "utf-8"),
  ) as { name: string; version: string };
  writeFileSync(
    resolve(outdir, "package.json"),
    `${JSON.stringify({ name: serverPkg.name, version: serverPkg.version, type: "module" }, null, 2)}\n`,
  );
  stageNodePtyNative(outdir, target);
  stageRuntimeScripts(outdir);
  console.log(`[build-binary] ✓ ${outdir}/index.js (+ embedded dashboard)`);

  if (wantTarball) {
    const tarball = resolve(distDir, `autonomos-${suffix}.tar.gz`);
    rmSync(tarball, { force: true });
    // -C the outdir then tar `.` so the archive doesn't carry a useless
    // parent directory prefix; consumers (install.sh) untar into a clean dir.
    await $`tar -czf ${tarball} -C ${outdir} .`;
    console.log(`[build-binary] ✓ ${tarball}`);
  }
}
console.log(
  `[build-binary] Done. ${targets.length} bundle${targets.length === 1 ? "" : "s"} in ${distDir}.\n` +
    `[build-binary] Run via: node ${distDir}/<platform>/index.js`,
);
