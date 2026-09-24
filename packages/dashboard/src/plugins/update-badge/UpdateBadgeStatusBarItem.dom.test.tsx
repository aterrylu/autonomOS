// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import type { SessionInfo } from "../../store";
import { useStore } from "../../store";
import { UpdateBadgeStatusBarItem } from "./UpdateBadgeStatusBarItem";
import { useUpdateBus } from "./updateBus";
import { updateTiming } from "./useUpdateFlow";

/**
 * UpdateBadgeStatusBarItem — the update pill + the in-app update flow
 * (ADR-101). The pill reads the server's cached update-check answer off
 * /api/system/version and renders only when an update is known; clicking it
 * walks What's new → Check agents → Update, then follows the server-side job
 * through the restart gap.
 *
 * The server is faked at the fetch boundary with REAL Response objects (the
 * api client core parses res.text()).
 */

type Handler = (init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const VERSION = {
  version: "0.6.1",
  platform: "darwin",
  arch: "arm64",
  latest: "0.7.0",
  updateAvailable: true,
  checkedAt: "2026-09-20T00:00:00Z",
  installMode: "bundle",
  releaseUrl: "https://github.com/aterrylu/autonomOS/releases/tag/v0.7.0",
};

const IDLE_UPGRADE = {
  current: "0.6.1",
  supervised: true,
  installMode: "bundle",
  status: null,
  armed: null,
  idleWindowMs: 30_000,
  busy: [],
};

function record(
  phase: string,
  message?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    phase,
    from: "0.6.1",
    to: "0.7.0",
    ...(message && { message }),
    ...extra,
    startedAt: "2026-09-23T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
  };
}

let routes: Record<string, Handler>;
let fetchMock: ReturnType<typeof vi.fn>;

function installServer(overrides: Record<string, Handler> = {}) {
  routes = {
    "GET /api/system/version": () => json(VERSION),
    "GET /api/system/upgrade": () => json(IDLE_UPGRADE),
    "GET /api/system/releases": () =>
      json({
        current: "0.6.1",
        latest: "0.7.0",
        updateAvailable: true,
        releaseUrl: VERSION.releaseUrl,
        releases: [],
      }),
    ...overrides,
  };
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const h = routes[key];
    if (!h) return Promise.resolve(json({ error: `no route ${key}` }, 404));
    try {
      return Promise.resolve(h(init));
    } catch (err) {
      return Promise.reject(err);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
}

function session(
  id: string,
  name: string,
  provider = "claude-code",
): SessionInfo {
  return {
    id,
    name,
    status: "running",
    workingDirectory: "/tmp",
    provider,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function renderPill() {
  await act(async () => {
    render(<UpdateBadgeStatusBarItem />);
  });
  return screen.findByTestId("update-badge");
}

async function openToCheck() {
  fireEvent.click(await renderPill());
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
}

const saved = { ...updateTiming };
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateTiming.pollMs = 15;
  updateTiming.reconnectMs = 15;
  sessionStorage.clear();
  useStore.setState({ sessions: [], agentStatuses: {} });
  reload = vi.fn();
  // jsdom's location.reload is non-configurable — spy the GETTER instead.
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);
});

