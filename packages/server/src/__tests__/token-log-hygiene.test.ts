import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateHome } from "./helpers/isolate-home.js";

// tightenConfigDirModes CHMODS. A mutation that removes one of its guards must
// only ever reach throwaway dirs, so everything here runs under a fake HOME,
// set BEFORE the server modules load (configDir.ts reads HOME at import).
const isolated = isolateHome("aos-v8");
// Asserted before anything runs: abort the whole file rather than chmod under
// the operator's real HOME.
if (homedir() !== isolated.home)
  throw new Error(`HOME isolation failed: homedir() is ${homedir()}`);
after(() => isolated.restore());
const { describeTokenForLog } = await import("../auth.js");
const { isProtectedDir, tightenConfigDirModes } = await import(
  "../configDir.js"
);
const { createRotatingWriter } = await import("../logger.js");

const mode = (p: string) => statSync(p).mode & 0o777;

describe("describeTokenForLog: the boot banner never carries the token", () => {
  // The old banner was `first4...last4`: for 8 chars or fewer that IS the token.
  // Uppercase-only, so no piece can collide with the words in the output.
  for (const token of ["QZXJ", "QZXJKVWY", "QZXJKVWYQPXB", "QZXJKVWYQPXBZMQ"]) {
    it(`a ${token.length}-char token shows only its length`, () => {
      const line = describeTokenForLog(token);
      assert.equal(line, `(hidden, ${token.length} chars)`);
      for (let i = 0; i + 2 <= token.length; i++)
        assert.ok(
          !line.includes(token.slice(i, i + 2)),
          `no 2-char piece of the token (${token.slice(i, i + 2)})`,
        );
    });
  }

  it("a long token shows only its last 4", () => {
    const token = "0123456789abcdef".repeat(4);
    const line = describeTokenForLog(token);
    assert.ok(line.includes("…cdef"));
    assert.ok(!line.includes(token.slice(0, 4)), "no prefix");
    assert.ok(!line.includes(token.slice(-5)), "no more than 4 chars");
  });
});

