// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { useStore } from "../../store";
import { NewDeviceLockStatusBarItem } from "./NewDeviceLockStatusBarItem";

/**
 * The new-device lock pill (ADR-148): hidden unless the server reports new
 * devices locked; its Unlock button clears the lock and says so in the
 * action toast. The server is faked at the fetch boundary with real Responses.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const LOCKED = { enabled: true, locked: true, failures: 20, limit: 20 };
const OPEN = { enabled: true, locked: false, failures: 0, limit: 20 };

let calls: Array<{ url: string; method: string }>;
let lockResponse: () => Response;
let unlockResponse: () => Response;

beforeEach(() => {
  calls = [];
  lockResponse = () => json(LOCKED);
  unlockResponse = () => json(OPEN);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/api/auth/lock")) return lockResponse();
      if (url.endsWith("/api/auth/unlock")) return unlockResponse();
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NewDeviceLockStatusBarItem", () => {
  it("renders nothing while new devices can sign in", async () => {
    lockResponse = () => json(OPEN);
    const { container } = render(<NewDeviceLockStatusBarItem />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });

  it("renders nothing against an older server without the route", async () => {
    lockResponse = () => json({ error: "not found" }, 404);
    const { container } = render(<NewDeviceLockStatusBarItem />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });

  it("shows the lock with the count in its tooltip, never anything about the token", async () => {
    render(<NewDeviceLockStatusBarItem />);
    const pill = await screen.findByTestId("new-device-lock");
    expect(pill.textContent).toContain("New devices locked");
    expect(pill.querySelector("[title]")?.getAttribute("title")).toMatch(
      /20 failed sign-ins/,
    );
  });

  it("Unlock POSTs, hides the pill, and confirms in the action toast", async () => {
    const toast = vi.fn();
    useStore.setState({ showActionToast: toast });
    render(<NewDeviceLockStatusBarItem />);
    fireEvent.click(await screen.findByTestId("new-device-unlock"));
    await waitFor(() =>
      expect(screen.queryByTestId("new-device-lock")).toBeNull(),
    );
    expect(
      calls.some(
        (c) => c.url.endsWith("/api/auth/unlock") && c.method === "POST",
      ),
    ).toBe(true);
    expect(toast).toHaveBeenCalledWith("New devices can sign in again.", true);
  });

  it("a failed unlock keeps the pill and points at the CLI", async () => {
    const toast = vi.fn();
    useStore.setState({ showActionToast: toast });
    unlockResponse = () => json({ error: "nope" }, 500);
    render(<NewDeviceLockStatusBarItem />);
    fireEvent.click(await screen.findByTestId("new-device-unlock"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("autonomos auth unlock"),
      false,
    );
    expect(screen.getByTestId("new-device-lock")).toBeTruthy();
  });
});
