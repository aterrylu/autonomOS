// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test/setup-dom";
import { App } from "./App";
import { LoginPage } from "./LoginPage";

/**
 * A NEW device while new devices are locked out (ADR-148, Terry's mockup A):
 * the server answers 423 NEW_DEVICES_LOCKED to every request from it, before
 * looking at any credential. The dashboard must show the full-page lock
 * screen, never the token form (which the server would refuse unread). The
 * real App is driven; the server is faked at the fetch boundary.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const LOCKED_423 = () =>
  json(
    {
      error:
        "New devices are locked after repeated failed sign-ins. Sign in from a device that's already signed in, or run `autonomos auth unlock` on the server.",
      code: "NEW_DEVICES_LOCKED",
    },
    423,
  );

let server: (url: string, init?: RequestInit) => Response;
let calls: Array<{ url: string; method: string; body?: string }>;

beforeEach(() => {
  calls = [];
  server = () => LOCKED_423();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return server(url, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("locked-out new device", () => {
  it("a 423 on the page-load probe shows the lock screen, not the token form", async () => {
    render(<App />);
    expect(await screen.findByTestId("locked-out-page")).toBeTruthy();
    expect(screen.getByText("New devices are locked out")).toBeTruthy();
    // No token box, no Authenticate button: nothing to guess with.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText("Authenticate")).toBeNull();
    // How the owner gets them in again is spelled out.
    expect(screen.getByText("autonomos auth unlock")).toBeTruthy();
  });

  it("says nothing about the lock itself (no count, no address, no token hint)", async () => {
    render(<App />);
    const page = await screen.findByTestId("locked-out-page");
    const text = page.textContent ?? "";
    expect(text).not.toMatch(/\d+ (failed|wrong)/);
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(text).not.toMatch(/token/i);
  });

  it("the probe sends no credential, so looking at the page is never a guess", async () => {
    render(<App />);
    await screen.findByTestId("locked-out-page");
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeUndefined();
    }
  });

  it("Check again while still locked stays put and says so", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Check again"));
    expect(
      await screen.findByText(
        "Still locked. Ask the owner to unlock new devices.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("locked-out-page")).toBeTruthy();
  });

  it("Check again after the owner unlocks turns back into the sign-in page", async () => {
    render(<App />);
    await screen.findByTestId("locked-out-page");
    server = () => json({ error: "Unauthorized" }, 401);
    fireEvent.click(screen.getByText("Check again"));
    await waitFor(() =>
      expect(document.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(screen.queryByTestId("locked-out-page")).toBeNull();
  });

  it("a 423 on a sign-in attempt switches the login form to the lock screen", async () => {
    const onLockedOut = vi.fn();
    render(<LoginPage onLockedOut={onLockedOut} />);
    fireEvent.change(screen.getByPlaceholderText("Paste token here..."), {
      target: { value: "abcd" },
    });
    fireEvent.click(screen.getByText("Authenticate"));
    await waitFor(() => expect(onLockedOut).toHaveBeenCalledTimes(1));
    // Not reported as a wrong token: it was never evaluated.
    expect(screen.queryByText("Invalid token")).toBeNull();
  });

  it("an ordinary 401 still shows the login form (the lock screen is only for 423)", async () => {
    server = () => json({ error: "Unauthorized" }, 401);
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector('input[type="password"]')).not.toBeNull(),
    );
    expect(screen.queryByTestId("locked-out-page")).toBeNull();
  });
});
