// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { NotificationBell } from "../../components/NotificationBell";
import { useStore } from "../../store";
import { HIDDEN_KEY, startLockPoll, useLockStore } from "./lockState";
import { NewDeviceLockAlert } from "./NewDeviceLockAlert";
import { NewDeviceLockStatusBarItem } from "./NewDeviceLockStatusBarItem";

/**
 * The owner's side of the new-device lock (ADR-148, Terry's mockup B1 + bell):
 * a signed-in dashboard must NOTICE the lock. A prominent alert bar
 * [Unlock new devices][Details][Hide]; after Hide only the status-bar pill;
 * the bell's pinned entry while locked. The server is faked at the fetch
 * boundary with real Responses; the real poll drives everything.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const LOCKED_AT = Date.UTC(2026, 9, 7, 14, 32);
const locked = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  locked: true,
  failures: 20,
  limit: 20,
  lockedAt: LOCKED_AT,
  lastFailureFrom: "100.64.1.2",
  lastFailureAt: LOCKED_AT - 1000,
  ...over,
});
const OPEN = {
  enabled: true,
  locked: false,
  failures: 0,
  limit: 20,
  lockedAt: null,
  lastFailureFrom: null,
  lastFailureAt: null,
};

let lockResponse: () => Response;
let unlockResponse: () => Response;
let calls: Array<{ url: string; method: string }>;
let stopPoll: (() => void) | undefined;

function Owner() {
  return (
    <>
      <NewDeviceLockAlert />
      <NewDeviceLockStatusBarItem />
      <NotificationBell />
    </>
  );
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  useLockStore.setState({
    lock: null,
    hiddenFor: null,
    detailsOpen: false,
    unlocking: false,
  });
  lockResponse = () => json(locked());
  unlockResponse = () => json(OPEN);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/api/auth/lock")) return lockResponse();
      if (url.endsWith("/api/auth/unlock")) return unlockResponse();
      if (url.includes("/api/status")) return json({ notifications: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  stopPoll?.();
  stopPoll = undefined;
  cleanup();
  vi.unstubAllGlobals();
});

function startOwner() {
  render(<Owner />);
  act(() => {
    stopPoll = startLockPoll();
  });
}

describe("owner alert when new devices are locked out", () => {
  it("shows the alert bar with Unlock / Details / Hide, and no pill yet", async () => {
    startOwner();
    const bar = await screen.findByTestId("new-device-lock-alert");
    expect(bar.getAttribute("role")).toBe("alert");
    expect(bar.textContent).toContain("New devices are locked out.");
    expect(bar.textContent).toContain(
      "20 failed sign-in attempts came from devices that haven't signed in before.",
    );
    expect(screen.getByTestId("new-device-lock-unlock")).toBeTruthy();
    expect(screen.getByTestId("new-device-lock-details")).toBeTruthy();
    expect(screen.getByTestId("new-device-lock-hide")).toBeTruthy();
    // The pill only replaces the bar after Hide.
    expect(screen.queryByTestId("new-device-lock")).toBeNull();
  });

  it("nothing at all while new devices can sign in, or on an older server", async () => {
    lockResponse = () => json(OPEN);
    startOwner();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("new-device-lock-alert")).toBeNull();
    expect(screen.queryByTestId("new-device-lock")).toBeNull();
    cleanup();
    stopPoll?.();
    lockResponse = () => json({ error: "not found" }, 404);
    useLockStore.setState({ lock: null });
    startOwner();
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(screen.queryByTestId("new-device-lock-alert")).toBeNull();
  });

  it("Details shows when, and the last attempt's address", async () => {
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-details"));
    const row = screen.getByTestId("new-device-lock-details-row");
    expect(row.textContent).toContain("Locked at");
    expect(row.textContent).toContain("100.64.1.2");
    expect(row.textContent).toContain(
      "This device, your other signed-in devices and the server keep working.",
    );
  });

  it("Hide swaps the bar for the pill; the pill brings the bar back", async () => {
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-hide"));
    expect(screen.queryByTestId("new-device-lock-alert")).toBeNull();
    const pill = screen.getByTestId("new-device-lock");
    expect(pill.textContent).toContain("New devices locked out");
    fireEvent.click(pill.querySelector("button") as HTMLButtonElement);
    expect(screen.getByTestId("new-device-lock-alert")).toBeTruthy();
    expect(screen.queryByTestId("new-device-lock")).toBeNull();
  });

  it("Hide is remembered for THIS lock only: a later lock shows the bar again", async () => {
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-hide"));
    expect(localStorage.getItem(HIDDEN_KEY)).toBe(String(LOCKED_AT));
    // Same lock on the next poll: still hidden.
    await act(() => useLockStore.getState().refresh());
    expect(screen.queryByTestId("new-device-lock-alert")).toBeNull();
    // A new lock (unlocked, then attacked again): the bar is back.
    lockResponse = () => json(locked({ lockedAt: LOCKED_AT + 60_000 }));
    await act(() => useLockStore.getState().refresh());
    expect(screen.getByTestId("new-device-lock-alert")).toBeTruthy();
  });

  it("Unlock POSTs, removes every lock surface, and confirms in the action toast", async () => {
    const toast = vi.fn();
    useStore.setState({ showActionToast: toast });
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-unlock"));
    await waitFor(() =>
      expect(screen.queryByTestId("new-device-lock-alert")).toBeNull(),
    );
    expect(
      calls.some(
        (c) => c.url.endsWith("/api/auth/unlock") && c.method === "POST",
      ),
    ).toBe(true);
    expect(screen.queryByTestId("new-device-lock")).toBeNull();
    expect(toast).toHaveBeenCalledWith("New devices can sign in again.", true);
  });

  it("a failed unlock keeps the bar and points at the CLI", async () => {
    const toast = vi.fn();
    useStore.setState({ showActionToast: toast });
    unlockResponse = () => json({ error: "boom" }, 500);
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-unlock"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(
      "Couldn't unlock. Run `autonomos auth unlock` on the server.",
      false,
    );
    expect(screen.getByTestId("new-device-lock-alert")).toBeTruthy();
  });

  it("the bell has a pinned lockout entry while locked, even with the bar hidden", async () => {
    startOwner();
    fireEvent.click(await screen.findByTestId("new-device-lock-hide"));
    fireEvent.click(screen.getByTitle("Notifications"));
    const notice = await screen.findByTestId("new-device-lock-notice");
    expect(notice.textContent).toContain("New devices locked out");
    expect(notice.textContent).toContain("Unlock new devices");
    // Its Details reopens the bar with the details row open.
    fireEvent.click(
      Array.from(notice.querySelectorAll("button")).find(
        (b) => b.textContent === "Details",
      ) as HTMLButtonElement,
    );
    expect(screen.getByTestId("new-device-lock-alert")).toBeTruthy();
    expect(screen.getByTestId("new-device-lock-details-row")).toBeTruthy();
  });
});
