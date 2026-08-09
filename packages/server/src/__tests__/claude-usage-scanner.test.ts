import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Point settings at an isolated temp dir BEFORE importing the scanner
// (settings.js resolves the config dir at module load time). Also point
// CLAUDE_CONFIG_DIR at the temp dir so the OAuth account-identity read never
// touches the dev machine's real ~/.claude.
const TEST_DIR = join(tmpdir(), `autonomos-test-usage-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
process.env.CLAUDE_CONFIG_DIR = TEST_DIR;

// Ensure ambient credentials in the dev shell don't leak into assertions.
delete process.env.CLAUDE_SESSION_KEY;
delete process.env.CLAUDE_ORG_ID;
delete process.env.CLAUDE_SESSION_COOKIE;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const {
  getSessionCookie,
  fetchOrgId,
  getRateLimits,
  invalidateCache,
  selectUsageOrg,
  resolveSessionKey,
  getCredentialSource,
} = await import("../plugins/claude-usage/scanner.js");
const { __setOAuthTokenReaderForTests, __setOAuthFetcherForTests } =
  await import("../plugins/claude-usage/oauthUsage.js");
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

describe("claude-usage scanner — manual session key (claude.ai cookie flow)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    invalidateCache();
    // Stub the OAuth token reader to find nothing so the auto-detect path is
    // inert here — these tests cover the manual claude.ai flow, and a real
    // keychain token on the dev box would otherwise satisfy the credential.
    __setOAuthTokenReaderForTests(() => null);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    invalidateCache();
    __setOAuthTokenReaderForTests(null);
    __setOAuthFetcherForTests(null);
  });

  it("builds a cookie from the session key alone (no lastActiveOrg)", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEY1" }));
    const cookie = getSessionCookie();
    assert.equal(cookie, "sessionKey=KEY1");
    assert.ok(!cookie?.includes("lastActiveOrg"));
  });

  it("ignores a stale claudeOrgId left in settings.json (no error, org dropped from cookie)", () => {
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
    assert.equal(data.credentialSource, "settings");
    assert.ok(urls.some((u) => u.includes("/bootstrap")));
    assert.ok(urls.some((u) => u.includes(`/${BOOTSTRAP_ORG}/usage`)));
  });

  it("reports needsSetup when no key and no OAuth token is available", async () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({}));
    const { fetcher } = makeFetcher();
    const data = await getRateLimits(fetcher);
    assert.equal(data.needsSetup, true);
  });

  // The dashboard branches its remedy ("Reconfigure" vs "Retry") on errorKind.
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

  // The cache/last-good buffer is fingerprinted by session key.
  it("re-fetches for a new key instead of returning the prior key's cached data", async () => {
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 99, resets_at: "" } }),
      };
    };
    const second = await getRateLimits(fetcherB);
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
    assert.equal(second.errorKind, "rate_limited");
    assert.equal(second.fiveHour, null);
  });

  // Org selection — the usage endpoint is only authorized for the claude.ai
  // ("chat") org.
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
    assert.ok(urls.some((u) => u.includes(`/${CHAT_ORG}/usage`)));
    assert.ok(!urls.some((u) => u.includes(`/${API_ORG}/usage`)));
  });

  it("no_org message names both causes (expired key AND no subscription)", async () => {
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

describe("claude-usage credential resolution (manual override vs OAuth)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    invalidateCache();
    delete process.env.CLAUDE_SESSION_KEY;
    writeFileSync(SETTINGS_FILE, JSON.stringify({}));
    __setOAuthTokenReaderForTests(() => null);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    invalidateCache();
    delete process.env.CLAUDE_SESSION_KEY;
    __setOAuthTokenReaderForTests(null);
    __setOAuthFetcherForTests(null);
  });

  it("resolveSessionKey returns a manual settings key as source 'settings'", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ claudeSessionKey: "MANUAL" }),
    );
    assert.deepEqual(resolveSessionKey(), {
      key: "MANUAL",
      source: "settings",
    });
    assert.equal(getCredentialSource(), "settings");
    assert.equal(getSessionCookie(), "sessionKey=MANUAL");
  });

  it("resolveSessionKey returns CLAUDE_SESSION_KEY as source 'env'", () => {
    process.env.CLAUDE_SESSION_KEY = "ENVKEY";
    assert.equal(resolveSessionKey()?.source, "env");
  });

  it("prefers a manual settings key over the env key", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ claudeSessionKey: "MANUAL" }),
    );
    process.env.CLAUDE_SESSION_KEY = "ENVKEY";
    assert.equal(resolveSessionKey()?.source, "settings");
  });

  it("resolveSessionKey is null when no manual key is set (OAuth handled separately)", () => {
    assert.equal(resolveSessionKey(), null);
    assert.equal(getCredentialSource(), null);
  });

  it("uses the OAuth path (source 'oauth') when no manual key is set", async () => {
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "oauth-access-token",
      expiresAt: Date.now() + 3_600_000,
      source: "keychain",
      subscriptionType: "max",
    }));
    __setOAuthFetcherForTests(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 12, resets_at: "2026-06-28T10:00:00Z" },
        seven_day: { utilization: 3, resets_at: "2026-07-05T00:00:00Z" },
      }),
    }));
    const data = await getRateLimits();
    assert.equal(data.error, undefined);
    assert.equal(data.credentialSource, "oauth");
    assert.equal(data.fiveHour?.utilization, 12);
    assert.equal(data.account.subscriptionType, "max");
  });

  it("maps an expired OAuth token to errorKind 'stale_token'", async () => {
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "expired-token",
      expiresAt: Date.now() - 1_000,
      source: "keychain",
    }));
    const data = await getRateLimits();
    assert.equal(data.credentialSource, "oauth");
    assert.equal(data.errorKind, "stale_token");
  });

  it("maps an OAuth 401 to errorKind 'unauthorized'", async () => {
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "rejected-token",
      expiresAt: Date.now() + 3_600_000,
      source: "keychain",
    }));
    __setOAuthFetcherForTests(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const data = await getRateLimits();
    assert.equal(data.errorKind, "unauthorized");
  });

  it("maps an OAuth 429 to errorKind 'rate_limited' and backs off (caches it)", async () => {
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "rate-limited-token",
      expiresAt: Date.now() + 3_600_000,
      source: "keychain",
    }));
    let calls = 0;
    __setOAuthFetcherForTests(async () => {
      calls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    });
    const first = await getRateLimits();
    assert.equal(first.errorKind, "rate_limited");
    assert.equal(first.credentialSource, "oauth");
    assert.match(first.error ?? "", /login is fine/i);
    // A second read within the backoff window must be served from cache — the
    // endpoint is NOT hit again (the whole point of caching the 429).
    const second = await getRateLimits();
    assert.equal(second.errorKind, "rate_limited");
    assert.equal(calls, 1, "must not re-hit the endpoint during 429 backoff");
  });

  it("reports needsSetup when auto-detect is off and no manual key is set", async () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ autoDetectClaudeAccount: false }),
    );
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "present-but-ignored",
      expiresAt: Date.now() + 3_600_000,
      source: "keychain",
    }));
    const data = await getRateLimits();
    assert.equal(data.needsSetup, true);
  });

  it("honors the legacy autoDetectClaudeSession=false as a fallback", async () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ autoDetectClaudeSession: false }),
    );
    __setOAuthTokenReaderForTests(() => ({
      accessToken: "present-but-ignored",
      expiresAt: Date.now() + 3_600_000,
      source: "keychain",
    }));
    const data = await getRateLimits();
    assert.equal(data.needsSetup, true);
  });

  it("still honors a manual key when auto-detect is off", async () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        claudeSessionKey: "MANUAL",
        autoDetectClaudeAccount: false,
      }),
    );
    const data = await getRateLimits(makeFetcher().fetcher);
    assert.equal(data.credentialSource, "settings");
    assert.equal(data.fiveHour?.utilization, 42);
  });

  it("a persistent body-parse failure logs ONCE, not once per poll (edge stays failing)", async (t) => {
    // Regression for the success()-before-parse ordering: an ok response whose
    // json() rejects (captive-portal HTML, truncated body) must not flip the
    // edge logger healthy first — that made every poll log the same failure,
    // the exact spam class edge-triggering exists to kill.
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEYP" }));
    const errors: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "));
    });

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
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      };
    };

    for (let i = 0; i < 3; i++) {
      invalidateCache();
      await getRateLimits(fetcher);
    }

    const parseFailures = errors.filter((e) =>
      e.includes("usage fetch failed"),
    );
    assert.equal(
      parseFailures.length,
      1,
      `persistent parse failure must log once, got: ${parseFailures.length}`,
    );
  });

  it("a persistently-offline bootstrap (manual-key path) logs ONCE, not once per poll", async (t) => {
    // Same spam class as the usage fetch, on the OTHER credential path: with a
    // manual session key and no network, cachedOrgId never populates, so
    // bootstrap is retried — and used to stack-log — every poll cycle.
    writeFileSync(SETTINGS_FILE, JSON.stringify({ claudeSessionKey: "KEYB" }));
    const errors: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "));
    });

    const fetcher: UsageFetcher = async () => {
      throw new Error("impit error: Failed to connect to the server.");
    };

    for (let i = 0; i < 3; i++) {
      invalidateCache();
      await getRateLimits(fetcher);
    }

    const bootFailures = errors.filter((e) => e.includes("bootstrap"));
    assert.equal(
      bootFailures.length,
      1,
      `offline bootstrap must log once, got: ${bootFailures.length}`,
    );
  });
});
