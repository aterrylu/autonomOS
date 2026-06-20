// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useUsageQueue } from "./useUsageQueue";

/**
 * Focused tests for the optimistic toggle + rollback (the F4 fix): a failed
 * arm must NOT leave the button claiming "armed," because during a server
 * outage the background poll can't correct the lie either.
 *
 * The hook is backed by a module singleton; tests use distinct sessionIds and
 * deterministic fetch responses so the shared snapshot converges regardless of
 * order. A short macrotask flush drains the fetch microtasks.
 */

type FetchInit = { method?: string } | undefined;
let respond: (url: string, init: FetchInit) => { ok: boolean; body: unknown };

function fakeResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  respond = () => ({
    ok: true,
    body: { armed: [], blocked: false, resetsAt: null },
  });
  vi.stubGlobal("fetch", (url: string, init: FetchInit) => {
    const { ok, body } = respond(url, init);
    return Promise.resolve(fakeResponse(ok, body));
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("useUsageQueue", () => {
  it("rolls back the optimistic flip when the server rejects the arm", async () => {
    respond = (_url, init) => {
      // The arm POST fails; the GET poll stays empty.
      if (init?.method === "POST" || init?.method === "DELETE") {
        return { ok: false, body: {} };
      }
      return { ok: true, body: { armed: [], blocked: false, resetsAt: null } };
    };
    const { result, unmount } = renderHook(() => useUsageQueue("roll-1"));
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
      return { ok: true, body: { armed, blocked: true, resetsAt: null } };
    };
    const { result, unmount } = renderHook(() => useUsageQueue("ok-1"));
    await flush();
    expect(result.current.isArmed).toBe(false);

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.isArmed).toBe(true);
    unmount();
  });
});
