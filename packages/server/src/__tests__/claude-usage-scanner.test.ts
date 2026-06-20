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

const {
  getSessionCookie,
  fetchOrgId,
  getRateLimits,
  invalidateCache,
  selectUsageOrg,
} = await import("../plugins/claude-usage/scanner.js");
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

  // The dashboard branches its remedy ("Reconfigure" vs "Retry") on errorKind,
  // so these lock the failure categories the UI depends on. A bad credential
  // and a transient outage must NOT both look like a credential problem.
  it("tags an expired/invalid key (bootstrap 401) as errorKind 'unauthorized'", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "BAD" }));
    const fetcher: UsageFetcher = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const data = await getRateLimits(fetcher);
    assert.equal(data.errorKind, "unauthorized");
  });

  it("tags an empty-membership bootstrap as errorKind 'no_org'", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY8" }));
    const fetcher: UsageFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ account: { memberships: [] } }),
    });
    const data = await getRateLimits(fetcher);
    assert.equal(data.errorKind, "no_org");
  });

  it("tags a usage 429 as transient 'rate_limited' (key is fine)", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY9" }));
    const fetcher: UsageFetcher = async (url) => {
      if (url.includes("/bootstrap")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              memberships: [{ organization: { uuid: BOOTSTRAP_ORG } }],
            },
          }),
        };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const data = await getRateLimits(fetcher);
    assert.equal(data.errorKind, "rate_limited");
    // The message must reassure rather than blame the credential.
    assert.match(data.error ?? "", /key is fine/i);
  });

  it("tags a usage 500 as transient 'unavailable' (key is fine)", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY10" }));
    const fetcher: UsageFetcher = async (url) => {
      if (url.includes("/bootstrap")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              memberships: [{ organization: { uuid: BOOTSTRAP_ORG } }],
            },
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const data = await getRateLimits(fetcher);
    assert.equal(data.errorKind, "unavailable");
  });

  // The cache/last-good buffer is fingerprinted by session key. These guard the
  // race the silent-failure review surfaced: a key change must never be served
  // the previous key's data, even without an explicit invalidateCache() (which
  // a concurrent poller's read could otherwise race against).
  it("re-fetches for a new key instead of returning the prior key's cached data", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY_A" }));
    const first = await getRateLimits(makeFetcher().fetcher);
    assert.equal(first.fiveHour?.utilization, 42);

    // Switch keys WITHOUT calling invalidateCache (simulates the race window).
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY_B" }));
    const fetcherB: UsageFetcher = async (url) => {
      if (url.includes("/bootstrap")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              memberships: [{ organization: { uuid: BOOTSTRAP_ORG } }],
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 99, resets_at: "" } }),
      };
    };
    const second = await getRateLimits(fetcherB);
    // B's number (99%), never A's stale 42%.
    assert.equal(second.fiveHour?.utilization, 99);
  });

  it("does not serve the prior key's last-good data on a new key's 429", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY_A" }));
    const first = await getRateLimits(makeFetcher().fetcher);
    assert.equal(first.fiveHour?.utilization, 42);

    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY_B" }));
    const fetcherB: UsageFetcher = async (url) => {
      if (url.includes("/bootstrap")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              memberships: [{ organization: { uuid: BOOTSTRAP_ORG } }],
            },
          }),
        };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const second = await getRateLimits(fetcherB);
    // Must report the rate limit, NOT silently pass off A's data as B's.
    assert.equal(second.errorKind, "rate_limited");
    assert.equal(second.fiveHour, null);
  });

  // Org selection — the usage endpoint is only authorized for the claude.ai
  // ("chat") org. A user with a separate Anthropic-API org (often listed first
  // in bootstrap) must not have it picked, or every /usage call 403s.
  const API_ORG = "api0-1111-2222-3333-444455556666";
  const CHAT_ORG = "chat-1111-2222-3333-444455556666";

  it("selectUsageOrg prefers the chat org over an api org listed first", () => {
    const orgId = selectUsageOrg([
      {
        organization: {
          uuid: API_ORG,
          capabilities: ["api", "api_individual"],
        },
      },
      {
        organization: { uuid: CHAT_ORG, capabilities: ["chat", "claude_max"] },
      },
    ]);
    assert.equal(orgId, CHAT_ORG);
  });

  it("selectUsageOrg falls back to claude_max when no explicit chat cap", () => {
    const orgId = selectUsageOrg([
      { organization: { uuid: API_ORG, capabilities: ["api"] } },
      { organization: { uuid: CHAT_ORG, capabilities: ["claude_max"] } },
    ]);
    assert.equal(orgId, CHAT_ORG);
  });

  it("selectUsageOrg uses the sole org when capabilities are absent", () => {
    const orgId = selectUsageOrg([{ organization: { uuid: BOOTSTRAP_ORG } }]);
    assert.equal(orgId, BOOTSTRAP_ORG);
  });

  it("selectUsageOrg returns null for multiple orgs with no chat access", () => {
    const orgId = selectUsageOrg([
      { organization: { uuid: API_ORG, capabilities: ["api"] } },
      { organization: { uuid: "other", capabilities: ["api"] } },
    ]);
    assert.equal(orgId, null);
  });

  it("selectUsageOrg returns null for a lone org that explicitly lacks chat", () => {
    // An API-only account: the sole org advertises caps but none grant
    // claude.ai access. Returning its uuid would 403 on /usage and look like
    // an expired key — return null so the no-subscription message is shown.
    const orgId = selectUsageOrg([
      {
        organization: {
          uuid: API_ORG,
          capabilities: ["api", "api_individual"],
        },
      },
    ]);
    assert.equal(orgId, null);
  });

  it("selectUsageOrg returns null for empty memberships", () => {
    assert.equal(selectUsageOrg([]), null);
  });

  it("getRateLimits queries the chat org end-to-end (not the api org)", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "MULTI" }));
    const urls: string[] = [];
    const fetcher: UsageFetcher = async (url) => {
      urls.push(url);
      if (url.includes("/bootstrap")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              memberships: [
                {
                  organization: {
                    uuid: API_ORG,
                    capabilities: ["api", "api_individual"],
                  },
                },
                {
                  organization: {
                    uuid: CHAT_ORG,
                    capabilities: ["chat", "claude_max"],
                  },
                },
              ],
            },
          }),
        };
      }
      // The api org would 403 in reality; only the chat org returns usage.
      if (url.includes(`/${API_ORG}/`)) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 48, resets_at: "2026-06-20T04:00:00Z" },
        }),
      };
    };
    const data = await getRateLimits(fetcher);
    assert.equal(data.error, undefined);
    assert.equal(data.fiveHour?.utilization, 48);
    // The usage call hit the chat org, never the api org.
    assert.ok(urls.some((u) => u.includes(`/${CHAT_ORG}/usage`)));
    assert.ok(!urls.some((u) => u.includes(`/${API_ORG}/usage`)));
  });

  it("no_org message names both causes (expired key AND no subscription)", async () => {
    // An API-only account with a VALID key must not be told only that the key
    // expired — the message must also surface the no-subscription cause.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ claudeSessionKey: "APIONLY" }),
    );
    const fetcher: UsageFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        account: {
          memberships: [
            { organization: { uuid: API_ORG, capabilities: ["api"] } },
          ],
        },
      }),
    });
    const data = await getRateLimits(fetcher);
    assert.equal(data.errorKind, "no_org");
    assert.match(data.error ?? "", /subscription/i);
    assert.match(data.error ?? "", /expired/i);
  });
});
