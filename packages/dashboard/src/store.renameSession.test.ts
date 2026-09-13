import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./api/agents";
import { useStore } from "./store";

// renameSession composes: patch the record name (agentsApi.rename) → restart
// (restartSession). The ordering + the rethrow-before-teardown are the safety
// properties: a failed rename must not have killed anything. We mock the API and
// stub restartSession so this exercises renameSession's own logic in isolation.
vi.mock("./api/agents", () => ({
  agentsApi: {
    rename: vi.fn().mockResolvedValue({ id: "a1", name: "New" }),
  },
}));

afterEach(() => vi.clearAllMocks());

describe("renameSession", () => {
  it("renames the record FIRST, then restarts (patch before any teardown)", async () => {
    const order: string[] = [];
    (agentsApi.rename as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("rename");
        return { id: "a1", name: "New" };
      },
    );
    useStore.setState({
      restartSession: vi.fn().mockImplementation(async () => {
        order.push("restart");
      }),
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);

    await useStore.getState().renameSession("a1", "New");

    expect(agentsApi.rename).toHaveBeenCalledWith("a1", "New");
    expect(order).toEqual(["rename", "restart"]); // rename resolves before restart
  });

  it("trims the name before sending it", async () => {
    useStore.setState({
      restartSession: vi.fn().mockResolvedValue(undefined),
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    await useStore.getState().renameSession("a1", "  Padded  ");
    expect(agentsApi.rename).toHaveBeenCalledWith("a1", "Padded");
  });

  it("rethrows a rename failure BEFORE restarting (nothing torn down)", async () => {
    (agentsApi.rename as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('An active agent named "New" is already running.'),
    );
    const restart = vi.fn();
    useStore.setState({
      restartSession: restart,
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);

    await expect(
      useStore.getState().renameSession("a1", "New"),
    ).rejects.toThrow("already running");
    expect(restart).not.toHaveBeenCalled(); // the restart never fires on a failed rename
  });

  it("rejects an empty/whitespace name without touching the API", async () => {
    const restart = vi.fn();
    useStore.setState({
      restartSession: restart,
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);

    await expect(
      useStore.getState().renameSession("a1", "   "),
    ).rejects.toThrow("Name cannot be empty");
    expect(agentsApi.rename).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
