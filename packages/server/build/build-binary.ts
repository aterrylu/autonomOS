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
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { fileURLToPath } from "node:url";

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

function currentTarget(): string {
  const plat = nodePlatform();
  const arch = nodeArch();
  if (plat === "darwin" && arch === "arm64") return "bun-darwin-arm64";
  if (plat === "darwin" && arch === "x64") return "bun-darwin-x64";
  if (plat === "linux" && arch === "x64") return "bun-linux-x64";
  if (plat === "linux" && arch === "arm64") return "bun-linux-arm64";
  throw new Error(`Unsupported build host: ${plat}/${arch}`);
}

const wantAll = process.argv.includes("--all");
const targets = wantAll ? [...ALL_TARGETS] : [currentTarget()];

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