describe("tightenConfigDirModes: owner-only on what older builds left loose", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A pre-#301 config dir: 0755 root, 0644 log + backups, run history, token. */
  function looseInstall(): string {
    const root = mkdtempSync(join(tmpdir(), "v8-"));
    dirs.push(root);
    chmodSync(root, 0o755);
    const files: [string, number][] = [
      ["logs/autonomos.log", 0o644],
      ["logs/autonomos.log.1", 0o644],
      ["schedule-runs/nightly.jsonl", 0o644],
      ["env-presets/kimi.json", 0o640],
      ["token", 0o644],
      ["autonomos.pid", 0o644],
      ["agents/a.json", 0o644], // not a secret-bearing dir: left alone
    ];
    for (const [rel, m] of files) {
      const p = join(root, rel);
      mkdirSync(join(p, ".."), { recursive: true, mode: 0o755 });
      chmodSync(join(p, ".."), 0o755);
      writeFileSync(p, rel === "token" ? "secret-token" : "x");
      chmodSync(p, m);
    }
    chmodSync(root, 0o755);
    return root;
  }

  it("removes group/other bits from the root, the secret-bearing dirs and their files", () => {
    const root = looseInstall();
    const changed = tightenConfigDirModes(root);
    assert.equal(mode(root), 0o700);
    for (const d of ["logs", "schedule-runs", "env-presets"])
      assert.equal(mode(join(root, d)), 0o700, d);
    for (const f of [
      "logs/autonomos.log",
      "logs/autonomos.log.1",
      "schedule-runs/nightly.jsonl",
      "env-presets/kimi.json",
      "token",
      "autonomos.pid",
    ])
      assert.equal(mode(join(root, f)), 0o600, f);
    assert.equal(mode(join(root, "agents/a.json")), 0o644, "out of scope");
    assert.ok(changed.includes(join(root, "logs/autonomos.log")));
  });

  it("never breaks auth: the owner still reads the token, and the owner bits are untouched", () => {
    const root = looseInstall();
    chmodSync(join(root, "token"), 0o664);
    tightenConfigDirModes(root);
    assert.equal(readFileSync(join(root, "token"), "utf8"), "secret-token");
    assert.equal(mode(join(root, "token")), 0o600, "only group/other removed");
  });

  it("is idempotent: a second boot changes nothing", () => {
    const root = looseInstall();
    tightenConfigDirModes(root);
    assert.deepEqual(tightenConfigDirModes(root), []);
  });

  it("does not follow a symlink out of the config dir", () => {
    const root = looseInstall();
    const outside = mkdtempSync(join(tmpdir(), "v8-out-"));
    dirs.push(outside);
    chmodSync(outside, 0o755);
    rmSync(join(root, "logs"), { recursive: true });
    symlinkSync(outside, join(root, "logs"));
    tightenConfigDirModes(root);
    assert.equal(mode(outside), 0o755);
  });

  it("precondition: HOME is the throwaway one", () => {
    assert.equal(homedir(), isolated.home);
  });

  it("refuses a home, an ancestor of a home, and / (and only those)", () => {
    assert.equal(isProtectedDir("/", []), true, "/ even with no home known");
    const homes = ["/Users/alice", "/home/bob/"];
    for (const d of [
      "/",
      "/Users",
      "/Users/",
      "/Users/alice",
      "/home",
      "/home/bob",
    ])
      assert.equal(isProtectedDir(d, homes), true, d);
    for (const d of [
      "/Users/alice/.autonomos",
      "/Users/alicex",
      "/tmp/x",
      "/home/bobby",
    ])
      assert.equal(isProtectedDir(d, homes), false, d);
  });

  it("leaves a home and its ancestors alone on disk", () => {
    // base/ (0755) → base/home/ (0755), both throwaway. Pass base/home as the
    // "home": neither it nor its parent may change.
    const base = mkdtempSync(join(tmpdir(), "v8-anc-"));
    dirs.push(base);
    const home = join(base, "home");
    mkdirSync(home);
    // Markers, so only the protected-dir check can be what leaves them alone.
    writeFileSync(join(base, "token"), "t");
    writeFileSync(join(home, "token"), "t");
    chmodSync(base, 0o755);
    chmodSync(home, 0o755);
    assert.deepEqual(tightenConfigDirModes(home, [home]), []);
    assert.deepEqual(tightenConfigDirModes(base, [home]), []);
    assert.equal(mode(home), 0o755);
    assert.equal(mode(base), 0o755);
  });

  it("identity, not spelling: a case variant or a symlinked parent of a home is still protected (#449)", () => {
    // base/Users/alice is the "home", with markers so only protection can save it.
    const base = mkdtempSync(join(tmpdir(), "v8-id-"));
    dirs.push(base);
    const home = join(base, "Users", "alice");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "token"), "t");
    writeFileSync(join(base, "Users", "token"), "t");
    chmodSync(home, 0o755);
    chmodSync(join(base, "Users"), 0o755);
    symlinkSync(join(base, "Users"), join(base, "link"));

    const variants = [
      join(base, "link", "alice"), // a symlinked parent
      join(base, "USERS", "ALICE"), // a case variant (case-insensitive volume)
      join(base, "USERS"), // an ancestor's case variant
    ];
    for (const v of variants) {
      if (!existsSync(v)) continue; // case-sensitive volume: not the same dir
      assert.equal(isProtectedDir(v, [home]), true, v);
      assert.deepEqual(tightenConfigDirModes(v, [home]), [], v);
    }
    assert.equal(mode(home), 0o755);
    assert.equal(mode(join(base, "Users")), 0o755);
  });

  it("identity check with an injected stat: same inode under another name is protected", () => {
    const inodes: Record<string, number> = {
      "/Users/alice": 7,
      "/Users": 3,
      "/": 1,
      "/Volumes/x/alias": 7, // same inode as the home
      "/Volumes/x/other": 9,
    };
    const stat = (p: string) => {
      if (!(p in inodes)) throw new Error("ENOENT");
      return { dev: 1, ino: inodes[p] };
    };
    assert.equal(
      isProtectedDir("/Volumes/x/alias", ["/Users/alice"], stat),
      true,
    );
    assert.equal(
      isProtectedDir("/Volumes/x/other", ["/Users/alice"], stat),
      false,
    );
  });

  it("protects a home's REAL ancestors when a parent is a symlink (/home -> /data/home)", () => {
    const inodes: Record<string, number> = {
      "/home/alice": 7, // lexical spelling of the home
      "/home": 5, // the symlink itself resolves to /data/home's inode
      "/data/home/alice": 7,
      "/data/home": 5,
      "/data": 4, // only reachable through the RESOLVED chain
      "/": 1,
    };
    const stat = (p: string) => {
      if (!(p in inodes)) throw new Error("ENOENT");
      return { dev: 1, ino: inodes[p] };
    };
    const real = (p: string) => (p === "/home/alice" ? "/data/home/alice" : p);
    assert.equal(isProtectedDir("/data", ["/home/alice"], stat, real), true);
    assert.equal(
      isProtectedDir("/data/other", ["/home/alice"], stat, real),
      false,
    );
  });

  it("…and on disk: a throwaway /data behind a symlinked parent stays untouched", () => {
    const base = mkdtempSync(join(tmpdir(), "v8-real-"));
    dirs.push(base);
    const data = join(base, "data");
    mkdirSync(join(data, "home", "alice"), { recursive: true });
    symlinkSync(join(data, "home"), join(base, "home"));
    writeFileSync(join(data, "token"), "t"); // a marker: only protection saves it
    chmodSync(data, 0o755);
    const home = join(base, "home", "alice"); // spelled through the symlink
    assert.deepEqual(tightenConfigDirModes(data, [home]), []);
    assert.equal(mode(data), 0o755);
  });

  it("leaves alone a directory that isn't (yet) an autonomOS config dir", () => {
    const d = mkdtempSync(join(tmpdir(), "v8-unmarked-"));
    dirs.push(d);
    writeFileSync(join(d, "notes.txt"), "x");
    chmodSync(d, 0o755);
    assert.deepEqual(tightenConfigDirModes(d, []), []);
    assert.equal(mode(d), 0o755);
  });

  it("is a no-op for a missing dir", () => {
    assert.deepEqual(tightenConfigDirModes(join(tmpdir(), "v8-nope-x")), []);
  });
});

describe("the rotating log writer", () => {
  it("re-tightens an existing 0644 log to 0600 and creates rotated segments 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "v8-log-"));
    try {
      const p = join(root, "logs", "autonomos.log");
      mkdirSync(join(root, "logs"));
      writeFileSync(p, "old\n");
      chmodSync(p, 0o644);
      const w = createRotatingWriter(p, 16, 2, 0o600);
      assert.equal(mode(p), 0o600, "existing file re-tightened");
      w.write("0123456789abcdef-rotate\n");
      w.write("fresh segment\n");
      assert.equal(mode(p), 0o600, "fresh segment after rotation");
      assert.equal(mode(`${p}.1`), 0o600, "rotated backup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
