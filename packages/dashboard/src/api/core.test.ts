// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isAbort, request } from "./core";

type Handler = () => Promise<Response> | Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: Handler): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler();
  });
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("resolves parsed JSON on 2xx", async () => {
    stubFetch(() => jsonResponse(200, { ok: true, n: 3 }));
    await expect(request<{ n: number }>("/api/x")).resolves.toEqual({
      ok: true,
      n: 3,
    });
  });

  it("throws a typed ApiError carrying the server envelope", async () => {
    stubFetch(() =>
      jsonResponse(503, {
        error: "cache poisoned",
        code: "CACHE_POISONED",
        retryable: false,
        currentVersion: 4,
      }),
    );
    const err = await request("/api/x").catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("cache poisoned");
    expect(err.code).toBe("CACHE_POISONED");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ currentVersion: 4 });
  });

  it("survives a non-JSON error body (dev-mode plaintext 404)", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    const err = await request("/api/gone").catch((e) => e as ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("404");
  });

  it("maps a network failure to status 0 / unreachable", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await request("/api/x").catch((e) => e as ApiError);
    expect(err.status).toBe(0);
    expect(err.unreachable).toBe(true);
  });

  it("dedups concurrent GETs of the same URL onto one fetch", async () => {
    let resolveBody: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => {
      resolveBody = r;
    });
    const { calls } = stubFetch(() => gate);
    const a = request("/api/agents");
    const b = request("/api/agents");
    const c = request("/api/other"); // different URL — its own fetch
    resolveBody(jsonResponse(200, [1]));
    await Promise.all([a, b, c.catch(() => null)]);
    const agentCalls = calls.filter((c2) => c2.url === "/api/agents");
    expect(agentCalls).toHaveLength(1);
  });

  it("does NOT dedup mutations or fresh reads", async () => {
    const { calls } = stubFetch(() => jsonResponse(200, {}));
    await Promise.all([
      request("/api/x", { method: "POST", body: {} }),
      request("/api/x", { method: "POST", body: {} }),
    ]);
    expect(calls).toHaveLength(2);
    await Promise.all([
      request("/api/y", { fresh: true }),
      request("/api/y", { fresh: true }),
    ]);
    expect(calls).toHaveLength(4);
  });

  it("a caller's abort detaches it without killing the shared GET", async () => {
    let resolveBody: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => {
      resolveBody = r;
    });
    stubFetch(() => gate);
    const ctl = new AbortController();
    const aborted = request("/api/agents", { signal: ctl.signal });
    const surviving = request("/api/agents");
    ctl.abort();
    const err = await aborted.catch((e) => e as ApiError);
    expect(isAbort(err)).toBe(true);
    resolveBody(jsonResponse(200, { fine: true }));
    await expect(surviving).resolves.toEqual({ fine: true });
  });
});

describe("abort semantics per dedup class", () => {
  it("a fresh request's abort kills the underlying fetch (no socket leak)", async () => {
    let sawSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    const ctl = new AbortController();
    const p = request("/api/host", { fresh: true, signal: ctl.signal });
    ctl.abort();
    const err = await p.catch((e) => e as ApiError);
    expect(isAbort(err)).toBe(true);
    expect(sawSignal?.aborted).toBe(true); // the SOCKET was aborted, not just the caller
  });
});
