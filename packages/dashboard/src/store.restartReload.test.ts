import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./api/agents";
import { useStore } from "./store";

// restartSession composes kill → attach → fetchSessions → switchPane, and now
// also bumps the per-session terminal-reload nonce so the pane deterministically
// re-acquires a fresh terminal bound to the new PTY (fixing the terminal-gone
// bug when restarting the already-focused agent). We mock the API and stub the
// downstream store methods so this exercises restartSession's own wiring.
vi.mock("./api/agents", () => ({
  agentsApi: {
    kill: vi.fn().mockResolvedValue({ ok: true, id: "a1" }),
    attach: vi.fn().mockResolvedValue({ id: "a1" }),
  },
}));

beforeEach(() => {
  useStore.setState({
    terminalReloadNonce: {},
    fetchSessions: vi.fn().mockResolvedValue(undefined),
    switchPane: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
  } as any);
});
afterEach(() => vi.clearAllMocks());

describe("reloadTerminal", () => {
  it("bumps the per-session nonce (0 → 1 → 2), isolated per id", () => {
    useStore.getState().reloadTerminal("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(1);
    useStore.getState().reloadTerminal("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(2);
    // A different session is untouched.
    expect(useStore.getState().terminalReloadNonce.b2 ?? 0).toBe(0);
  });
});

describe("restartSession — terminal reconnect", () => {
  it("bumps the reload nonce after a successful attach (so the pane reconnects)", async () => {
    await useStore.getState().restartSession("a1");
    expect(agentsApi.attach).toHaveBeenCalledWith("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(1);
    // And it re-opened the pane (the #353 refocus).
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "a1",
    });
  });

  it("does NOT bump the nonce when attach FAILS (no new PTY to reconnect to)", async () => {
    (agentsApi.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("attach failed"),
    );
    await useStore.getState().restartSession("a1");
    expect(useStore.getState().terminalReloadNonce.a1 ?? 0).toBe(0);
    // Nor does it re-open a pane onto a stopped agent.
    expect(useStore.getState().switchPane).not.toHaveBeenCalled();
  });
});
