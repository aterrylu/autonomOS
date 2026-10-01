import assert from "node:assert/strict";
import {
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
  isLoopbackAddress,
  NEW_DEVICE_FAILURE_LIMIT,
  NewDeviceLock,
  newDeviceFailureLimit,
  unlockOnDisk,
} from "../newDeviceLock.js";

/**
 * L1: the new-device lock (ADR-135). A short token's total exposure is capped:
 * after LIMIT distinct failures from never-signed-in devices, new devices are
 * refused until the operator unlocks; known devices and loopback never are.
 */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function lockFile(): string {
  const d = mkdtempSync(join(tmpdir(), "ndl-"));
  dirs.push(d);
  return join(d, "auth-lock.json");
}
const quiet = () => {};

describe("NewDeviceLock", () => {
  it(`locks new devices after ${NEW_DEVICE_FAILURE_LIMIT} distinct failures from unknown addresses`, () => {
    const l = new NewDeviceLock({
      enabled: true,
      path: lockFile(),
      log: quiet,
    });
    for (let i = 0; i < NEW_DEVICE_FAILURE_LIMIT - 1; i++)
      l.noteDistinctFailure(`10.0.0.${i % 200}`);
    assert.equal(l.status().locked, false, "one short of the cap");
    assert.equal(l.refuses("10.9.9.9"), false);
    l.noteDistinctFailure("10.0.0.1");
    assert.equal(l.status().locked, true);
    assert.equal(l.refuses("10.9.9.9"), true, "any unknown address");
  });

  it("the attacker's total chance is the cap, not a function of time", () => {
    const l = new NewDeviceLock({
      enabled: true,
      path: lockFile(),
      log: quiet,
    });
    let evaluated = 0;
    // A million attempts from a million addresses, as fast as you like.
    for (let i = 0; i < 1_000_000; i++) {
      const addr = `2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::/64`;
      if (l.refuses(addr)) continue;
      evaluated++;
      l.noteDistinctFailure(addr);
    }
    assert.equal(evaluated, NEW_DEVICE_FAILURE_LIMIT);
  });

  it("never refuses a known device or loopback, and doesn't count their failures", () => {
    const l = new NewDeviceLock({
      enabled: true,
      path: lockFile(),
      limit: 3,
      log: quiet,
    });
    l.noteSuccess("100.64.0.7"); // the operator's laptop on the tailnet
    for (let i = 0; i < 10; i++) {
      l.noteDistinctFailure("100.64.0.7"); // a typo from a known device
      l.noteDistinctFailure("127.0.0.1"); // a local script
    }
    assert.equal(l.status().failures, 0);
    for (const a of ["10.0.0.1", "10.0.0.2", "10.0.0.3"])
      l.noteDistinctFailure(a);
    assert.equal(l.status().locked, true);
    for (const a of ["100.64.0.7", "127.0.0.1", "127.5.5.5", "::1"])
      assert.equal(l.refuses(a), false, a);
  });

  it("survives a restart (a fresh instance on the same file), counts included", () => {
    const path = lockFile();
    const a = new NewDeviceLock({ enabled: true, path, limit: 3, log: quiet });
    a.noteSuccess("100.64.0.7");
    a.noteDistinctFailure("10.0.0.1");
    a.noteDistinctFailure("10.0.0.2");
    const b = new NewDeviceLock({ enabled: true, path, limit: 3, log: quiet });
    assert.equal(
      b.status().failures,
      2,
      "a restart doesn't hand out a fresh cap",
    );
    b.noteDistinctFailure("10.0.0.3");
    const c = new NewDeviceLock({ enabled: true, path, limit: 3, log: quiet });
    assert.equal(c.refuses("10.0.0.9"), true, "still locked after restart");
    assert.equal(c.refuses("100.64.0.7"), false, "known devices remembered");
  });

  it("unlock reopens and resets the count; unlockOnDisk does the same offline", () => {
    const path = lockFile();
    const l = new NewDeviceLock({ enabled: true, path, limit: 2, log: quiet });
    l.noteDistinctFailure("10.0.0.1");
    l.noteDistinctFailure("10.0.0.2");
    l.unlock();
    assert.deepEqual(
      { locked: l.status().locked, failures: l.status().failures },
      { locked: false, failures: 0 },
    );
    l.noteDistinctFailure("10.0.0.1");
    l.noteDistinctFailure("10.0.0.2");
    unlockOnDisk(path);
    const fresh = new NewDeviceLock({
      enabled: true,
      path,
      limit: 2,
      log: quiet,
    });
    assert.equal(fresh.status().locked, false);
  });

  it("disabled (a strong token): never refuses, never counts", () => {
    const l = new NewDeviceLock({
      enabled: false,
      path: lockFile(),
      limit: 1,
      log: quiet,
    });
    for (let i = 0; i < 50; i++) l.noteDistinctFailure(`10.0.0.${i}`);
    assert.equal(l.status().locked, false);
    assert.equal(l.refuses("10.0.0.1"), false);
  });

  it("persists 0600, with counts and addresses only (never a credential)", () => {
    const path = lockFile();
    const l = new NewDeviceLock({ enabled: true, path, limit: 2, log: quiet });
    l.noteSuccess("100.64.0.7");
    l.noteDistinctFailure("10.0.0.1");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), [
      "failures",
      "known",
      "lockedAt",
    ]);
  });

  it("an unreadable or malformed file reads as open (never crashes the boot)", () => {
    const path = lockFile();
    writeFileSync(path, "{not json");
    const l = new NewDeviceLock({ enabled: true, path, log: quiet });
    assert.equal(l.status().locked, false);
  });

  it("says it locked, once, without anything about the token", () => {
    const lines: string[] = [];
    const l = new NewDeviceLock({
      enabled: true,
      path: lockFile(),
      limit: 2,
      log: (s) => lines.push(s),
    });
    for (const a of ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"])
      l.noteDistinctFailure(a);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /New devices are now locked out.*autonomos auth unlock/,
    );
  });

  it("remembers at most a bounded number of known devices", () => {
    const l = new NewDeviceLock({
      enabled: true,
      path: lockFile(),
      log: quiet,
    });
    for (let i = 0; i < 1000; i++) l.noteSuccess(`10.1.${i >> 8}.${i & 255}`);
    const saved = JSON.parse(
      readFileSync(
        (l as unknown as { opts: { path: string } }).opts.path,
        "utf8",
      ),
    );
    assert.ok(saved.known.length <= 256);
  });
});

describe("helpers", () => {
  it("loopback is 127/8 and ::1", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "::1"])
      assert.equal(isLoopbackAddress(a), true, a);
    for (const a of ["10.0.0.1", "100.64.0.7", "::ffff:10.0.0.1", "fe80::1"])
      assert.equal(isLoopbackAddress(a), false, a);
  });

  it("AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT accepts 1..1000 only", () => {
    assert.equal(newDeviceFailureLimit("5"), 5);
    for (const bad of [undefined, "", "0", "-3", "1001", "2.5", "abc"])
      assert.equal(
        newDeviceFailureLimit(bad),
        NEW_DEVICE_FAILURE_LIMIT,
        String(bad),
      );
  });
});
