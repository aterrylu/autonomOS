import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAndValidate } from "./saveAndValidate";
import { isCredentialError } from "./types";

// ── Fetch stubbing ──────────────────────────────────────────────────
// saveAndValidate makes two calls in order: PUT /api/settings (persist),
// then GET /api/plugins/claude-usage (validate). We script both per case.

type Json = Record<string, unknown>;

function jsonResponse(status: number, body: Json): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Queue responses returned in call order. */
function stubFetch(responses: Array<Response | "reject">) {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    const next = responses[i++];
    if (next === "reject") return Promise.reject(new Error("network"));
    return Promise.resolve(next);
  });
  return calls;
}

const OK_USAGE: Json = {
  fiveHour: { utilization: 42, resetsAt: "" },
  sevenDay: null,
  account: {},
  fetchedAt: "2026-06-19T00:00:00Z",
};

describe("saveAndValidate", () => {
  beforeEach(() => {
    stubFetch([]); // default; overridden per test
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok with usage data when save + validation both succeed", async () => {
    const calls = stubFetch([
      jsonResponse(200, { claudeSessionKey: "••••1234" }), // PUT
      jsonResponse(200, OK_USAGE), // GET validate
    ]);
    const res = await saveAndValidate("sk-ant-sid01-good");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.data.fiveHour?.utilization).toBe(42);
    // The PUT must precede the validation GET.
    expect(calls[0]).toContain("/api/settings");
    expect(calls[1]).toContain("/api/plugins/claude-usage");
  });

  it("surfaces a credential failure verbatim with its errorKind", async () => {
    stubFetch([
      jsonResponse(200, { claudeSessionKey: "••••bad0" }),
      jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "Session key expired or invalid.",
        errorKind: "unauthorized",
      }),
    ]);
    const res = await saveAndValidate("sk-ant-sid01-bad");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.message).toMatch(/expired or invalid/i);
      expect(res.errorKind).toBe("unauthorized");
      expect(isCredentialError(res.errorKind)).toBe(true);
    }
  });

  it("classifies a transient outage as invalid-but-not-credential", async () => {
    stubFetch([
      jsonResponse(200, { claudeSessionKey: "••••fine" }),
      jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "claude.ai is rate-limiting usage requests right now.",
        errorKind: "rate_limited",
      }),
    ]);
    const res = await saveAndValidate("sk-ant-sid01-fine");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      // The key is fine — the UI must NOT push a reconfigure here.
      expect(isCredentialError(res.errorKind)).toBe(false);
    }
  });

  it("reports unreachable when the save request itself fails", async () => {
    stubFetch(["reject"]);
    const res = await saveAndValidate("sk-ant-sid01-x");
    expect(res.kind).toBe("unreachable");
  });

  it("classifies a 500 during validation as transient and surfaces its detail", async () => {
    stubFetch([
      jsonResponse(200, { claudeSessionKey: "••••ok12" }), // PUT ok
      jsonResponse(500, {
        error: "Failed to fetch rate limits",
        detail: "boom",
      }),
    ]);
    const res = await saveAndValidate("sk-ant-sid01-x");
    // A reached-but-failed server is NOT "unreachable" — it's transient.
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.errorKind).toBe("unavailable");
      expect(res.message).toMatch(/boom/);
    }
  });

  it("treats a post-save needsSetup as an invalid save (key didn't stick)", async () => {
    stubFetch([
      jsonResponse(200, { claudeSessionKey: null }),
      jsonResponse(200, { ...OK_USAGE, fiveHour: null, needsSetup: true }),
    ]);
    const res = await saveAndValidate("sk-ant-sid01-x");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") expect(res.errorKind).toBe("unauthorized");
  });
});

describe("isCredentialError", () => {
  it("flags only credential kinds as fixable by re-entering the key", () => {
    expect(isCredentialError("unauthorized")).toBe(true);
    expect(isCredentialError("no_org")).toBe(true);
    expect(isCredentialError("rate_limited")).toBe(false);
    expect(isCredentialError("unavailable")).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
  });
});
