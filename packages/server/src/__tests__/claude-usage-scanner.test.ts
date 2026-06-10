import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Point settings at an isolated temp dir BEFORE importing the scanner
// (settings.js resolves the config dir at module load time).
const TEST_DIR = join(tmpdir(), `autonomos-test-usage-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

// Ensure ambient credentials in the dev shell don't leak into assertions.
delete process.env.CLAUDE_SESSION_KEY;
delete process.env.CLAUDE_ORG_ID;

const { getSessionCookie, fetchOrgId, getRateLimits, invalidateCache } =
  await import("../plugins/claude-usage/scanner.js");
type UsageFetcher = Parameters<typeof getRateLimits>[0];

const SETTINGS_FILE = join(TEST_DIR, "settings.json");
const BOOTSTRAP_ORG = "boot-0000-1111-2222-333344445555";
const STALE_ORG = "stale-9999-8888-7777-666655554444";

/** A fetcher that resolves the org via bootstrap and returns canned usage. */
function makeFetcher(): { fetcher: UsageFetcher; urls: string[] } {
  const urls: string[] = [];
  const fetcher: UsageFetcher = async (url) => {
    urls.push(url);
    if (url.includes("/bootstrap")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          account: { memberships: [{ organization: { uuid: BOOTSTRAP_ORG } }] },
        }),
      };
    }
    // usage endpoint
    return {
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: "2026-01-01T00:00:00Z" },
        seven_day: { utilization: 7, resets_at: "2026-01-07T00:00:00Z" },
      }),
    };
  };
  return { fetcher, urls };
}

describe("claude-usage scanner — session key is the only credential", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    invalidateCache();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    invalidateCache();
  });

  it("builds a cookie from the session key alone (no lastActiveOrg)", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY1" }));
    const cookie = getSessionCookie();
    assert.equal(cookie, "sessionKey=KEY1");
    assert.ok(!cookie?.includes("lastActiveOrg"));
  });

  it("ignores a stale claudeOrgId left in settings.json (no error, org dropped from cookie)", () => {
    // Simulates an existing settings.json written by an older build.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ claudeSessionKey: "KEY2", claudeOrgId: STALE_ORG }),
    );
    const cookie = getSessionCookie();
    assert.equal(cookie, "sessionKey=KEY2");
    assert.ok(!cookie?.includes(STALE_ORG));
    assert.ok(!cookie?.includes("lastActiveOrg"));
  });

  it("resolves the org UUID via the bootstrap API from the session key", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY3" }));
    const { fetcher, urls } = makeFetcher();
    const cookie = getSessionCookie();
    assert.ok(cookie);
    const org = await fetchOrgId(cookie, fetcher);
    assert.equal(org.status, "ok");
    assert.equal(org.orgId, BOOTSTRAP_ORG);
    assert.ok(urls.some((u) => u.includes("/bootstrap")));
  });

  it("resolves org via bootstrap even when a stale claudeOrgId is present", async () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ claudeSessionKey: "KEY4", claudeOrgId: STALE_ORG }),
    );
    const { fetcher, urls } = makeFetcher();
    const cookie = getSessionCookie();
    assert.ok(cookie);
    const org = await fetchOrgId(cookie, fetcher);
    // The bootstrap value wins; the stale settings org is never consulted.
    assert.equal(org.orgId, BOOTSTRAP_ORG);
    assert.notEqual(org.orgId, STALE_ORG);
    assert.ok(urls.some((u) => u.includes("/bootstrap")));
  });

  it("reports unauthorized when bootstrap 401s (expired/invalid key)", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "BAD" }));
    const fetcher: UsageFetcher = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const cookie = getSessionCookie();
    assert.ok(cookie);
    const org = await fetchOrgId(cookie, fetcher);
    assert.equal(org.status, "unauthorized");
    assert.equal(org.orgId, null);
  });

  it("surfaces the expired-key message via getRateLimits on bootstrap 401", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "BAD" }));
    const fetcher: UsageFetcher = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const data = await getRateLimits(fetcher);
    assert.match(data.error ?? "", /expired or invalid/i);
    // Must NOT collapse into the generic "could not resolve" message.
    assert.doesNotMatch(data.error ?? "", /could not resolve/i);
  });

  it("reports no_org when bootstrap returns no memberships", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY6" }));
    const fetcher: UsageFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ account: { memberships: [] } }),
    });
    const cookie = getSessionCookie();
    assert.ok(cookie);
    const org = await fetchOrgId(cookie, fetcher);
    assert.equal(org.status, "no_org");
    assert.equal(org.orgId, null);
  });

  it("returns error (not a throw) when the fetcher rejects", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY7" }));
    const fetcher: UsageFetcher = async () => {
      throw new Error("network down");
    };
    const cookie = getSessionCookie();
    assert.ok(cookie);
    const org = await fetchOrgId(cookie, fetcher);
    assert.equal(org.status, "error");
    assert.equal(org.orgId, null);
  });

  it("fetches usage end-to-end with session key only (bootstrap → usage)", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY5" }));
    const { fetcher, urls } = makeFetcher();
    const data = await getRateLimits(fetcher);
    assert.equal(data.error, undefined);
    assert.equal(data.needsSetup, undefined);
    assert.equal(data.fiveHour?.utilization, 42);
    assert.equal(data.sevenDay?.utilization, 7);
    // Both the bootstrap and the org-scoped usage endpoint were hit.
    assert.ok(urls.some((u) => u.includes("/bootstrap")));
    assert.ok(urls.some((u) => u.includes(`/${BOOTSTRAP_ORG}/usage`)));
  });

  it("reports needsSetup when no session key is configured", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({}));
    const { fetcher } = makeFetcher();
    const data = await getRateLimits(fetcher);
    assert.equal(data.needsSetup, true);
  });
});
