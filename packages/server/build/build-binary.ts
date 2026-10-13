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
import { RUNTIME_SCRIPTS } from "../src/scriptPaths.js";

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

// node-pty's native pieces are NOT bundled by bun, and must be staged by hand:
//
//   1. `pty.node` — the N-API addon. Under node-pty 1.0.0 (nan) this came along
//      for free: unixTerminal.js had a STATIC `require('../build/Release/pty.node')`
//      that bun's bundler saw and emitted as an asset. 1.1.0 replaced that with
//      `loadNativeModule()`, which builds the path at runtime
//      (`require(dir + "/" + name + ".node")`). bun cannot resolve a computed
//      specifier, so it compiles down to a bare `__require(...)` and the addon is
//      silently left out of the bundle. Staging it is now mandatory.
//   2. `spawn-helper` — a separate executable node-pty posix_spawn()s to set up
//      the PTY before exec'ing the target command. Never bundled (referenced by a
//      runtime path string), and bun bakes node-pty's `__dirname` as the BUILD
//      machine's absolute node_modules path, so the shipped `helperPath` points at
//      a directory that exists on no other machine. Result: agent spawn fails with
//      "posix_spawnp failed." (Intel) or silently produces a zombie child (Apple
//      Silicon, where posix_spawn defers the ENOENT).
//
// Both are staged FLAT next to index.js and both of node-pty's resolution paths
// are repointed at the bundle dir (computed from import.meta.url — note
// import.meta.dirname is NOT populated in a bun --target=node bundle, and
// fileURLToPath correctly decodes the %20 in a ".app" volume path, which
// `.pathname` would not).
//
// Every patch asserts on its anchor, so a node-pty upgrade that changes the
// loader shape fails the build loudly instead of silently shipping a broken
// spawner — which is exactly how the 1.0.0 → 1.1.0 bump surfaced.
function stageNodePtyNative(outdir: string, target: string): void {
  const hostTarget = currentTarget();
  if (target !== hostTarget) {
    // node-pty's native artifacts are platform-specific and this build host only
    // has its own. CI builds every target on its native runner (see
    // .github/workflows/reusable-server-build.yml), so this only trips on a local
    // `--all`. Warn rather than throw: the JS bundle is still useful for
    // inspection, it just cannot spawn an agent.
    console.warn(
      `[build-binary] ! ${target}: skipping node-pty staging (host is ${hostTarget}). ` +
        `This bundle has NO pty.node and cannot spawn agents — build it on a ${target} host.`,
    );
    return;
  }

  // Validate EVERYTHING before mutating the filesystem, so a node-pty shape
  // change (or missing artifact) aborts with `outdir` left pristine rather than
  // half-staged (addon copied next to an un-repointed index.js).
  const ptyRequire = createRequire(import.meta.url);
  const ptyRoot = dirname(ptyRequire.resolve("node-pty/package.json"));

  // 1.1.0 ships prebuilt N-API binaries under prebuilds/<platform>-<arch>/ for
  // darwin and win32. Linux has no prebuild, so `npm install` falls back to
  // `node-gyp rebuild`, which lands in build/Release/. Check both, in the same
  // order node-pty's own loadNativeModule() does.
  const nativeDirs = [
    resolve(ptyRoot, "build/Release"),
    resolve(ptyRoot, `prebuilds/${nodePlatform()}-${nodeArch()}`),
  ];
  const nativeDir = nativeDirs.find((d) => existsSync(resolve(d, "pty.node")));
  if (!nativeDir) {
    throw new Error(
      `[build-binary] node-pty's pty.node not found. Looked in:\n` +
        nativeDirs.map((d) => `  ${d}`).join("\n") +
        `\nnode-pty must be installed with its prebuild downloaded (or node-gyp built) before bundling.`,
    );
  }
  const ptyNodeSrc = resolve(nativeDir, "pty.node");

  // spawn-helper is macOS-ONLY: node-pty's pty.cc posix_spawn()s it under
  // `#if defined(__APPLE__)` and uses plain forkpty() everywhere else (Linux
  // ignores the helperPath argument entirely). node-pty does not even ship one
  // on Linux, which is why unconditionally requiring it broke the Linux build.
  const wantHelper = target.includes("darwin");
  const helperSrc = resolve(nativeDir, "spawn-helper");
  if (wantHelper && !existsSync(helperSrc)) {
    throw new Error(
      `[build-binary] node-pty spawn-helper not found at ${helperSrc}.`,
    );
  }

  const indexPath = resolve(outdir, "index.js");
  let src = readFileSync(indexPath, "utf-8");

  // Anchor 1: the computed-path loader. Appending a bundle-dir attempt INSIDE
  // loadNativeModule (rather than relying on its "./" probe) makes resolution
  // deterministic — its default list tries "../build/Release/" first, which
  // would reach OUTSIDE the install dir and could pick up a stranger's pty.node.
  const dirsAnchor =
    'var dirs = ["build/Release", "build/Debug", "prebuilds/" + process.platform + "-" + process.arch];';
  // Anchor 2: the spawn-helper path, resolved against bun's baked __dirname.
  const helperAnchor = "helperPath = path.resolve(__dirname, helperPath);";

  for (const [label, anchor] of [
    ["loadNativeModule dirs", dirsAnchor],
    ["helperPath", helperAnchor],
  ] as const) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) {
      throw new Error(
        `[build-binary] expected exactly 1 node-pty ${label} anchor, found ${n}. ` +
          `node-pty's loader shape changed — update stageNodePtyNative().`,
      );
    }
  }

  // Validation passed — now mutate.
  src = src.replace(
    dirsAnchor,
    `${dirsAnchor}\n    try { return { dir: __AUTONOMOS_BUNDLE_DIR + "/", module: __require(__AUTONOMOS_BUNDLE_DIR + "/" + name + ".node") }; } catch (e) { lastError = e; }`,
  );
  src = src.replace(
    helperAnchor,
    'helperPath = path.resolve(__AUTONOMOS_BUNDLE_DIR, "spawn-helper");',
  );

  const prelude =
    'import { fileURLToPath as __aoFileURLToPath } from "node:url";\n' +
    'import { dirname as __aoDirname } from "node:path";\n' +
    "const __AUTONOMOS_BUNDLE_DIR = __aoDirname(__aoFileURLToPath(import.meta.url));\n";
  // Insert the constant AFTER the shebang (line 1) so `#!/usr/bin/env node`
  // stays first.
  src = src.startsWith("#!")
    ? src.replace(/^(#![^\n]*\n)/, `$1${prelude}`)
    : prelude + src;

  writeFileSync(indexPath, src);
  copyFileSync(ptyNodeSrc, resolve(outdir, "pty.node"));
  if (wantHelper) {
    copyFileSync(helperSrc, resolve(outdir, "spawn-helper"));
    // node-pty's npm tarball ships spawn-helper mode 644; without +x the
    // posix_spawn fails at runtime with EACCES.
    chmodSync(resolve(outdir, "spawn-helper"), 0o755);
  }
  console.log(
    `[build-binary] ✓ staged node-pty pty.node${wantHelper ? " + spawn-helper" : ""} ` +
      `from ${nativeDir} + repointed paths`,
  );
}

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
