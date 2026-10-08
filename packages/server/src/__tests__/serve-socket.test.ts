import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertServeSocketDir,
  assertServeSocketPath,
  defaultServeSocketPath,
  MAX_SOCKET_PATH_BYTES,
  tailscaleGroupContainer,
} from "../serveSocket.js";

/**
 * L1: where `tailscale serve --bg unix:<path>` connects (ADR-153). Measured on
 * Tailscale 1.102.3: the App Store build's sandboxed proxy reached a socket
 * inside its app-group container (200) but not one in /tmp (502); root
 * tailscaled (Linux, standalone macOS) reaches the config dir.
 */

const CONTAINER =
  "/Users/u/Library/Group Containers/W5364U7YZB.group.io.tailscale.ipn.macos";

describe("defaultServeSocketPath", () => {
  it("App Store Tailscale on macOS: inside its app-group container, one file per port", () => {
    assert.equal(
      defaultServeSocketPath({
        configDir: "/Users/u/.autonomos",
        port: 3100,
        platform: "darwin",
        groupContainer: () => CONTAINER,
      }),
      `${CONTAINER}/aos-3100.sock`,
    );
  });

  it("macOS without the App Store app (standalone tailscaled): the config dir", () => {
    assert.equal(
      defaultServeSocketPath({
        configDir: "/Users/u/.autonomos",
        port: 3100,
        platform: "darwin",
        groupContainer: () => undefined,
      }),
      "/Users/u/.autonomos/serve.sock",
    );
  });

  it("Linux: the config dir, never looking for a Mac container", () => {
    assert.equal(
      defaultServeSocketPath({
        configDir: "/home/u/.autonomos",
        port: 3100,
        platform: "linux",
        groupContainer: () => {
          throw new Error("must not be consulted off macOS");
        },
      }),
      "/home/u/.autonomos/serve.sock",
    );
  });
});

describe("tailscaleGroupContainer", () => {
  it("finds the Tailscale app-group folder by name, and nothing else", () => {
    assert.equal(
      tailscaleGroupContainer("/Users/u", () => [
        "group.com.apple.notes",
        "W5364U7YZB.group.io.tailscale.ipn.macos",
      ]),
      CONTAINER,
    );
    assert.equal(
      tailscaleGroupContainer("/Users/u", () => ["group.com.apple.notes"]),
      undefined,
    );
    assert.equal(
      tailscaleGroupContainer("/Users/u", () => {
        throw new Error("ENOENT");
      }),
      undefined,
      "no Group Containers dir (Linux, or a fresh Mac)",
    );
  });
});

describe("assertServeSocketPath", () => {
  it("refuses a path the OS can't bind, naming the override", () => {
    assert.doesNotThrow(() =>
      assertServeSocketPath(`${CONTAINER}/aos-3100.sock`),
    );
    assert.throws(
      () => assertServeSocketPath(`/${"x".repeat(MAX_SOCKET_PATH_BYTES)}`),
      /--serve-socket=<path>/,
    );
  });
});

describe("assertServeSocketDir (SecurityAudit, #530)", () => {
  const ME = 501;
  const dir =
    (mode: number, o: { uid?: number; link?: boolean; file?: boolean } = {}) =>
    () => ({
      uid: o.uid ?? ME,
      mode,
      isSymbolicLink: () => !!o.link,
      isDirectory: () => !o.file,
    });

  it("accepts a private folder (the 0700 config dir, Tailscale's 0700 app-group folder)", () => {
    assert.doesNotThrow(() =>
      assertServeSocketDir("/x/serve.sock", ME, dir(0o40700)),
    );
  });

  it("refuses a shared folder like /tmp, another user's folder, a symlink, or a loose one", () => {
    for (const [why, st] of [
      ["world-writable /tmp", dir(0o41777)],
      ["group-writable", dir(0o40770)],
      ["readable by others", dir(0o40755)],
      ["another user's", dir(0o40700, { uid: 0 })],
      ["a symlink", dir(0o40700, { link: true })],
      ["not a directory", dir(0o100600, { file: true })],
    ] as const)
      assert.throws(
        () => assertServeSocketDir("/x/serve.sock", ME, st),
        /a folder only you can use[\s\S]*--serve-socket=<path>/,
        why,
      );
  });
});
