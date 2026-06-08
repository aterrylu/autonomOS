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
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
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

// node-pty ships a separate `spawn-helper` executable that its native addon
// posix_spawn()s to set up the PTY before exec'ing the target command. bun does
// NOT bundle it (it's referenced by a runtime path string, not an import), and
// worse, bun bakes node-pty's `__dirname` as the BUILD machine's absolute
// node_modules path — so the bundled `helperPath` (`<__dirname>/../build/Release/
// spawn-helper`) points at a location that does not exist inside the shipped app
// or on any other machine. Result: agent spawn fails with "posix_spawnp failed."
// (Intel) or silently produces a zombie child (Apple Silicon, where posix_spawn
// defers the ENOENT). This staged neither caught it because the smoke test only
// asserted the spawn HTTP response, not that the child actually lives.
//
// Fix: copy spawn-helper next to index.js and repoint node-pty's resolution to
// the runtime bundle dir via import.meta.url (import.meta.dirname is NOT
// populated in a bun --target=node bundle; fileURLToPath also decodes the %20 in
// the ".app" volume path, which `.pathname` would not). Asserts on the anchor so
// a node-pty upgrade that changes the shape fails the build loudly instead of
// silently shipping a broken spawner.
function stageNodePtySpawnHelper(outdir: string, target: string): void {
  // spawn-helper is macOS-ONLY: node-pty's native pty.cc uses posix_spawn() of
  // the helper under `#if defined(__APPLE__)`, and plain forkpty() everywhere
  // else (Linux ignores the helperPath arg entirely). So there's nothing to
  // stage or repoint for non-darwin targets — and node-pty doesn't even ship a
  // spawn-helper there, which is why requiring it would (and did) break the
  // Linux server build. Key off the TARGET (not the build host) so `--all` on a
  // Mac doesn't try to stage a darwin helper into the Linux bundles.
  if (!target.includes("darwin")) return;

  // Validate EVERYTHING before mutating the filesystem, so a node-pty shape
  // change (or missing helper) aborts with `outdir` left pristine rather than
  // half-staged (helper copied next to an un-repointed index.js). Matters if
  // this is ever wrapped in a continue-on-error loop.
  const ptyRequire = createRequire(import.meta.url);
  const ptyPkg = ptyRequire.resolve("node-pty/package.json");
  const helperSrc = resolve(dirname(ptyPkg), "build/Release/spawn-helper");
  if (!existsSync(helperSrc)) {
    throw new Error(
      `[build-binary] node-pty spawn-helper not found at ${helperSrc}. ` +
        `node-pty must be built before bundling (its prebuilt or node-gyp output).`,
    );
  }

  const indexPath = resolve(outdir, "index.js");
  const src = readFileSync(indexPath, "utf-8");
  const anchor = "helperPath = path.resolve(__dirname, helperPath);";
  const occurrences = src.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[build-binary] expected exactly 1 node-pty helperPath anchor, found ${occurrences}. ` +
        `node-pty's loader shape changed — update stageNodePtySpawnHelper().`,
    );
  }

  // Validation passed — now mutate. Repoint node-pty to resolve spawn-helper from
  // the runtime bundle dir (computed from import.meta.url) instead of bun's baked
  // build-machine __dirname. The occurrences===1 check above guarantees the
  // single-arg replace() below hits the one and only anchor.
  const prelude =
    'import { fileURLToPath as __aoFileURLToPath } from "node:url";\n' +
    'import { dirname as __aoDirname } from "node:path";\n' +
    "const __AUTONOMOS_BUNDLE_DIR = __aoDirname(__aoFileURLToPath(import.meta.url));\n";
  const repointed = src.replace(
    anchor,
    'helperPath = path.resolve(__AUTONOMOS_BUNDLE_DIR, "spawn-helper");',
  );
  // Insert the constant AFTER the shebang (line 1) so `#!/usr/bin/env node`
  // stays first.
  const patched = repointed.startsWith("#!")
    ? repointed.replace(/^(#![^\n]*\n)/, `$1${prelude}`)
    : prelude + repointed;

  writeFileSync(indexPath, patched);
  copyFileSync(helperSrc, resolve(outdir, "spawn-helper"));
  chmodSync(resolve(outdir, "spawn-helper"), 0o755);
  console.log("[build-binary] ✓ staged node-pty spawn-helper + repointed path");
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
  stageNodePtySpawnHelper(outdir, target);
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
