import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * scripts/ensure-node-pty.sh (the root postinstall, and now the gate's first
 * step) must leave the spawn-helper of the node-pty the SERVER loads executable.
 *
 * The bug it guards: the store held a stale node-pty@1.0.0 next to @1.1.0. The
 * script checked "the first copy with an addon", and @1.0.0 sorts first, so it
 * chmodded the stale copy while the server loaded @1.1.0, whose prebuilt helper
 * npm ships as 644. Every PTY spawn then failed with "posix_spawnp failed.":
 * 54 failures in one pre-push gate, read as "flaky under load".
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "ensure-node-pty.sh");
const PLATFORM = `${process.platform}-${process.arch}`;

/** The real addon, so the script's dlopen ABI check passes on any platform. */
function realAddon(): string {
  const req = createRequire(join(REPO, "packages", "server", "package.json"));
  const dir = dirname(req.resolve("node-pty/package.json"));
  for (const c of [
    join(dir, "build", "Release", "pty.node"),
    join(dir, "prebuilds", PLATFORM, "pty.node"),
  ])
    if (existsSync(c)) return c;
  throw new Error(`no pty.node under ${dir}`);
}

const executable = (p: string) => (statSync(p).mode & 0o111) !== 0;

describe("ensure-node-pty.sh", () => {
  let root = "";
  let stale = "";
  let real = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ensure-pty-"));
    const store = join(root, "node_modules", ".bun");
    // A stale node-pty@1.0.0: sorts FIRST, has an addon, its helper is fine.
    stale = join(store, "node-pty@1.0.0", "node_modules", "node-pty");
    mkdirSync(join(stale, "build", "Release"), { recursive: true });
    copyFileSync(realAddon(), join(stale, "build", "Release", "pty.node"));
    writeFileSync(join(stale, "build", "Release", "spawn-helper"), "x");
    chmodSync(join(stale, "build", "Release", "spawn-helper"), 0o755);
    writeFileSync(join(stale, "package.json"), '{"name":"node-pty","version":"1.0.0"}');
    // The node-pty@1.1.0 the server actually loads: prebuilt helper shipped 644.
    real = join(store, "node-pty@1.1.0", "node_modules", "node-pty");
    mkdirSync(join(real, "prebuilds", PLATFORM), { recursive: true });
    copyFileSync(realAddon(), join(real, "prebuilds", PLATFORM, "pty.node"));
    writeFileSync(join(real, "prebuilds", PLATFORM, "spawn-helper"), "x");
    chmodSync(join(real, "prebuilds", PLATFORM, "spawn-helper"), 0o644);
    writeFileSync(join(real, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = () =>
    spawnSync("bash", [SCRIPT], { cwd: root, encoding: "utf8" });

  it("a stale node-pty@1.0.0 sorting first doesn't stop the SERVER's copy from being fixed", () => {
    mkdirSync(join(root, "packages", "server", "node_modules"), {
      recursive: true,
    });
    symlinkSync(real, join(root, "packages", "server", "node_modules", "node-pty"));
    const helper = join(real, "prebuilds", PLATFORM, "spawn-helper");
    assert.equal(executable(helper), false, "precondition: shipped 644");
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      executable(helper),
      true,
      "the helper the server loads must be executable, or every spawn fails",
    );
    // ...and the ABI check ran on the server's copy, not the stale one.
    assert.match(r.stdout, /OK — pty\.node loads/);
  });

  it("without a resolvable server copy, every store copy's helper is still fixed", () => {
    const helper = join(real, "prebuilds", PLATFORM, "spawn-helper");
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(executable(helper), true);
  });

  it("an already-executable helper is left alone (idempotent, nothing printed)", () => {
    chmodSync(join(real, "prebuilds", PLATFORM, "spawn-helper"), 0o755);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /chmod \+x/);
  });
});
