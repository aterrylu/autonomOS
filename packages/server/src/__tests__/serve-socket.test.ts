import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