afterEach(() => {
  Object.assign(updateTiming, saved);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdateBadgeStatusBarItem — the pill", () => {
  it("renders the pill with an Update affordance and never calls anywhere but /api/system", async () => {
    installServer();
    const badge = await renderPill();
    expect(badge.textContent).toContain(
      "New release available (v0.6.1 → v0.7.0)",
    );
    expect(badge.textContent).toContain("Update");
    // No icon, no GitHub link on the pill itself.
    expect(badge.querySelector("svg")).toBeNull();
    expect(badge.querySelector("a")).toBeNull();
    // The dashboard reads only the server's cached answer — never GitHub.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/system\//);
    }
  });

  it("renders nothing when updateAvailable is true but latest is absent (no 'vnull')", async () => {
    installServer({
      "GET /api/system/version": () => json({ ...VERSION, latest: null }),
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing when up to date", async () => {
    installServer({
      "GET /api/system/version": () =>
        json({ ...VERSION, latest: "0.6.1", updateAvailable: false }),
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing against an older server without the additive fields", async () => {
    installServer({
      "GET /api/system/version": () =>
        json({ version: "0.5.0", platform: "darwin", arch: "arm64" }),
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });
});

describe("UpdateBadgeStatusBarItem — What's new", () => {
  it("clicking the pill opens the modal (not GitHub); GitHub moves to the footer", async () => {
    installServer();
    fireEvent.click(await renderPill());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("What's new in v0.7.0")).toBeInTheDocument();
    const gh = screen.getByTestId("update-github-link");
    expect(gh.getAttribute("href")).toBe(VERSION.releaseUrl);
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(gh.textContent).toBe("Full notes on GitHub");
  });

  it("stacks every release since the user's version newest-first, with a breaking-change callout", async () => {
    installServer({
      "GET /api/system/releases": () =>
        json({
          current: "0.6.1",
          latest: "0.7.0",
          updateAvailable: true,
          releaseUrl: VERSION.releaseUrl,
          // Deliberately out of order — the dashboard sorts.
          releases: [
            {
              version: "0.6.2",
              name: "v0.6.2",
              body: "- small fix",
              url: "https://example.com/0.6.2",
              publishedAt: "2026-09-01T00:00:00Z",
            },
            {
              version: "0.7.0",
              name: "v0.7.0",
              body: "## Breaking change\n- old routes 404",
              url: "https://example.com/0.7.0",
              publishedAt: "2026-09-19T00:00:00Z",
            },
            {
              version: "0.6.10",
              name: "v0.6.10",
              body: "**bold** notes",
              url: "https://example.com/0.6.10",
              publishedAt: "2026-09-10T00:00:00Z",
            },
          ],
        }),
    });
    fireEvent.click(await renderPill());
    await waitFor(() =>
      expect(screen.getAllByTestId("release-section")).toHaveLength(3),
    );
    expect(
      screen
        .getAllByTestId("release-section")
        .map((s) => s.getAttribute("data-version")),
    ).toEqual(["0.7.0", "0.6.10", "0.6.2"]);
    expect(screen.getByTestId("breaking-callout").textContent).toContain(
      "v0.7.0 has a breaking change",
    );
  });

  it("falls back to a GitHub link when notes are unavailable, and never blocks Continue", async () => {
    installServer({
      "GET /api/system/releases": () =>
        json({
          current: "0.6.1",
          latest: "0.7.0",
          updateAvailable: true,
          releaseUrl: VERSION.releaseUrl,
          releases: null,
        }),
    });
    fireEvent.click(await renderPill());
    const fallback = await screen.findByTestId("notes-unavailable");
    expect(fallback.textContent).toContain("Release notes unavailable");
    expect(fallback.querySelector("a")?.getAttribute("href")).toBe(
      VERSION.releaseUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("update-check-clear")).toBeInTheDocument();
  });
});

describe("UpdateBadgeStatusBarItem — Check agents", () => {
  it("lists every agent, highlights the busy ones, preselects 'when idle', and arms on submit", async () => {
    useStore.setState({
      sessions: [
        session("a", "api-refactor"),
        session("b", "codex-tests", "codex"),
        session("c", "Planner"),
        session("d", "docs-writer"),
      ],
      agentStatuses: {
        a: { status: "working" },
        b: { status: "tool_running" },
        c: { status: "needs_input" },
        d: { status: "idle" },
      },
    });
    const busy = [
      { id: "a", name: "api-refactor", status: "working" },
      { id: "b", name: "codex-tests", status: "tool_running" },
      { id: "c", name: "Planner", status: "needs_input" },
    ];
    let posted: unknown = null;
    installServer({
      "GET /api/system/upgrade": () => json({ ...IDLE_UPGRADE, busy }),
      "POST /api/system/upgrade": (init) => {
        posted = JSON.parse(String(init?.body));
        return json({
          ok: true,
          armed: {
            target: "0.7.0",
            armedAt: "2026-09-23T10:00:00Z",
            idleSince: null,
          },
        });
      },
    });
    await openToCheck();
    expect(
      await screen.findByText("3 agents are mid-task"),
    ).toBeInTheDocument();

    const rows = screen.getAllByTestId("update-agent-row");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-busy"))).toEqual([
      "true",
      "true",
      "true",
      "false",
    ]);
    expect(rows[0].textContent).toContain(
      "Turn in progress — stops mid-turn, won't resume on its own",
    );
    expect(rows[1].textContent).toContain(
      "Running a command — it is killed; the thread is kept",
    );
    expect(rows[2].textContent).toContain(
      "Its pending question is dismissed — it will need re-asking",
    );
    expect(rows[3].textContent).toContain("Nothing lost");

    // Terry's default: wait for idle, preselected; idle window from the server.
    expect(screen.getByTestId("update-when-idle")).toBeChecked();
    expect(screen.getByTestId("update-when-now")).not.toBeChecked();
    expect(screen.getByText(/idle for 30 seconds/)).toBeInTheDocument();
    // "Update now" spells out what it interrupts.
    expect(
      screen.getByText(
        /Interrupts api-refactor and codex-tests mid-task and dismisses Planner's question/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("update-start"));
    const armed = await screen.findByTestId("update-badge-armed");
    expect(posted).toEqual({ when: "idle" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(armed.textContent).toContain("Update to v0.7.0 waiting on 3 agents");
  });

  it("keeps polling while armed: follows the agents going idle, then the launch", async () => {
    // Live QA regression: the armed poll returned before rescheduling, so the
    // pill froze on its first answer and the launch was never picked up.
    let phase: "pre" | "busy" | "idle" | "launched" = "pre";
    const armedRec = {
      target: "0.7.0",
      armedAt: "2026-09-23T10:00:00Z",
      idleSince: null as string | null,
    };
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy:
            phase === "pre" || phase === "busy"
              ? [{ id: "a", name: "api-refactor", status: "working" }]
              : [],
          armed:
            phase === "pre" || phase === "launched"
              ? null
              : {
                  ...armedRec,
                  idleSince: phase === "idle" ? "2026-09-23T10:01:00Z" : null,
                },
          status: phase === "launched" ? record("downloading") : null,
        }),
      "POST /api/system/upgrade": () => {
        phase = "busy";
        return json({ ok: true, armed: armedRec });
      },
    });
    await openToCheck();
    fireEvent.click(await screen.findByTestId("update-start"));
    const armed = await screen.findByTestId("update-badge-armed");
    await waitFor(() =>
      expect(armed.textContent).toContain("waiting on 1 agent"),
    );

    phase = "idle";
    await waitFor(() =>
      expect(screen.getByTestId("update-badge-armed").textContent).toContain(
        "starting shortly",
      ),
    );

    phase = "launched";
    expect(await screen.findByTestId("update-steps")).toBeInTheDocument();
    expect(screen.queryByTestId("update-badge-armed")).toBeNull();
  });

  it("a run that stops reporting ends on the failed screen instead of spinning forever", async () => {
    let posted = false;
    installServer({
      "POST /api/system/upgrade": () => {
        posted = true;
        return json({ ok: true, launched: true });
      },
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          status: posted
            ? {
                phase: "launching",
                from: "0.6.1",
                to: "0.7.0",
                startedAt: "2026-09-23T10:00:00.000Z",
                // The job never wrote again: older than the launch bound.
                updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
              }
            : null,
        }),
    });
    await openToCheck();
    fireEvent.click(await screen.findByTestId("update-start"));
    expect(
      await screen.findByText(/stopped reporting at "launching"/),
    ).toBeInTheDocument();
  });

  it("shows the terminal instructions when the daemon isn't supervised", async () => {
    installServer({
      "GET /api/system/upgrade": () =>
        json({ ...IDLE_UPGRADE, supervised: false }),
    });
    await openToCheck();
    expect(
      await screen.findByTestId("update-not-supervised"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-command").textContent).toBe(
      "autonomos upgrade",
    );
  });

  it("points a dev checkout at git pull + make prod, not at a command that refuses", async () => {
    installServer({
      "GET /api/system/version": () => json({ ...VERSION, installMode: null }),
      "GET /api/system/upgrade": () =>
        json({ ...IDLE_UPGRADE, supervised: false, installMode: null }),
    });
    await openToCheck();
    expect((await screen.findByTestId("update-command")).textContent).toBe(
      "git pull && make prod",
    );
  });
});

describe("UpdateBadgeStatusBarItem — running the update", () => {
  /** The body of the launch POST, once it has happened. */
  let posted: unknown = null;

  /** Walk to the all-clear screen and press Update. */
  async function launch(): Promise<void> {
    posted = null;
    routes["POST /api/system/upgrade"] = (init) => {
      posted = JSON.parse(String(init?.body));
      return json({ ok: true, launched: true });
    };
    await openToCheck();
    fireEvent.click(await screen.findByTestId("update-start"));
  }

  it("reconnects through the restart and reloads once the new version answers 'done'", async () => {
    useStore.setState({ sessions: [session("a", "api-refactor")] });
    installServer();
    let phase = "downloading";
    let daemonUp = true;
    routes["GET /api/system/upgrade"] = () => {
      if (!daemonUp) throw new TypeError("Failed to fetch");
      return json({
        ...IDLE_UPGRADE,
        current: phase === "done" ? "0.7.0" : "0.6.1",
        // Before launch the check screen sees no record at all.
        status: posted ? record(phase) : null,
      });
    };
    await launch();
    await waitFor(() => expect(posted).toEqual({ when: "now" }));
    expect(await screen.findByText("Updating to v0.7.0")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getByTestId("update-steps")
          .querySelector('[data-state="active"]')
          ?.getAttribute("data-step"),
      ).toBe("download"),
    );

    // The daemon goes down mid-restart: every request fails.
    phase = "restarting";
    daemonUp = false;
    routes["GET /api/system/version"] = () => {
      throw new TypeError("Failed to fetch");
    };
    expect(
      await screen.findByTestId("update-reconnecting"),
    ).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    // The record says done but the OLD build is still the one answering:
    // reloading now would just reload the old assets — keep waiting.
    phase = "done";
    daemonUp = true;
    routes["GET /api/system/version"] = () => json(VERSION);
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId("update-reconnecting")).toBeInTheDocument();

    // The new version answers.
    routes["GET /api/system/version"] = () =>
      json({ ...VERSION, version: "0.7.0", updateAvailable: false });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(sessionStorage.getItem("autonomos:updated") ?? ""),
    ).toEqual({ kind: "upgrade", updatedTo: "0.7.0", interruptedNames: [] });
  });

  it("shows the rolled-back modal with the job's message", async () => {
    installServer();
    routes["GET /api/system/upgrade"] = () =>
      json({
        ...IDLE_UPGRADE,
        status: posted
          ? record(
              "rolled_back",
              "Health check timed out: v0.7.0 didn't answer within 45 seconds.",
            )
          : null,
      });
    await launch();
    expect(
      await screen.findByText("v0.7.0 didn't start — you're back on v0.6.1"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-failed-message").textContent).toContain(
      "Health check timed out",
    );
    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("surfaces a 401 after reconnect as an explicit error, never a silent login bounce", async () => {
    installServer();
    let down = false;
    routes["GET /api/system/upgrade"] = () => {
      if (down) throw new TypeError("Failed to fetch");
      return json({ ...IDLE_UPGRADE, status: null });
    };
    await launch();
    await screen.findByText("Updating to v0.7.0");
    down = true;
    routes["GET /api/system/version"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await screen.findByTestId("update-reconnecting");
    // Back up — but the new daemon rejects this browser's cookie.
    routes["GET /api/system/version"] = () =>
      json({ error: "Unauthorized" }, 401);
    expect(
      await screen.findByText(
        "Your session token was rejected after the update",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("update-reconnecting")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("tells the operator to check the host when the daemon never comes back", async () => {
    updateTiming.giveUpMs = 60;
    installServer();
    let down = false;
    routes["GET /api/system/upgrade"] = () => {
      if (down) throw new TypeError("Failed to fetch");
      return json({ ...IDLE_UPGRADE, status: null });
    };
    await launch();
    await screen.findByText("Updating to v0.7.0");
    down = true;
    routes["GET /api/system/version"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await screen.findByTestId("update-reconnecting");
    expect((await screen.findByTestId("update-gave-up")).textContent).toContain(
      "autonomos status",
    );
    // Still probing — giving up is a message, not a stop.
    expect(screen.getByTestId("update-reconnecting")).toBeInTheDocument();
  });
});

describe("UpdateBadgeStatusBarItem — snapshots (ADR-101 amendment)", () => {
  const releasesWith = (
    releases: Array<{
      version: string;
      body: string;
      storageFormatChange?: boolean;
    }>,
  ) =>
    json({
      current: "0.6.1",
      latest: "0.7.0",
      updateAvailable: true,
      releaseUrl: VERSION.releaseUrl,
      releases: releases.map((r) => ({
        name: `v${r.version}`,
        url: null,
        publishedAt: null,
        ...r,
      })),
    });

  it("shows the storage-format callout from the structured flag only", async () => {
    installServer({
      "GET /api/system/releases": () =>
        releasesWith([
          {
            version: "0.7.0",
            body: "<!-- autonomos:storage-format-change -->\n- new format",
            storageFormatChange: true,
          },
        ]),
    });
    fireEvent.click(await renderPill());
    const callout = await screen.findByTestId("storage-format-callout");
    expect(callout.textContent).toContain(
      "This update changes how agents are stored",
    );
    expect(callout.textContent).toContain("won't carry back");
    // The marker itself never renders.
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "autonomos:storage-format-change",
    );
  });

  it("does NOT text-sniff: prose about storage without the flag gets no callout", async () => {
    installServer({
      "GET /api/system/releases": () =>
        releasesWith([
          {
            version: "0.7.0",
            body: "This update changes how agents are stored (storage format change).",
            storageFormatChange: false,
          },
        ]),
    });
    fireEvent.click(await renderPill());
    await screen.findByTestId("release-section");
    expect(screen.queryByTestId("storage-format-callout")).toBeNull();
  });

  it("CheckClear promises the snapshot and the paired rollback", async () => {
    installServer();
    await openToCheck();
    const clear = await screen.findByTestId("update-check-clear");
    expect(clear.textContent).toContain("Snapshot first");
    expect(clear.textContent).toContain(
      "restore it any time from Settings → Updates",
    );
    expect(clear.textContent).toContain("code and snapshot together");
  });

  it("CheckBusy says a snapshot is saved first", async () => {
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [{ id: "a", name: "api-refactor", status: "working" }],
        }),
    });
    await openToCheck();
    expect(
      await screen.findByText(
        /A snapshot of your agents' setup is saved before anything changes/,
      ),
    ).toBeInTheDocument();
  });

  it("starts the step list with Save snapshot (showing its id) and ends with Verify agents", async () => {
    installServer();
    let posted = false;
    routes["POST /api/system/upgrade"] = () => {
      posted = true;
      return json({ ok: true, launched: true });
    };
    routes["GET /api/system/upgrade"] = () =>
      json({
        ...IDLE_UPGRADE,
        status: posted
          ? record("snapshotting", undefined, {
              snapshotId: "0.6.1-2026-09-24T0712",
            })
          : null,
      });
    await openToCheck();
    fireEvent.click(await screen.findByTestId("update-start"));
    const steps = await screen.findByTestId("update-steps");
    await waitFor(() =>
      expect(
        steps
          .querySelector('[data-step="snapshot"]')
          ?.getAttribute("data-state"),
      ).toBe("active"),
    );
    // "active" is already true in the optimistic launching phase, before the
    // first poll carries the snapshot id — so wait for the id itself.
    await waitFor(() =>
      expect(
        steps.querySelector('[data-step="snapshot"]')?.textContent,
      ).toContain("snapshots/0.6.1-2026-09-24T0712"),
    );
    const ids = [...steps.querySelectorAll("[data-step]")].map((li) =>
      li.getAttribute("data-step"),
    );
    expect(ids[0]).toBe("snapshot");
    expect(ids[ids.length - 1]).toBe("verify-agents");
  });

  it("RolledBack copy mentions the snapshot when the run took one", async () => {
    installServer();
    let posted = false;
    routes["POST /api/system/upgrade"] = () => {
      posted = true;
      return json({ ok: true, launched: true });
    };
    routes["GET /api/system/upgrade"] = () =>
      json({
        ...IDLE_UPGRADE,
        status: posted
          ? record("rolled_back", "Health check timed out.", {
              snapshotId: "0.6.1-x",
            })
          : null,
      });
    await openToCheck();
    fireEvent.click(await screen.findByTestId("update-start"));
    expect(
      (await screen.findByTestId("update-failed-summary")).textContent,
    ).toContain(
      "restored the previous version and your agents' setup from the snapshot taken just before",
    );
  });
});

describe("UpdateBadgeStatusBarItem — Restore", () => {
  const SNAPSHOTS = {
    snapshots: [
      {
        id: "0.6.1-2026-09-24T0712",
        fromVersion: "0.6.1",
        toVersion: "0.7.0",
        createdAt: "2026-09-24T07:12:00Z",
        entries: ["sessions.json"],
        bytes: 219_136,
        agentCount: 5,
      },
    ],
    rollback: { version: "0.6.1", snapshotId: "0.6.1-2026-09-24T0712" },
  };
  const UP_TO_DATE = { ...VERSION, version: "0.7.0", updateAvailable: false };

  async function requestRestore() {
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    // Let the version fetch land so the flow host is mounted with info.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      useUpdateBus.getState().requestRestore();
    });
  }

  it("works with no update available: confirm → rollback job → reconnect → reload flagged as a restore", async () => {
    let launched = false;
    // Polls after the POST that still see the PREVIOUS run's record (the job
    // hasn't written its own yet) — the window the baseline exists for.
    let staleReads = 2;
    let daemonUp = true;
    let phase = "launching";
    installServer({
      "GET /api/system/version": () =>
        daemonUp
          ? json(
              phase === "done"
                ? { ...UP_TO_DATE, version: "0.6.1" }
                : UP_TO_DATE,
            )
          : Promise.reject(new TypeError("Failed to fetch")),
      "GET /api/system/snapshots": () => json(SNAPSHOTS),
      "GET /api/system/upgrade": () => {
        if (!daemonUp) throw new TypeError("Failed to fetch");
        return json({
          ...IDLE_UPGRADE,
          current: phase === "done" ? "0.6.1" : "0.7.0",
          status:
            launched && staleReads-- <= 0
              ? {
                  phase,
                  kind: "rollback",
                  from: "0.7.0",
                  to: "0.6.1",
                  startedAt: "2026-09-24T09:00:00Z",
                  updatedAt: new Date().toISOString(),
                }
              : {
                  // The previous upgrade's leftover record — NOT ours.
                  ...record("done"),
                  startedAt: "2026-09-24T07:12:00Z",
                },
        });
      },
      "POST /api/system/rollback": () => {
        launched = true;
        return json({
          ok: true,
          launched: true,
          target: SNAPSHOTS.rollback,
        });
      },
    });
    await requestRestore();
    // No pill (up to date), but the Restore confirmation opens.
    expect(screen.queryByTestId("update-badge")).toBeNull();
    const confirm = await screen.findByTestId("restore-confirm");
    expect(
      screen.getByText("Restore v0.6.1 and your agents' setup?"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("restore-snapshot").textContent).toContain(
      "214 KB",
    );
    expect(confirm.textContent).toContain("snapshots/0.6.1-2026-09-24T0712/");
    expect(confirm.textContent).toContain("Won't carry back");
    expect(confirm.textContent).toContain("Never touched");
    expect(confirm.textContent).toContain("autonomos rollback");

    fireEvent.click(screen.getByTestId("restore-confirm-button"));
    expect(await screen.findByText("Restoring v0.6.1")).toBeInTheDocument();
    // The old upgrade's "done" record must not trigger a reload.
    expect(reload).not.toHaveBeenCalled();

    phase = "restarting";
    daemonUp = false;
    expect(
      await screen.findByTestId("update-reconnecting"),
    ).toBeInTheDocument();
    phase = "done";
    daemonUp = true;
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(sessionStorage.getItem("autonomos:updated") ?? ""),
    ).toMatchObject({
      kind: "rollback",
      updatedTo: "0.6.1",
      withSnapshot: true,
    });
  });

  it("says plainly when no snapshot pairs with the previous version", async () => {
    installServer({
      "GET /api/system/version": () => json(UP_TO_DATE),
      "GET /api/system/snapshots": () =>
        json({
          snapshots: [],
          rollback: { version: "0.6.0", snapshotId: null },
        }),
    });
    await requestRestore();
    const note = await screen.findByTestId("restore-no-snapshot");
    expect(note.textContent).toContain(
      "No snapshot pairs with v0.6.0 (it was installed before snapshots existed) — only the code is restored; agent records stay as they are.",
    );
    // No snapshot rows claimed.
    expect(screen.queryByTestId("restore-snapshot")).toBeNull();
    expect(screen.getByTestId("restore-confirm").textContent).not.toContain(
      "Won't carry back",
    );
  });

  it("hands over `autonomos rollback` when the daemon isn't supervised", async () => {
    installServer({
      "GET /api/system/version": () => json(UP_TO_DATE),
      "GET /api/system/snapshots": () => json(SNAPSHOTS),
      "POST /api/system/rollback": () =>
        json({ error: "not a service", code: "NOT_SUPERVISED" }, 409),
    });
    await requestRestore();
    fireEvent.click(await screen.findByTestId("restore-confirm-button"));
    expect((await screen.findByTestId("update-command")).textContent).toBe(
      "autonomos rollback",
    );
  });
});
