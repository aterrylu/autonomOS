/**
 * The release bundle's node-pty staging (build/stage-node-pty.ts) must ship a
 * bundle that can spawn on macOS:
 *  - spawn-helper staged EXECUTABLE (node-pty 1.1.0's tarball ships it 644;
 *    without +x every spawn dies with "posix_spawnp failed", #532);
 *  - helperPath repointed at the bundle dir (node-pty's own line bakes the
 *    BUILD machine's node_modules path);
 *  - a loader shape it doesn't recognize fails the build loudly.
 * Driven on a fake node-pty tree, so it runs on every CI host.
 */

import assert from "node:assert/strict";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  assertStagedNodePty,
  HELPER_ANCHOR,
  HELPER_REPOINT,
  stageNodePtyNative,
} from "../../build/stage-node-pty.js";

const DIRS_ANCHOR =
  'var dirs = ["build/Release", "build/Debug", "prebuilds/" + process.platform + "-" + process.arch];';
const TARGET = "bun-darwin-arm64";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A node-pty 1.1.0-shaped tree (helper 644, as npm ships it) and an outdir
 *  whose index.js holds node-pty's two loader lines. */
function fixture(index = `${DIRS_ANCHOR}\n${HELPER_ANCHOR}\n`) {
  const root = mkdtempSync(join(tmpdir(), "aos-stage-pty-"));
  roots.push(root);
  const ptyRoot = join(root, "node-pty");
  const native = join(ptyRoot, "prebuilds/darwin-arm64");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "pty.node"), "addon");
  writeFileSync(join(native, "spawn-helper"), "#!/bin/sh\n");
  chmodSync(join(native, "spawn-helper"), 0o644);
  const outdir = join(root, "out");
  mkdirSync(outdir);
  writeFileSync(join(outdir, "index.js"), index);
  return { ptyRoot, outdir };
}

const stage = (f: ReturnType<typeof fixture>) =>
  stageNodePtyNative(f.outdir, TARGET, {
    ptyRoot: f.ptyRoot,
    hostTarget: TARGET,
  });

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

describe("release bundle: node-pty staging (macOS)", () => {
  it("stages an EXECUTABLE spawn-helper from a 644 source and repoints helperPath", () => {
    const f = fixture();
    // Precondition: the source really is 644, like node-pty's tarball.
    assert.equal(
      statSync(join(f.ptyRoot, "prebuilds/darwin-arm64/spawn-helper")).mode &
        0o111,
      0,
    );
    stage(f);
    assert.ok(executable(join(f.outdir, "spawn-helper")));
    const src = readFileSync(join(f.outdir, "index.js"), "utf-8");
    assert.ok(src.includes(HELPER_REPOINT), "helperPath repointed");
    assert.ok(!src.includes(HELPER_ANCHOR), "build-host helperPath is gone");
  });

  it("fails the build loudly when node-pty's helperPath line isn't there", () => {
    const f = fixture(`${DIRS_ANCHOR}\nhelperPath = somethingElse;\n`);
    assert.throws(() => stage(f), /expected exactly 1 node-pty helperPath/);
  });

  it("the output check refuses a 644 helper, a missing repoint, and a leftover build-host path", () => {
    const f = fixture();
    stage(f);
    assert.doesNotThrow(() => assertStagedNodePty(f.outdir, true));

    chmodSync(join(f.outdir, "spawn-helper"), 0o644);
    assert.throws(
      () => assertStagedNodePty(f.outdir, true),
      /spawn-helper is not executable/,
    );
    chmodSync(join(f.outdir, "spawn-helper"), 0o755);

    const indexPath = join(f.outdir, "index.js");
    const good = readFileSync(indexPath, "utf-8");
    writeFileSync(indexPath, good.replace(HELPER_REPOINT, HELPER_ANCHOR));
    assert.throws(
      () => assertStagedNodePty(f.outdir, true),
      /helperPath was not repointed.*build-host helperPath line is still there/,
    );
  });
});
