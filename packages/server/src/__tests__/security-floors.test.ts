import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import {
  checkInstalledFloors,
  checkLockfileFloors,
  compareVersions,
  formatFloorViolations,
  SECURITY_FLOORS,
} from "../securityFloors.js";

/**
 * Security audit V12b: bumping a vulnerable dependency in package.json didn't
 * reach the code that runs. bun keeps a per-parent nested copy whenever the
 * parent's range allows it, so after the ws bump @hono/node-ws (which builds
 * every server WebSocketServer) still loaded ws 8.19. And `bun install` on an
 * existing tree doesn't relink a nested copy the new lockfile no longer
 * lists, so a managed clone upgraded through `make build` stayed vulnerable.
 * Guards, one per layer:
 *  - the repo's bun.lock pins each floored package exactly once, at or above
 *    its floor;
 *  - the installed-tree check resolves each package the way Node does from
 *    each consumer (it powers the boot warning and `autonomos status`);
 *  - `make build`, which every upgrade path runs, relinks the tree.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const tmp: string[] = [];
after(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("the repo's bun.lock meets the security floors (audit V12/V12b)", () => {
  it("pins every floored package once, at or above its floor", () => {
    const problems = checkLockfileFloors(
      readFileSync(join(REPO, "bun.lock"), "utf8"),
    );
    assert.deepEqual(
      problems,
      [],
      `bun.lock: ${JSON.stringify(problems)}. A nested entry ("<parent>/<pkg>") ` +
        "is a second copy some package still loads. Delete that line and run " +
        "bun install so everything shares the top-level version.",
    );
  });

  it("refuses a nested copy below the floor", () => {
    const lock = [
      `    "ws": ["ws@8.22.0", "", {}, "sha512-x"],`,
      `    "@hono/node-ws/ws": ["ws@8.19.0", "", {}, "sha512-y"],`,
      `    "hono": ["hono@4.13.12", "", {}, "sha512-z"],`,
    ].join("\n");
    const [p] = checkLockfileFloors(lock);
    assert.equal(p.pkg, "ws");
    assert.equal(p.reason, "below-floor");
    assert.deepEqual(
      p.entries.map((e) => e.key),
      ["ws", "@hono/node-ws/ws"],
    );
  });

  it("refuses a second copy even when it's above the floor", () => {
    const lock = [
      `    "ws": ["ws@8.22.0", "", {}, "sha512-x"],`,
      `    "jsdom/ws": ["ws@8.21.3", "", {}, "sha512-y"],`,
      `    "hono": ["hono@4.13.12", "", {}, "sha512-z"],`,
    ].join("\n");
    assert.equal(checkLockfileFloors(lock)[0]?.reason, "multiple-copies");
  });

  it("reads scoped package names", () => {
    const floors = [{ pkg: "@scope/a", min: "2.0.0", why: "", seenBy: [] }];
    const lock = `    "@scope/a": ["@scope/a@1.9.9", "", {}, "sha512-x"],`;
    assert.equal(checkLockfileFloors(lock, floors)[0]?.reason, "below-floor");
  });

  it("compares versions numerically", () => {
    assert.equal(compareVersions("8.21.1", "8.21.1"), 0);
    assert.equal(compareVersions("8.9.0", "8.21.1"), -1);
    assert.equal(compareVersions("4.13.12", "4.13.9"), 1);
  });
});

/** A packages/server with bun's isolated layout: each package's real
 *  directory lives in node_modules/.bun/<name>@<v>/node_modules/<name>, and
 *  its own dependencies are symlinks next to it. */
function fixtureTree(nodeWsSees: string): string {
  const root = mkdtempSync(join(tmpdir(), "aos-floors-"));
  tmp.push(root);
  const store = join(root, "node_modules", ".bun");
  const real = (name: string, version: string) => {
    const dir = join(store, `${name.replace("/", "+")}@${version}`);
    const pkgDir = join(dir, "node_modules", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name, version }),
    );
    return { dir, pkgDir };
  };
  const link = (at: string, target: string) => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(relative(dirname(at), target), at);
  };
  const ws19 = real("ws", "8.19.0");
  const ws22 = real("ws", "8.22.0");
  const hono = real("hono", "4.13.12");
  const nodeWs = real("@hono/node-ws", "1.3.0");
  link(
    join(nodeWs.dir, "node_modules", "ws"),
    nodeWsSees === "8.19.0" ? ws19.pkgDir : ws22.pkgDir,
  );
  link(join(nodeWs.dir, "node_modules", "hono"), hono.pkgDir);

  const server = join(root, "packages", "server");
  mkdirSync(server, { recursive: true });
  writeFileSync(
    join(server, "package.json"),
    JSON.stringify({ name: "@autonomos/server" }),
  );
  link(join(server, "node_modules", "ws"), ws22.pkgDir);
  link(join(server, "node_modules", "hono"), hono.pkgDir);
  link(join(server, "node_modules", "@hono", "node-ws"), nodeWs.pkgDir);
  return server;
}

describe("the installed-tree check resolves as each consumer does (audit V12b)", () => {
  it("flags a stale nested ws that only @hono/node-ws loads", () => {
    const v = checkInstalledFloors(fixtureTree("8.19.0"));
    assert.deepEqual(v, [
      {
        pkg: "ws",
        min: "8.21.1",
        why: SECURITY_FLOORS[0].why,
        version: "8.19.0",
        seenBy: "@hono/node-ws",
      },
    ]);
    const text = formatFloorViolations(v ?? [], "/srv/autonomos");
    assert.match(text, /ws 8\.19\.0 \(loaded by @hono\/node-ws\)/);
    assert.match(text, /cd \/srv\/autonomos && bun install --force/);
  });

  it("passes once the tree is relinked", () => {
    assert.deepEqual(checkInstalledFloors(fixtureTree("8.22.0")), []);
  });

  it("says nothing when the directory isn't the server package (bundle install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-floors-bundle-"));
    tmp.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    assert.equal(checkInstalledFloors(dir), null);
  });
});

describe("every upgrade path relinks the dependency tree (audit V12b)", () => {
  // In-app update, `autonomos upgrade`/`rollback` (sourceUpgrade.ts) and
  // install-source.sh (make prod) all run `make build`. A plain `bun install`
  // keeps a nested copy the new lockfile no longer lists (measured: a managed
  // clone upgraded to the ws 8.22 commit still served ws 8.19).
  it("make build runs bun install --force", () => {
    const makefile = readFileSync(join(REPO, "Makefile"), "utf8");
    const build = makefile.split(/^build:/m)[1]?.split(/^\S[^\n]*:/m)[0] ?? "";
    assert.match(build, /\$\(BUN\) install --force\b/);
  });
});
