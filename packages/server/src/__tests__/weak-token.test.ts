import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  isPriorInstall,
  isWeakToken,
  MIN_TOKEN_LENGTH,
  weakTokenPolicy,
} from "../auth.js";

/** L1: what counts as weak, what counts as an existing install, and the policy
 *  that ties them together (V2b). */

describe("isWeakToken", () => {
  it("every token autonomOS generates is strong", () => {
    assert.equal(isWeakToken("a1b2c3d4".repeat(8)), false); // 64 hex
  });
  for (const t of ["abcd", "tok", "0123456789abcdef0123456789abcde"]) {
    it(`${t.length} chars is weak`, () => assert.equal(isWeakToken(t), true));
  }
  it(`${MIN_TOKEN_LENGTH} chars of real variety is strong`, () => {
    assert.equal(isWeakToken("0123456789abcdef".repeat(2)), false);
  });
  it("long but repetitive is weak", () => {
    assert.equal(isWeakToken("a".repeat(64)), true);
    assert.equal(isWeakToken("abababab".repeat(8)), true);
  });
});

describe("isPriorInstall", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "v2b-"));
    dirs.push(d);
    return d;
  };

  it("an empty or missing config dir is a new install", () => {
    assert.equal(isPriorInstall(fresh()), false);
    assert.equal(isPriorInstall(join(tmpdir(), "v2b-nope-x")), false);
  });

  it("a hand-written token file alone is still a new install", () => {
    const d = fresh();
    writeFileSync(join(d, "token"), "abcd");
    assert.equal(isPriorInstall(d), false);
  });

  it("logs/ alone is NOT an existing install (a refused boot writes it)", () => {
    const d = fresh();
    mkdirSync(join(d, "logs"));
    assert.equal(isPriorInstall(d), false);
  });

  for (const marker of ["agents", "templates"]) {
    it(`${marker}/ from an earlier boot marks an existing install`, () => {
      const d = fresh();
      mkdirSync(join(d, marker));
      assert.equal(isPriorInstall(d), true);
    });
  }
  it("settings.json marks an existing install", () => {
    const d = fresh();
    writeFileSync(join(d, "settings.json"), "{}");
    assert.equal(isPriorInstall(d), true);
  });
});

describe("weakTokenPolicy: upgrades never break auth", () => {
  const base = {
    weak: true,
    priorInstall: false,
    networkBind: true,
    allowWeak: false,
  };
  it("a strong token is always ok", () => {
    assert.equal(weakTokenPolicy({ ...base, weak: false }), "ok");
  });
  it("a NEW install with a weak token on a network bind is refused", () => {
    assert.equal(weakTokenPolicy(base), "refuse");
  });
  it("an EXISTING install with a weak token is never refused, only warned", () => {
    assert.equal(weakTokenPolicy({ ...base, priorInstall: true }), "warn");
  });
  it("a new install on loopback is warned, not refused", () => {
    assert.equal(weakTokenPolicy({ ...base, networkBind: false }), "warn");
  });
  it("--allow-weak-token turns the refusal into a warning", () => {
    assert.equal(weakTokenPolicy({ ...base, allowWeak: true }), "warn");
  });
});
