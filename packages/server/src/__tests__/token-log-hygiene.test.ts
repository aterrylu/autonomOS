import assert from "node:assert/strict";
import {
  chmodSync,
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
import { describeTokenForLog } from "../auth.js";
import { tightenConfigDirModes } from "../configDir.js";
import { createRotatingWriter } from "../logger.js";

/**
 * V8: the operator token never reaches a log, and what older builds created
 * loose is made owner-only on boot, without ever breaking auth.
 */

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

  it("refuses to touch the home directory itself", () => {
    // NEVER the real home: with the guard mutated away, this would chmod the
    // operator's ~ (it happened once, during this PR's own mutation run).
    // os.homedir() reads $HOME, so point it at a throwaway dir for the call.
    const fakeHome = mkdtempSync(join(tmpdir(), "v8-home-"));
    dirs.push(fakeHome);
    chmodSync(fakeHome, 0o755);
    const saved = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      assert.equal(homedir(), fakeHome, "precondition: homedir() is the fake");
      assert.deepEqual(tightenConfigDirModes(fakeHome), []);
    } finally {
      process.env.HOME = saved;
    }
    assert.equal(mode(fakeHome), 0o755);
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
