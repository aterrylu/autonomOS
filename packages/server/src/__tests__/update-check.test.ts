// Server-side update check (ADR-077 §6) against a local releases-API
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
  startUpdateCheck,
  stopUpdateCheck,
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

describe("startUpdateCheck gate", () => {
  // The privacy claim is that updateCheck:false means NO network call — not
  // merely that the predicate returns false. The counting fixture is wired
  // into the tick's ACTUAL code path via the AUTONOMOS_RELEASE_API_URL
  // override (the tick calls runUpdateCheck() bare, which resolves the env);
  // without that wiring, hits === 0 would be structurally vacuous — the
  // fixture would simply never be the URL under test.
  async function startCountingFixture(): Promise<{
    base: string;
    hits: () => number;
  }> {
    let count = 0;
    server = createServer((_req, res) => {
      count += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tag_name: "v9.9.9" }));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const addr = server?.address();
    if (!addr || typeof addr !== "object") throw new Error("no port");
    return { base: `http://127.0.0.1:${addr.port}`, hits: () => count };
  }

  it("a started ticker under updateCheck:true DOES hit the release API (wiring is live)", async () => {
    const fixture = await startCountingFixture();
    process.env.AUTONOMOS_RELEASE_API_URL = fixture.base;
    try {
      startUpdateCheck(5); // first tick ~5ms out
      const deadline = Date.now() + 3_000;
      while (fixture.hits() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      stopUpdateCheck();
      assert.ok(fixture.hits() >= 1, "fixture was never contacted");
      assert.equal(getUpdateCheckState().latest, "9.9.9");
    } finally {
      delete process.env.AUTONOMOS_RELEASE_API_URL;
      stopUpdateCheck();
    }
  });

  it("performs no network call when updateCheck is false", async () => {
    writeFileSync(
      join(cfgDir, "settings.json"),
      JSON.stringify({ updateCheck: false }),
    );
    const fixture = await startCountingFixture();
    process.env.AUTONOMOS_RELEASE_API_URL = fixture.base;
    try {
      startUpdateCheck(5);
      await new Promise((r) => setTimeout(r, 150));
      stopUpdateCheck();
      assert.equal(fixture.hits(), 0);
      assert.deepEqual(getUpdateCheckState(), {
        latest: null,
        updateAvailable: false,
        checkedAt: null,
      });
    } finally {
      delete process.env.AUTONOMOS_RELEASE_API_URL;
      stopUpdateCheck();
    }
  });
});

describe("GET /api/system/version additive fields", () => {
  it("serves the cached update state without blocking", async () => {
    const base = await serveLatest("v9.9.9");
    await runUpdateCheck(base);

    const { systemRouter } = await import("../routes/system.js");
    const res = await systemRouter.request("/version");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    // Frozen contract fields...
    assert.equal(typeof body.version, "string");
    assert.equal(body.platform, process.platform);
    assert.equal(body.arch, process.arch);
    // ...plus the additive trio from the cache.
    assert.equal(body.latest, "9.9.9");
    assert.equal(body.updateAvailable, true);
    assert.equal(typeof body.checkedAt, "string");
  });
});
