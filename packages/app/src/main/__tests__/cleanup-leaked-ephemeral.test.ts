import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLeakedEphemeralDirs } from "../ephemeral-cleanup.js";

/**
 * Regression coverage for `cleanupLeakedEphemeralDirs`. The catastrophic
 * failure mode is "deletes dirs that don't match the prefix" — which would
 * blow away unrelated user state. The "right" behavior splits into three
 * cases tested below.
 */

let root: string;
const HOUR = 60 * 60 * 1000;

function mkdirWithMtime(name: string, ageMs: number): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  // Drop a sentinel file so the dir's recursive removal is observable.
  writeFileSync(join(path, "sentinel.txt"), "x");
  const targetMs = (Date.now() - ageMs) / 1000;
  utimesSync(path, targetMs, targetMs);
  return path;
}

describe("cleanupLeakedEphemeralDirs", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autonomos-cleanup-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes matching dirs older than the threshold", () => {
    const old = mkdirWithMtime("autonomos-ephemeral-old-uuid", 2 * HOUR);
    cleanupLeakedEphemeralDirs(root, HOUR);
    assert.equal(
      existsSync(old),
      false,
      "old autonomos-ephemeral-* dir should be removed",
    );
  });

  it("keeps matching dirs newer than the threshold", () => {
    const fresh = mkdirWithMtime("autonomos-ephemeral-fresh-uuid", HOUR / 2);
    cleanupLeakedEphemeralDirs(root, HOUR);
    assert.equal(
      existsSync(fresh),
      true,
      "fresh autonomos-ephemeral-* dir must be kept",
    );
  });

  it("never touches non-matching dirs, even old ones (catastrophic-regression guard)", () => {
    const unrelatedOld = mkdirWithMtime("user-important-data", 2 * HOUR);
    const unrelatedDownloads = mkdirWithMtime("Downloads", 3 * HOUR);
    const closeMatch = mkdirWithMtime("autonomos-foo-bar", 2 * HOUR);
    cleanupLeakedEphemeralDirs(root, HOUR);
    assert.equal(
      existsSync(unrelatedOld),
      true,
      "must not delete dirs without the autonomos-ephemeral- prefix",
    );
    assert.equal(
      existsSync(unrelatedDownloads),
      true,
      "must not delete user dirs in TMPDIR",
    );
    assert.equal(
      existsSync(closeMatch),
      true,
      "prefix match must be exact — autonomos-foo-bar is NOT an ephemeral dir",
    );
  });

  it("does not throw when root is empty", () => {
    assert.doesNotThrow(() => cleanupLeakedEphemeralDirs(root, HOUR));
  });

  it("does not throw when root does not exist", () => {
    const ghost = join(root, "does-not-exist");
    assert.doesNotThrow(() => cleanupLeakedEphemeralDirs(ghost, HOUR));
  });
});
