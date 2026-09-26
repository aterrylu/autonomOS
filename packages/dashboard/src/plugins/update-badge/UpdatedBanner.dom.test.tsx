// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import type { SessionInfo } from "../../store";
import { useStore } from "../../store";
import { UpdatedBanner, verifyTiming } from "./UpdatedBanner";
import { useUpdateBus } from "./updateBus";
import { type UpdatedFlag, writeUpdatedFlag } from "./updateFlow";

/**
 * The post-update banner reads (and clears) the flag the flow wrote before
 * its reload, then waits — bounded — for the new daemon's agent check
 * (`status.verification`). Problems turn it AMBER with Details + Restore;
 * Restore is only ever the operator's click.
 */

const session = (id: string): SessionInfo => ({
  id,
  name: id,
  status: "running",
  workingDirectory: "/tmp",
  provider: "claude-code",
  createdAt: 0,
  updatedAt: 0,
});

type Rec = Record<string, unknown> | null;
let status: Rec;
let fetchMock: ReturnType<typeof vi.fn>;

function doneRecord(extra: Record<string, unknown> = {}): Rec {
  return {
    phase: "done",
    from: "0.6.1",
    to: "0.7.0",
    startedAt: "2026-09-24T07:12:00Z",
    updatedAt: "2026-09-24T07:13:00Z",
    snapshotId: "0.6.1-2026-09-24T0712",
    ...extra,
  };
}

const saved = { ...verifyTiming };

