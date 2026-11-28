// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { NotificationPanel } from "./NotificationPanel";

// The server's unread count is TRUE past its per-agent retention cap, so the
// bell's total can exceed the rows it can list. The panel must say so, and
// "Mark all read" must clear every session the server counts, including one
// with no row on the page, not just the rows it listed.

const row = (sessionId: string, i: number, read = false) => ({
  event: "Notification",
  message: `m${i}`,
  timestamp: Date.now() - i,
  read,
  sessionId,
  sessionName: sessionId,
});

// s1 has 2 listed unread rows. s2's 73 unread are all older than the page.
const START: Record<string, number> = { s1: 2, s2: 73 };

let marked: Set<string>;
let failRefetch: boolean;
let feedCalls: number;

function feedBody() {
  const unreadBySession = Object.fromEntries(
    Object.entries(START).filter(([id]) => !marked.has(id)),
  );
  const totalUnread = Object.values(unreadBySession).reduce((a, b) => a + b, 0);
  const s1Read = marked.has("s1");
  return {
    notifications: [row("s1", 0, s1Read), row("s1", 1, s1Read)],
    totalUnread,
    unreadNotShown: unreadBySession.s2 ?? 0,
    unreadBySession,
  };
}

beforeEach(() => {
  marked = new Set();
  failRefetch = false;
  feedCalls = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      const m = url.match(/\/api\/notifications\/([^/]+)\/read/);
      if (m && init?.method === "POST") {
        marked.add(m[1]);
        return json({ ok: true });
      }
      if (url.includes("/api/notifications")) {
        feedCalls++;
        if (feedCalls > 1 && failRefetch)
          return Promise.reject(new TypeError("network down"));
        return json(feedBody());
      }
      return json({});
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NotificationPanel past the retention cap", () => {
  it("shows the true total and says how many it can't list", async () => {
    render(<NotificationPanel onClose={() => {}} />);
    expect(await screen.findByText("75 unread")).toBeInTheDocument();
    expect(screen.getByTestId("unread-not-shown")).toHaveTextContent(
      "73 older unread not shown",
    );
  });

  it("Mark all read marks a session with no listed row and clears the true total", async () => {
    const user = userEvent.setup();
    render(<NotificationPanel onClose={() => {}} />);
    await screen.findByText("75 unread");
    await user.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() =>
      expect(screen.queryByText(/\d+ unread$/)).not.toBeInTheDocument(),
    );
    expect(marked).toEqual(new Set(["s1", "s2"]));
    expect(screen.queryByTestId("unread-not-shown")).not.toBeInTheDocument();
  });

  it("if the refresh fails, it drops each marked session's WHOLE count and says why in the console", async () => {
    failRefetch = true;
    const user = userEvent.setup();
    render(<NotificationPanel onClose={() => {}} />);
    await screen.findByText("75 unread");
    await user.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() =>
      expect(screen.queryByText(/\d+ unread$/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("unread-not-shown")).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("refresh after mark-all failed"),
      expect.anything(),
    );
  });
});
