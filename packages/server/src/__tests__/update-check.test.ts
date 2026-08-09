// Server-side update check (ADR-072 §6) against a local releases-API
// fixture. The contract under test: never throws, failure keeps last-known
// state, availability is a strict "newer than running", and the settings
// toggle (default ON, documented default = actual default) is honored.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  _resetUpdateCheckForTesting,
  getUpdateCheckState,
  isUpdateCheckEnabled,
  runUpdateCheck,
} from "../updateCheck.js";
import { getServerVersion } from "../version.js";

let cfgDir: string;
let server: Server | undefined;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "autonomos-update-check-"));
  _setConfigDirForTesting(cfgDir);
  _resetUpdateCheckForTesting();
});

afterEach(async () => {
  _resetConfigDirForTesting();
  _resetUpdateCheckForTesting();
  rmSync(cfgDir, { recursive: true, force: true });
  if (server) {
    await new Promise((r) => server?.close(r));
    server = undefined;
  }
});

async function serveLatest(
  tagName: string | null,
  status = 200,
): Promise<string> {
  server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(tagName === null ? "{}" : JSON.stringify({ tag_name: tagName }));
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const addr = server?.address();
  if (!addr || typeof addr !== "object") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("runUpdateCheck", () => {
  it("flags an update when the release is newer than the running version", async () => {
    const base = await serveLatest("v9.9.9");
    const state = await runUpdateCheck(base);
    assert.equal(state.latest, "9.9.9");
    assert.equal(state.updateAvailable, true);
    assert.ok(state.checkedAt);
  });

  it("does not flag an older release (never advertise a downgrade)", async () => {
    const base = await serveLatest("v0.0.1");
    const state = await runUpdateCheck(base);
    assert.equal(state.latest, "0.0.1");
    assert.equal(state.updateAvailable, false);
  });

  it("does not flag the running version itself", async () => {
    const base = await serveLatest(`v${getServerVersion()}`);
    const state = await runUpdateCheck(base);
    assert.equal(state.updateAvailable, false);
  });

  it("keeps last-known state on an API error", async () => {
    const good = await serveLatest("v9.9.9");
    await runUpdateCheck(good);
    await new Promise((r) => server?.close(r));
    server = undefined;

    const bad = await serveLatest(null, 500);
    const state = await runUpdateCheck(bad);
    assert.equal(state.latest, "9.9.9"); // unchanged
    assert.equal(state.updateAvailable, true);
  });

  it("stays null-state when the network is unreachable (offline is silent)", async () => {
    // Port 1 on loopback: connection refused.
    const state = await runUpdateCheck("http://127.0.0.1:1");
    assert.deepEqual(state, {
      latest: null,
      updateAvailable: false,
      checkedAt: null,
    });
    assert.deepEqual(getUpdateCheckState(), state);
  });

  it("ignores a malformed tag_name", async () => {
    const base = await serveLatest("release-candidate");
    const state = await runUpdateCheck(base);
    assert.equal(state.latest, null);
  });
});

describe("isUpdateCheckEnabled", () => {
  it("defaults ON with no settings file (documented default = actual default)", () => {
    assert.equal(isUpdateCheckEnabled(), true);
  });

  it("honors updateCheck: false", () => {
    writeFileSync(
      join(cfgDir, "settings.json"),
      JSON.stringify({ updateCheck: false }),
    );
    assert.equal(isUpdateCheckEnabled(), false);
  });
});
