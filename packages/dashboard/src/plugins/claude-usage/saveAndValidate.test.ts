import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAndValidate } from "./saveAndValidate";
import { isCredentialError } from "./types";

// ── Fetch stubbing ──────────────────────────────────────────────────
// saveAndValidate's call sequence: GET /api/settings (read the auto-detect
// state to restore on failure) → PUT /api/settings (persist key + flip
// auto-detect off) → GET /api/plugins/claude-usage (validate) → on a failed
// validation, a best-effort PUT restoring the previous auto-detect. The stub
// routes by method+URL so each test scripts exactly the calls it expects.

type Json = Record<string, unknown>;

function jsonResponse(status: number, body: Json): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: Json;
}

function stubFetch(opts: {
  settingsGet?: Response | "reject";
  /** PUT /api/settings responses, consumed in order (save, then restore). */
  put?: Array<Response | "reject">;
  validate?: Response | "reject";
}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let putIdx = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? (JSON.parse(init.body as string) as Json) : undefined,
    });
    let next: Response | "reject" | undefined;
    if (url.includes("/api/settings") && method === "GET") {
      next = opts.settingsGet ?? jsonResponse(200, {});
    } else if (url.includes("/api/settings") && method === "PUT") {
      next = opts.put?.[putIdx++];
    } else {
      next = opts.validate;
    }
    if (next === undefined) {
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }
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

const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PUT");

describe("saveAndValidate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok with usage data when save + validation both succeed", async () => {
    const calls = stubFetch({
      settingsGet: jsonResponse(200, { autoDetectClaudeAccount: true }),
      put: [jsonResponse(200, { claudeSessionKey: "••••1234" })],
      validate: jsonResponse(200, OK_USAGE),
    });
    const res = await saveAndValidate("sk-ant-sid01-good");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.data.fiveHour?.utilization).toBe(42);
    // Pasting a key selects the manual source in the SAME write as the key —
    // otherwise validate() would read the OTHER credential's numbers.
    const savePut = puts(calls)[0];
    expect(savePut.body?.claudeSessionKey).toBe("sk-ant-sid01-good");
    expect(savePut.body?.autoDetectClaudeAccount).toBe(false);
    // Success keeps the flip — exactly one PUT, no restore.
    expect(puts(calls)).toHaveLength(1);
  });

  it("restores the previous auto-detect=on when validation fails", async () => {
    const calls = stubFetch({
      settingsGet: jsonResponse(200, { autoDetectClaudeAccount: true }),
      put: [jsonResponse(200, {}), jsonResponse(200, {})],
      validate: jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "Session key expired or invalid.",
        errorKind: "unauthorized",
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-bad");
    expect(res.kind).toBe("invalid");
    // Without the restore, a failed paste persisted auto-detect OFF while the
    // toggle still showed On — the silent-state divergence this pins.
    const restore = puts(calls)[1];
    expect(restore).toBeDefined();
    expect(restore.body).toEqual({ autoDetectClaudeAccount: true });
  });

  it("does NOT restore when auto-detect was already off before the paste", async () => {
    const calls = stubFetch({
      settingsGet: jsonResponse(200, { autoDetectClaudeAccount: false }),
      put: [jsonResponse(200, {})],
      validate: jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "Session key expired or invalid.",
        errorKind: "unauthorized",
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-bad");
    expect(res.kind).toBe("invalid");
    // Restoring "true" here would wrongly flip a key-only user ONTO auto-detect.
    expect(puts(calls)).toHaveLength(1);
  });

  it("surfaces a credential failure verbatim with its errorKind", async () => {
    stubFetch({
      settingsGet: jsonResponse(200, {}),
      put: [jsonResponse(200, {}), jsonResponse(200, {})],
      validate: jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "Session key expired or invalid.",
        errorKind: "unauthorized",
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-bad");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.message).toMatch(/expired or invalid/i);
      expect(res.errorKind).toBe("unauthorized");
      expect(isCredentialError(res.errorKind)).toBe(true);
    }
  });

  it("classifies a transient outage as invalid-but-not-credential", async () => {
    stubFetch({
      settingsGet: jsonResponse(200, {}),
      put: [jsonResponse(200, {}), jsonResponse(200, {})],
      validate: jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        error: "claude.ai is rate-limiting usage requests right now.",
        errorKind: "rate_limited",
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-fine");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      // The key is fine — the UI must NOT push a reconfigure here.
      expect(isCredentialError(res.errorKind)).toBe(false);
    }
  });

  it("reports unreachable when the save request itself fails", async () => {
    stubFetch({
      settingsGet: jsonResponse(200, {}),
      put: ["reject"],
    });
    const res = await saveAndValidate("sk-ant-sid01-x");
    expect(res.kind).toBe("unreachable");
  });

  it("still saves when the settings pre-read fails (restore just defaults on)", async () => {
    const calls = stubFetch({
      settingsGet: "reject",
      put: [jsonResponse(200, {})],
      validate: jsonResponse(200, OK_USAGE),
    });
    const res = await saveAndValidate("sk-ant-sid01-good");
    expect(res.kind).toBe("ok");
    expect(puts(calls)).toHaveLength(1);
  });

  it("classifies a 500 during validation as transient and surfaces its detail", async () => {
    stubFetch({
      settingsGet: jsonResponse(200, {}),
      put: [jsonResponse(200, {}), jsonResponse(200, {})],
      validate: jsonResponse(500, {
        error: "Failed to fetch rate limits",
        detail: "boom",
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-x");
    // A reached-but-failed server is NOT "unreachable" — it's transient.
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.errorKind).toBe("unavailable");
      expect(res.message).toMatch(/boom/);
    }
  });

  it("treats a post-save needsSetup as an invalid save (key didn't stick)", async () => {
    stubFetch({
      settingsGet: jsonResponse(200, {}),
      put: [jsonResponse(200, {}), jsonResponse(200, {})],
      validate: jsonResponse(200, {
        ...OK_USAGE,
        fiveHour: null,
        needsSetup: true,
      }),
    });
    const res = await saveAndValidate("sk-ant-sid01-x");
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") expect(res.errorKind).toBe("unauthorized");
  });
});

describe("isCredentialError", () => {
  it("flags kinds fixable by re-entering the key (incl. stale_token)", () => {
    expect(isCredentialError("unauthorized")).toBe(true);
    expect(isCredentialError("no_org")).toBe(true);
    // An expired Claude Code login never clears on its own; pasting a key IS
    // the remedy — transient classification sent users into a hopeless retry.
    expect(isCredentialError("stale_token")).toBe(true);
    expect(isCredentialError("rate_limited")).toBe(false);
    expect(isCredentialError("unavailable")).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
  });
});