beforeEach(() => {
  verifyTiming.pollMs = 10;
  verifyTiming.maxWaitMs = 2_000;
  sessionStorage.clear();
  localStorage.clear();
  useStore.setState({ sessions: [] });
  status = null;
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url === "/api/system/upgrade"
        ? new Response(
            JSON.stringify({
              current: "0.7.0",
              supervised: true,
              installMode: "bundle",
              status,
              armed: null,
              idleWindowMs: 30_000,
              busy: [],
            }),
          )
        : new Response("{}", { status: 404 }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  Object.assign(verifyTiming, saved);
  vi.unstubAllGlobals();
});

async function renderWith(flag: UpdatedFlag) {
  writeUpdatedFlag(flag);
  await act(async () => {
    render(<UpdatedBanner />);
  });
  return screen.getByTestId("updated-banner");
}

describe("UpdatedBanner", () => {
  it("renders nothing without the post-update flag when no update has problems", async () => {
    status = doneRecord({
      verification: { checkedAt: "x", checked: 2, problems: [] },
    });
    await act(async () => {
      render(<UpdatedBanner />);
    });
    expect(screen.queryByTestId("updated-banner")).toBeNull();
  });

  it("an agent check that never reports back is amber, not an all-clear", async () => {
    verifyTiming.maxWaitMs = 40;
    status = doneRecord(); // snapshot taken, verification never written
    const banner = await renderWith({
      updatedTo: "0.7.0",
      interruptedNames: [],
    });
    await vi.waitFor(() =>
      expect(banner.textContent).toContain(
        "Couldn't confirm your agents reopened",
      ),
    );
    expect(banner.getAttribute("data-tone")).toBe("attention");
  });

  describe("durable problem warning (no flag: reload, second tab)", () => {
    const withProblem = () =>
      doneRecord({
        verification: {
          checkedAt: "x",
          checked: 2,
          problems: [
            { id: "a1", name: "qa-codex", issue: "It didn't come back" },
          ],
        },
      });

    it("resurfaces the amber banner with Restore from the server record", async () => {
      status = withProblem();
      await act(async () => {
        render(<UpdatedBanner />);
      });
      const banner = await screen.findByTestId("updated-banner");
      await vi.waitFor(() =>
        expect(banner.getAttribute("data-tone")).toBe("attention"),
      );
      expect(banner.textContent).toContain("qa-codex");
      expect(screen.getByTestId("banner-restore")).toBeTruthy();
    });

    it("stays dismissed in this browser once dismissed", async () => {
      status = withProblem();
      const first = render(<UpdatedBanner />);
      const banner = await screen.findByTestId("updated-banner");
      await vi.waitFor(() =>
        expect(banner.getAttribute("data-tone")).toBe("attention"),
      );
      fireEvent.click(screen.getByLabelText("Dismiss"));
      expect(screen.queryByTestId("updated-banner")).toBeNull();
      first.unmount();
      await act(async () => {
        render(<UpdatedBanner />);
      });
      expect(screen.queryByTestId("updated-banner")).toBeNull();
    });

    it("does not resurface once a different version is running (restored)", async () => {
      status = { ...withProblem(), to: "0.7.99" };
      await act(async () => {
        render(<UpdatedBanner />);
      });
      expect(screen.queryByTestId("updated-banner")).toBeNull();
    });
  });

  it("says it's checking until the check lands, then a green all-reopened line", async () => {
    status = doneRecord(); // no verification yet
    const banner = await renderWith({
      updatedTo: "0.7.0",
      interruptedNames: ["api-refactor", "codex-tests"],
    });
    expect(banner.textContent).toContain("Updated to v0.7.0.");
    expect(banner.textContent).toContain("Checking that your agents reopened…");
    // Read-and-clear: a manual reload must not re-announce.
    expect(sessionStorage.getItem("autonomos:updated")).toBeNull();

    status = doneRecord({
      verification: { checkedAt: "x", checked: 5, problems: [] },
    });
    await screen.findByText(/All 5 agents reopened/);
    expect(banner.getAttribute("data-tone")).toBe("ok");
    expect(banner.textContent).toContain(
      "api-refactor and codex-tests were interrupted. Prompt them to continue",
    );
    expect(screen.queryByTestId("banner-restore")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(screen.queryByTestId("updated-banner")).toBeNull();
  });

  it("turns amber with Details + Restore when agents need attention — and never restores on its own", async () => {
    status = doneRecord({
      verification: {
        checkedAt: "x",
        checked: 5,
        problems: [
          {
            id: "b",
            name: "codex-tests",
            issue: "Codex thread id missing from its record",
          },
        ],
      },
    });
    const nonceBefore = useUpdateBus.getState().restoreNonce;
    const banner = await renderWith({
      updatedTo: "0.7.0",
      interruptedNames: [],
    });
    await screen.findByText(/but codex-tests needs a look/);
    expect(banner.getAttribute("data-tone")).toBe("attention");
    // The Restore action names the version it goes back to.
    expect(screen.getByTestId("banner-restore").textContent).toBe(
      "Restore v0.6.1",
    );
    // Nothing was requested just by showing the problem.
    expect(useUpdateBus.getState().restoreNonce).toBe(nonceBefore);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const rows = screen.getAllByTestId("updated-banner-problem");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(
      "Codex thread id missing from its record",
    );
    expect(screen.getByTestId("updated-banner-details").textContent).toContain(
      "Restore v0.6.1 goes back to the version and snapshot from before this update",
    );

    fireEvent.click(screen.getByTestId("banner-restore"));
    expect(useUpdateBus.getState().restoreNonce).toBe(nonceBefore + 1);
  });

  it("doesn't wait for a check that will never run (no snapshot on the record)", async () => {
    useStore.setState({ sessions: [session("a"), session("b")] });
    status = doneRecord({ snapshotId: undefined });
    const banner = await renderWith({
      updatedTo: "0.7.0",
      interruptedNames: [],
    });
    await screen.findByText(/2 agents reopened/);
    expect(banner.textContent).not.toContain("Checking that");
  });

  it("gives up waiting after the bound and says where to look", async () => {
    verifyTiming.maxWaitMs = 40;
    status = doneRecord();
    await renderWith({ updatedTo: "0.7.0", interruptedNames: [] });
    expect(
      await screen.findByText(/Couldn't confirm your agents reopened/),
    ).toBeInTheDocument();
  });

  it("announces a finished Restore with its snapshot", async () => {
    const banner = await renderWith({
      kind: "rollback",
      updatedTo: "0.6.1",
      interruptedNames: [],
      withSnapshot: true,
    });
    expect(banner.textContent).toContain(
      "Restored v0.6.1 and the snapshot from before the update.",
    );
    // A restore has no agent check to wait for — its only request asks the
    // server to check for updates, so the newer release is offered again
    // (a restored daemon hasn't run its own check yet).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls.map(
      (c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`,
    );
    expect(new Set(calls)).toEqual(new Set(["POST /api/system/check-updates"]));
  });

  it("is honest about a code-only Restore", async () => {
    const banner = await renderWith({
      kind: "rollback",
      updatedTo: "0.6.1",
      interruptedNames: [],
      withSnapshot: false,
    });
    expect(banner.textContent).toContain("Restored v0.6.1.");
    expect(banner.textContent).not.toContain("snapshot");
    expect(banner.textContent).toContain(
      "Your agents, schedules and settings were left as they are.",
    );
  });
});
