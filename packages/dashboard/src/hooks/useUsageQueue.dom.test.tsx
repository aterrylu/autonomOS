// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useUsageQueue } from "./useUsageQueue";

/**
 * Focused tests for the hook: the optimistic toggle + rollback, and the
 * PER-RUNTIME cap read (ADR-068) — a pane reads ONLY its own provider's cap, so
 * a Claude cap never lights a Codex pane.
 *
 * The hook is backed by a module singleton; tests use distinct sessionIds and
 * deterministic fetch responses so the shared snapshot converges regardless of
 * order. A short macrotask flush drains the fetch microtasks.
 */

type FetchInit = { method?: string } | undefined;
let respond: (url: string, init: FetchInit) => { ok: boolean; body: unknown };

// The api client reads every body through `res.text()` + JSON.parse (so a
// non-JSON error body degrades instead of throwing), so the stub exposes
// text(), not json().
function fakeResponse(ok: boolean, body: unknown) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  respond = () => ({ ok: true, body: { armed: [], caps: {} } });
  vi.stubGlobal("fetch", (url: string, init: FetchInit) => {
    const { ok, body } = respond(url, init);
    return Promise.resolve(fakeResponse(ok, body));
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("useUsageQueue", () => {
  it("reads ONLY its own provider's cap (a Claude cap does not light a Codex pane)", async () => {
    respond = () => ({
      ok: true,
      body: {
        armed: [],
        caps: { "claude-code": { capped: true, resetsAt: null } },
      },
    });
    const claude = renderHook(() => useUsageQueue("c", "claude-code"));
    const codex = renderHook(() => useUsageQueue("x", "codex"));
    await flush();
    expect(claude.result.current.capped).toBe(true);
    expect(codex.result.current.capped).toBe(false); // no codex cap entry
    claude.unmount();
    codex.unmount();
  });

  it("rolls back the optimistic flip when the server rejects the arm", async () => {
    respond = (_url, init) => {
      // The arm POST fails; the GET poll stays empty.
      if (init?.method === "POST" || init?.method === "DELETE") {
        return { ok: false, body: {} };
      }
      return { ok: true, body: { armed: [], caps: {} } };
    };
    const { result, unmount } = renderHook(() =>
      useUsageQueue("roll-1", "claude-code"),
    );
    await flush();
    expect(result.current.isArmed).toBe(false);

    await act(async () => {
      await result.current.toggle();
    });
    // Optimistically flipped true, then reverted because the POST failed.
    expect(result.current.isArmed).toBe(false);
    unmount();
  });

  it("reflects an armed pane after a successful toggle + reconcile", async () => {
    let armed: string[] = [];
    respond = (_url, init) => {
      if (init?.method === "POST") {
        armed = ["ok-1"];
        return { ok: true, body: { armed: true } };
      }
      return {
        ok: true,
        body: {
          armed,
          caps: { "claude-code": { capped: true, resetsAt: null } },
        },
      };
    };
    const { result, unmount } = renderHook(() =>
      useUsageQueue("ok-1", "claude-code"),
    );
    await flush();
    expect(result.current.isArmed).toBe(false);

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.isArmed).toBe(true);
    unmount();
  });
});
