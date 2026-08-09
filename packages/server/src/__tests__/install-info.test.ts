// install.json resolution (ADR-071): the marker decides, the legacy layout is
// the explicit fallback arm, and everything else refuses — never guesses.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readInstallJson,
  resolveInstall,
  writeInstallJson,
} from "../installInfo.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autonomos-install-info-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readInstallJson / writeInstallJson", () => {
  it("round-trips a marker", () => {
    writeInstallJson(root, { mode: "bundle", prefix: "/x/.local" });
    expect(readInstallJson(root)).toMatchObject({
      mode: "bundle",
      prefix: "/x/.local",
    });
  });

  it("returns null when absent", () => {
    expect(readInstallJson(root)).toBeNull();
  });

  it("returns null on a malformed marker (unknown mode)", () => {
    writeFileSync(
      join(root, "install.json"),
      JSON.stringify({ mode: "docker", prefix: "/x" }),
    );
    expect(readInstallJson(root)).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    writeFileSync(join(root, "install.json"), "not json {");
    expect(readInstallJson(root)).toBeNull();
  });
});

describe("resolveInstall", () => {
  it("trusts the marker wherever the bundle lives", () => {
    const bundleDir = join(root, "opt", "anything");
    mkdirSync(bundleDir, { recursive: true });
    writeInstallJson(bundleDir, { mode: "source", prefix: root });
    const resolved = resolveInstall(join(bundleDir, "index.js"));
    expect(resolved).toMatchObject({
      bundleDir,
      source: "marker",
      info: { mode: "source", prefix: root },
    });
  });

  it("legacy arm: marker-less <prefix>/share/autonomos resolves as bundle", () => {
    const bundleDir = join(root, "share", "autonomos");
    mkdirSync(bundleDir, { recursive: true });
    const resolved = resolveInstall(join(bundleDir, "index.js"));
    expect(resolved).toMatchObject({
      bundleDir,
      source: "legacy-layout",
      info: { mode: "bundle", prefix: root },
    });
  });

  it("marker wins over the legacy layout when both apply", () => {
    const bundleDir = join(root, "share", "autonomos");
    mkdirSync(bundleDir, { recursive: true });
    writeInstallJson(bundleDir, { mode: "source", prefix: "/elsewhere" });
    const resolved = resolveInstall(join(bundleDir, "index.js"));
    expect(resolved.source).toBe("marker");
    expect(resolved.info.mode).toBe("source");
  });

  it("refuses an unrecognized layout with instructions, never guesses", () => {
    const devDir = join(root, "packages", "cli", "src");
    mkdirSync(devDir, { recursive: true });
    expect(() => resolveInstall(join(devDir, "index.ts"))).toThrow(
      /Cannot determine install shape/,
    );
    expect(() => resolveInstall(join(devDir, "index.ts"))).toThrow(
      /git pull && make prod/,
    );
  });

  it("refuses when argv[1] is missing", () => {
    // Passing undefined explicitly would just trigger the default parameter —
    // the branch is only reachable when process.argv itself lacks a script.
    const saved = process.argv;
    process.argv = [saved[0] ?? "node"];
    try {
      expect(() => resolveInstall()).toThrow(/argv\[1\]/);
    } finally {
      process.argv = saved;
    }
  });
});
