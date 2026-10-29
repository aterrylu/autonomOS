// Stages node-pty's native pieces into a server bundle (used by
// build-binary.ts; a module of its own so tests can drive it on a fake tree).

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { dirname, resolve } from "node:path";

/** The repointed spawn-helper path the bundle must carry. */
export const HELPER_REPOINT =
  'helperPath = path.resolve(__AUTONOMOS_BUNDLE_DIR, "spawn-helper");';
/** node-pty's own line, which must NOT survive (it bakes the build host's path). */
export const HELPER_ANCHOR = "helperPath = path.resolve(__dirname, helperPath);";

export function currentTarget(): string {
  const plat = nodePlatform();
  const arch = nodeArch();
  if (plat === "darwin" && arch === "arm64") return "bun-darwin-arm64";
  if (plat === "darwin" && arch === "x64") return "bun-darwin-x64";
  if (plat === "linux" && arch === "x64") return "bun-linux-x64";
  if (plat === "linux" && arch === "arm64") return "bun-linux-arm64";
  throw new Error(`Unsupported build host: ${plat}/${arch}`);
}

/**
 * Fails the build unless the staged bundle really can spawn: pty.node next to
 * index.js, index.js repointed (and node-pty's build-host path gone), and on
 * macOS an EXECUTABLE spawn-helper (node-pty's tarball ships it 644; without
 * +x every spawn dies with "posix_spawnp failed").
 */
export function assertStagedNodePty(outdir: string, wantHelper: boolean): void {
  const problems: string[] = [];
  if (!existsSync(resolve(outdir, "pty.node"))) problems.push("no pty.node");
  const src = readFileSync(resolve(outdir, "index.js"), "utf-8");
  if (!src.includes("__AUTONOMOS_BUNDLE_DIR + \"/\" + name + \".node\""))
    problems.push("the addon loader was not repointed at the bundle dir");
  if (wantHelper) {
    const helper = resolve(outdir, "spawn-helper");
    if (!existsSync(helper)) problems.push("no spawn-helper");
    else {
      try {
        accessSync(helper, constants.X_OK);
      } catch {
        problems.push("spawn-helper is not executable");
      }
    }
    if (!src.includes(HELPER_REPOINT))
      problems.push("helperPath was not repointed at the bundle dir");
    if (src.includes(HELPER_ANCHOR))
      problems.push("node-pty's build-host helperPath line is still there");
  }
  if (problems.length) {
    throw new Error(
      `[build-binary] staged node-pty is broken in ${outdir}: ${problems.join("; ")}.`,
    );
  }
}

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
export function stageNodePtyNative(
  outdir: string,
  target: string,
  opts: { ptyRoot?: string; hostTarget?: string } = {},
): void {
  const hostTarget = opts.hostTarget ?? currentTarget();
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
  const ptyRoot =
    opts.ptyRoot ??
    dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));

  // 1.1.0 ships prebuilt N-API binaries under prebuilds/<platform>-<arch>/ for
  // darwin and win32. Linux has no prebuild, so `npm install` falls back to
  // `node-gyp rebuild`, which lands in build/Release/. Check both, in the same
  // order node-pty's own loadNativeModule() does.
  const nativeDirs = [
    resolve(ptyRoot, "build/Release"),
    resolve(ptyRoot, `prebuilds/${target.replace(/^bun-/, "")}`),
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
  const helperAnchor = HELPER_ANCHOR;

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
    HELPER_REPOINT,
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
  // Check the OUTPUT, not just the steps: a missed chmod or a repoint that
  // didn't land ships a bundle where every macOS spawn dies (#532).
  assertStagedNodePty(outdir, wantHelper);
  console.log(
    `[build-binary] ✓ staged node-pty pty.node${wantHelper ? " + spawn-helper" : ""} ` +
      `from ${nativeDir} + repointed paths`,
  );
}
