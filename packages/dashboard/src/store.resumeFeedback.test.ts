import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";

// Resume from Projects must never fail silently: `status` is only read as a
// busy flag, so the action toast is what a person actually sees.
const get = () => useStore.getState();
let calls: string[];

beforeEach(() => {
  calls = [];
  useStore.setState({
    sessions: [],
    exitedSessions: [],
    actionToast: null,
    // A leftover busy status makes spawnSession return early — reset it.
    status: "connected",
  });
});
afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, method: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      return Promise.resolve(handler(url, method));
    }),
  );
}

describe("resumeSession feedback", () => {
  it("an EXTERNAL Codex/Gemini session says it isn't supported yet — and calls NOTHING", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    for (const provider of ["codex", "gemini-cli"]) {
      await get().resumeSession("ext-1", "/w", "x", { provider });
      expect(get().actionToast).toMatchObject({
        ok: false,
        text: "Resume isn't supported yet for Codex or Gemini sessions started outside autonomOS.",
      });
    }
    expect(calls).toEqual([]);
  });

  it("an external CLAUDE CODE session still adopts (the guard is Codex/Gemini only)", async () => {
    stubFetch((_u, method) =>
      // The spawn POST answers with the new agent; every GET list is an array.
      method === "POST"
        ? new Response(
            JSON.stringify({ id: "new", name: "x", status: "running" }),
            { status: 200 },
          )
        : new Response("[]", { status: 200 }),
    );
    await get().resumeSession("cc-1", "/w", "x", { provider: "claude-code" });
    // The adopt call went out, and no refusal was shown.
    expect(
      calls.some((c) => c.startsWith("POST ") && c.includes("/api/agents")),
    ).toBe(true);
    expect(get().actionToast).toBeNull();
  });

  it("a managed agent whose resume FAILS shows the server's reason", async () => {
    stubFetch((u) =>
      u.includes("/attach")
        ? new Response(
            JSON.stringify({ error: "Invalid working directory: /gone" }),
            { status: 400 },
          )
        : new Response("[]", { status: 200 }),
    );
    await get().resumeSession("a1", "/w", "x", {
      isAutonomosAgent: true,
      provider: "codex",
    });
    expect(get().actionToast).toMatchObject({
      ok: false,
      text: "Resume failed: Invalid working directory: /gone",
    });
  });
});
