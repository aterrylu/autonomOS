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
 * (ADR-105). The pill reads the server's cached update-check answer off
 * /api/system/version and renders only when an update is known; clicking it
 * opens ONE decision screen (notes + a live agent check + the buttons), then
 * follows the server-side job through the restart gap on the same surface.
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

/** Click the pill: the decision screen opens and starts its agent check. */
async function openDialog() {
  fireEvent.click(await renderPill());
}

/** The Update button stays disabled until the agent check has answered —
 *  never offer a restart before knowing who it would interrupt. */
async function startButton(): Promise<HTMLElement> {
  // Re-query each time: when the check lands the button can be a different
  // element ("Update and restart" → "Update when idle").
  let btn: HTMLElement | null = null;
  await waitFor(() => {
    btn = screen.getByTestId("update-start");
    expect(btn).not.toBeDisabled();
  });
  return btn as unknown as HTMLElement;
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
  it("renders one 'Update to vX' pill and never calls anywhere but /api/system", async () => {
    installServer();
    const badge = await renderPill();
    expect(badge.textContent).toBe("Update to v0.7.0");
    expect(badge.getAttribute("title")).toContain("You're on v0.6.1");
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

describe("UpdateBadgeStatusBarItem — the decision screen", () => {
  it("clicking the pill opens 'Update autonomOS to vX' (not GitHub), named by its heading", async () => {
    installServer();
    fireEvent.click(await renderPill());
    const dialog = await screen.findByRole("dialog");
    expect(
      screen.getByRole("heading", { name: "Update autonomOS to v0.7.0" }),
    ).toBeInTheDocument();
    expect(dialog.getAttribute("aria-labelledby")).toBe("update-dialog-title");
    expect(screen.getByTestId("update-subtitle").textContent).toContain(
      "You're on v0.6.1",
    );
    const gh = await screen.findByTestId("update-github-link");
    expect(gh.getAttribute("href")).toBe(VERSION.releaseUrl);
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(gh.textContent).toContain("Full release notes");
    // No "Next": the decision and its button are on this first screen.
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    expect((await startButton()).textContent).toBe("Update and restart");
  });

  it("never offers the restart before the agent check has answered", async () => {
    let answer: (r: Response) => void = () => {};
    installServer({
      "GET /api/system/upgrade": () =>
        new Promise<Response>((r) => {
          answer = r;
        }),
    });
    await openDialog();
    const agents = await screen.findByTestId("update-agents");
    expect(agents.getAttribute("data-state")).toBe("checking");
    expect(screen.getByTestId("update-start")).toBeDisabled();
    await act(async () => answer(json(IDLE_UPGRADE)));
    expect((await startButton()).textContent).toBe("Update and restart");
  });

  it("idle agents: one live line (plural-correct) with the per-agent table behind Details", async () => {
    useStore.setState({
      sessions: [session("a", "idle-ivy")],
      agentStatuses: { a: { status: "idle" } },
    });
    installServer();
    await openDialog();
    const agents = await screen.findByTestId("update-agents");
    await waitFor(() =>
      expect(agents.getAttribute("data-state")).toBe("clear"),
    );
    expect(agents.textContent).toContain("idle-ivy is idle.");
    expect(agents.textContent).toContain(
      "It restarts with autonomOS and picks up where it left off.",
    );
    expect(agents.textContent).not.toContain("All 1");
    expect(agents.querySelector("details")).not.toBeNull();
  });

  it("the three safety facts show in the busy case too (they used to vanish there)", async () => {
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [{ id: "a", name: "api-refactor", status: "working" }],
        }),
    });
    await openDialog();
    await screen.findByTestId("update-now-interrupt");
    const safety = screen.getByTestId("update-safety");
    expect(safety.textContent).toContain("Under a minute.");
    expect(safety.textContent).toContain("is saved first");
    expect(safety.textContent).toContain("restores v0.6.1 on its own");
    expect(safety.textContent).toContain("You stay signed in");
  });

  it("release-note links stay keyboard-reachable, in the theme's link color; the box is a focusable region", async () => {
    installServer({
      "GET /api/system/releases": () =>
        json({
          current: "0.6.1",
          latest: "0.7.0",
          updateAvailable: true,
          releaseUrl: VERSION.releaseUrl,
          releases: [
            {
              version: "0.7.0",
              name: "v0.7.0",
              body: "- [#1](https://example.com/1) one\n- [#2](https://example.com/2) two",
              url: null,
              publishedAt: null,
            },
          ],
        }),
    });
    await openDialog();
    const box = await screen.findByTestId("update-notes");
    await waitFor(() => expect(box.querySelectorAll("a").length).toBe(2));
    // Mouse-only links fail WCAG 2.1.1 (the a11y re-review caught it).
    expect(
      [...box.querySelectorAll("a")].some(
        (a) => a.getAttribute("tabindex") === "-1",
      ),
    ).toBe(false);
    expect(box.style.getPropertyValue("--notes-link")).not.toBe("");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("aria-label")).toBe("Release notes");
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
      "Breaking change in v0.7.0",
    );
    // It QUOTES the change instead of pointing into the notes.
    expect(screen.getByTestId("breaking-quote").textContent).toBe(
      "Old routes 404.",
    );
    expect(screen.getByTestId("breaking-callout").textContent).toContain(
      "Check whether your own scripts or integrations rely on it.",
    );
    // The newest release is open; older ones fold.
    const [newest, ...older] = screen.getAllByTestId("release-section");
    expect(newest.tagName).toBe("SECTION");
    for (const o of older) expect(o.tagName).toBe("DETAILS");
  });

  it("falls back to a GitHub link when notes are unavailable, and never blocks the update", async () => {
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
    expect((await startButton()).textContent).toBe("Update and restart");
  });
});

describe("UpdateBadgeStatusBarItem — busy agents and waiting for idle", () => {
  it("lists every agent, leads with 'Update when idle', names who 'Update now' interrupts, and arms into the waiting view", async () => {
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
    await openDialog();
    const agents = await screen.findByTestId("update-agents");
    await waitFor(() => expect(agents.getAttribute("data-state")).toBe("busy"));
    expect(agents.textContent).toContain("3 agents are mid-task.");

    const rows = screen.getAllByTestId("update-agent-row");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-busy"))).toEqual([
      "true",
      "true",
      "true",
      "false",
    ]);
    expect(rows[0].textContent).toContain(
      "Its current task stops. Prompt it to continue.",
    );
    expect(rows[1].textContent).toContain(
      "Its running command stops. Prompt it to continue.",
    );
    expect(rows[2].textContent).toContain("Its question to you is cleared.");
    expect(rows[3].textContent).toContain(
      "Restarts and picks up where it left off.",
    );

    // Terry's default is the primary: wait for idle. "Update now" is the
    // secondary and says who it interrupts.
    expect((await startButton()).textContent).toBe("Update when idle");
    expect(screen.getByTestId("update-now-interrupt").textContent).toBe(
      "Update now · interrupts 3 agents",
    );

    fireEvent.click(screen.getByTestId("update-start"));
    const armed = await screen.findByTestId("update-badge-armed");
    // The version whose notes were shown rides along (R11).
    expect(posted).toEqual({ when: "idle", expectedVersion: "0.7.0" });
    // The dialog stays, now as the waiting view (it used to just vanish).
    expect(await screen.findByTestId("update-waiting")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Update to v0.7.0 is waiting for 3 agents",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/idle for 30 seconds/)).toBeInTheDocument();
    expect(armed.textContent).toContain("Update waits for 3 agents");
    // No one-click "Update now" on the pill: it would interrupt without
    // saying who. The waiting view has it, with the name.
    expect(armed.textContent).not.toContain("Update now");
    expect(screen.getByTestId("update-armed-cancel").textContent).toBe(
      "Cancel",
    );
  });

  it("the amber pill reopens the waiting view; Cancel update there disarms and closes", async () => {
    const armedRec = {
      target: "0.7.0",
      armedAt: "2026-09-23T10:00:00Z",
      idleSince: null,
    };
    let armed = false;
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [{ id: "a", name: "busy-bee", status: "tool_running" }],
          armed: armed ? armedRec : null,
        }),
      "POST /api/system/upgrade": () => {
        armed = true;
        return json({ ok: true, armed: armedRec });
      },
      "DELETE /api/system/upgrade": () => {
        armed = false;
        return json({ ok: true });
      },
    });
    await openDialog();
    fireEvent.click(await startButton());
    await screen.findByTestId("update-waiting");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(await screen.findByTestId("update-armed-open"));
    expect(
      await screen.findByRole("heading", {
        name: "Update to v0.7.0 is waiting for busy-bee",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-waiting-now").textContent).toBe(
      "Update now · interrupts busy-bee",
    );
    fireEvent.click(screen.getByTestId("update-cancel-armed"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByTestId("update-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("update-badge-armed")).toBeNull();
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
    await openDialog();
    fireEvent.click(await startButton());
    const armed = await screen.findByTestId("update-badge-armed");
    await waitFor(() =>
      expect(armed.textContent).toContain("Update waits for api-refactor"),
    );

    phase = "idle";
    await waitFor(() =>
      expect(screen.getByTestId("update-badge-armed").textContent).toContain(
        "Updating in a moment",
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
    await openDialog();
    fireEvent.click(await startButton());
    expect(
      await screen.findByText(/stopped responding \(last step: Starting\)/),
    ).toBeInTheDocument();
  });

  it("shows the terminal instructions when the daemon isn't supervised", async () => {
    installServer({
      "GET /api/system/upgrade": () =>
        json({ ...IDLE_UPGRADE, supervised: false }),
    });
    await openDialog();
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
    await openDialog();
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
    await openDialog();
    fireEvent.click(await startButton());
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
    await waitFor(() =>
      expect(posted).toEqual({ when: "now", expectedVersion: "0.7.0" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Updating to v0.7.0" }),
    ).toBeInTheDocument();
    // Three honest stages; the fine-grained list is behind "Show details".
    const stages = screen.getByTestId("update-stages");
    expect(
      stages.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("Preparing");
    await waitFor(() =>
      expect(stages.textContent).toContain("Downloading v0.7.0"),
    );
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

  it("the restart overlay stays up through the new version's health check, then reloads", async () => {
    installServer();
    let phase = "downloading";
    let daemonUp = true;
    let serving = "0.6.1";
    routes["GET /api/system/upgrade"] = () => {
      if (!daemonUp) throw new TypeError("Failed to fetch");
      return json({
        ...IDLE_UPGRADE,
        current: serving,
        status: posted ? record(phase) : null,
        inFlight: posted && phase !== "done",
      });
    };
    routes["GET /api/system/version"] = () =>
      daemonUp
        ? json({ ...VERSION, version: serving })
        : Promise.reject(new TypeError("Failed to fetch"));
    await launch();
    await screen.findByRole("heading", { name: "Updating to v0.7.0" });

    phase = "restarting";
    daemonUp = false;
    const overlay = await screen.findByTestId("update-reconnecting");
    // The NEW daemon answers but hasn't passed its health check yet: this
    // used to drop the overlay and leave "Health check" spinning behind it.
    serving = "0.7.0";
    phase = "health_check";
    daemonUp = true;
    await waitFor(() =>
      expect(overlay.textContent).toContain("Making sure v0.7.0 started"),
    );
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(screen.getByTestId("update-reconnecting")).toBeInTheDocument();
    expect(
      overlay.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("Restarting");
    expect(reload).not.toHaveBeenCalled();

    phase = "done";
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("a failure before anything changed says so — not 'may be on either version'", async () => {
    installServer();
    routes["GET /api/system/upgrade"] = () =>
      json({
        ...IDLE_UPGRADE,
        // The job clears snapshotId when it failed before touching anything.
        status: posted
          ? record(
              "failed",
              "busy-bee stayed busy for 15 minutes, so nothing was changed.",
            )
          : null,
      });
    await launch();
    expect(
      await screen.findByRole("heading", { name: "v0.7.0 wasn't installed" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-failed-summary").textContent).toBe(
      "Nothing changed. You're still on v0.6.1.",
    );
  });

  it("a failure after the swap keeps the honest 'either version' warning", async () => {
    installServer();
    routes["GET /api/system/upgrade"] = () =>
      json({
        ...IDLE_UPGRADE,
        status: posted
          ? record(
              "failed",
              "The update installed but the service restart could not be issued — run `autonomos restart`.",
              { snapshotId: "0.6.1-x" },
            )
          : null,
      });
    await launch();
    expect(
      await screen.findByRole("heading", {
        name: "The update to v0.7.0 didn't finish",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-failed-summary").textContent).toContain(
      "may be on either version",
    );
    // Backticks are for chat, not for this monospace block.
    expect(
      screen.getByTestId("update-failed-message").textContent,
    ).not.toContain("`");
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
    await screen.findByRole("heading", { name: "Updating to v0.7.0" });
    down = true;
    routes["GET /api/system/version"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await screen.findByTestId("update-reconnecting");
    // Back up — but the new daemon rejects this browser's cookie.
    routes["GET /api/system/version"] = () =>
      json({ error: "Unauthorized" }, 401);
    expect(
      await screen.findByRole("heading", { name: "Sign in again" }),
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
    await screen.findByRole("heading", { name: "Updating to v0.7.0" });
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

describe("UpdateBadgeStatusBarItem — snapshots (ADR-105 amendment)", () => {
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
    expect(callout.textContent).toContain("won't carry over");
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

  it("the safety line names what the snapshot holds and the automatic restore", async () => {
    installServer();
    await openDialog();
    const safety = await screen.findByTestId("update-safety");
    expect(safety.textContent).toContain(
      "A snapshot of your agents, schedules, templates, presets and settings is saved first.",
    );
    expect(safety.textContent).toContain(
      "If v0.7.0 doesn't start, autonomOS restores v0.6.1 on its own.",
    );
  });

  it("the detailed steps show the snapshot (with its id) right before Install, and end with the agent check", async () => {
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
    await openDialog();
    fireEvent.click(await startButton());
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
    expect(ids.indexOf("snapshot")).toBe(ids.indexOf("install") - 1);
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
    await openDialog();
    fireEvent.click(await startButton());
    expect(
      (await screen.findByTestId("update-failed-summary")).textContent,
    ).toContain("autonomOS restored v0.6.1 and the snapshot from just before");
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
      screen.getByRole("heading", { name: "Restore v0.6.1?" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("restore-snapshot").textContent).toContain(
      "214 KB",
    );
    expect(confirm.textContent).toContain("snapshots/0.6.1-2026-09-24T0712/");
    expect(confirm.textContent).toContain("Changes since the update");
    expect(confirm.textContent).toContain("Not affected");
    expect(confirm.textContent).toContain("autonomos rollback");

    fireEvent.click(screen.getByTestId("restore-confirm-button"));
    expect(
      await screen.findByRole("heading", { name: "Restoring v0.6.1" }),
    ).toBeInTheDocument();
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
      "v0.6.0 predates snapshots, so only the version is restored. Your agents, schedules, templates, presets and settings stay as they are.",
    );
    // No snapshot rows claimed.
    expect(screen.queryByTestId("restore-snapshot")).toBeNull();
    expect(screen.getByTestId("restore-confirm").textContent).not.toContain(
      "Changes since the update",
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

describe("UpdateBadgeStatusBarItem — race & warning campaign (ADR-105)", () => {
  it("warns about background work an idle-looking agent would lose (never blocks)", async () => {
    useStore.setState({ sessions: [session("a", "api-refactor")] });
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          background: [
            {
              id: "a",
              name: "api-refactor",
              processes: [{ pid: 42, command: "npm run dev" }],
            },
          ],
        }),
    });
    await openDialog();
    const warn = await screen.findByTestId("update-background-warning");
    expect(warn.textContent).toContain(
      "api-refactor: Stops 1 background process: npm run dev",
    );
    // Warn-only: the update stays one click away.
    expect((await startButton()).textContent).toBe("Update and restart");
  });

  it("an agent whose first task hasn't started reads 'Starting' and counts as mid-task", async () => {
    useStore.setState({
      sessions: [session("a", "new-worker")],
      agentStatuses: { a: { status: "ready" } },
    });
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [
            {
              id: "a",
              name: "new-worker",
              status: "ready",
              reason: "first_task",
            },
          ],
        }),
    });
    await openDialog();
    const agents = await screen.findByTestId("update-agents");
    // A first task isn't "mid-task": say what it is.
    await waitFor(() =>
      expect(agents.textContent).toContain("new-worker is starting."),
    );
    const row = screen.getAllByTestId("update-agent-row")[0];
    expect(row.textContent).toContain("Starting");
    expect(row.textContent).toContain("Its first prompt is lost.");
  });

  it("R4: a cancel that lost the race to the launch follows the running update", async () => {
    useStore.setState({ sessions: [session("a", "api-refactor")] });
    let armedPosted = false;
    let launched = false;
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          // The poll never reveals the launch (it lags the DELETE): only the
          // 409 LAUNCHED answer itself can move the tab to the progress view.
          busy: [{ id: "a", name: "api-refactor", status: "working" }],
          armed: !armedPosted
            ? null
            : {
                target: "0.7.0",
                armedAt: "2026-09-23T10:00:00Z",
                idleSince: null,
              },
          status: null,
        }),
      "POST /api/system/upgrade": () => {
        armedPosted = true;
        return json({
          ok: true,
          armed: {
            target: "0.7.0",
            armedAt: "2026-09-23T10:00:00Z",
            idleSince: null,
          },
        });
      },
      "DELETE /api/system/upgrade": () => {
        launched = true; // the idle tick won the race
        return json(
          {
            error: "The update already started and can't be cancelled.",
            code: "LAUNCHED",
          },
          409,
        );
      },
    });
    await openDialog();
    fireEvent.click(await startButton());
    fireEvent.click(await screen.findByTestId("update-armed-cancel"));
    expect(await screen.findByTestId("update-steps")).toBeInTheDocument();
    expect(launched).toBe(true);
    expect(screen.queryByText(/Couldn't cancel/)).toBeNull();
  });

  it("R11: a newer release mid-flow re-shows the decision screen for it, says why, and asks for the NEW version", async () => {
    const bodies: unknown[] = [];
    let latest = "0.7.0";
    installServer({
      "GET /api/system/version": () => json({ ...VERSION, latest }),
      "POST /api/system/upgrade": (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        latest = "0.7.1";
        return json(
          {
            error:
              "A newer release (v0.7.1) appeared since you opened this. Review its notes first.",
            code: "VERSION_CHANGED",
            latest: "0.7.1",
          },
          409,
        );
      },
    });
    await openDialog();
    fireEvent.click(await startButton());
    expect(
      await screen.findByText(/A newer release \(v0\.7\.1\) appeared/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: "Update autonomOS to v0.7.1",
      }),
    ).toBeInTheDocument();
    fireEvent.click(await startButton());
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ expectedVersion: "0.7.1" });
  });

  it("R9: the server's inFlight wins over a browser clock that thinks the run is stale", async () => {
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
                phase: "building",
                from: "0.6.1",
                to: "0.7.0",
                startedAt: "2026-09-23T10:00:00.000Z",
                // 20 minutes old by the browser's (skewed) clock…
                updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
              }
            : null,
          inFlight: posted, // …but the server, which wrote it, says live.
        }),
    });
    await openDialog();
    fireEvent.click(await startButton());
    expect(await screen.findByTestId("update-steps")).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(screen.queryByText(/stopped reporting/)).toBeNull();
  });
});

describe("UpdateBadgeStatusBarItem — keyboard and screen reader", () => {
  let appRoot: HTMLDivElement;
  beforeEach(() => {
    appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
  });
  afterEach(() => appRoot.remove());

  it("makes the app behind inert while open, and gives it back on close", async () => {
    installServer();
    expect(appRoot.hasAttribute("inert")).toBe(false);
    await openDialog();
    await screen.findByRole("dialog");
    expect(appRoot.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(appRoot.hasAttribute("inert")).toBe(false);
  });

  it("lands focus on the heading on open and on every screen change — never on <body>", async () => {
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [{ id: "a", name: "busy-bee", status: "working" }],
        }),
      "POST /api/system/upgrade": () =>
        json({
          ok: true,
          armed: {
            target: "0.7.0",
            armedAt: "2026-09-23T10:00:00Z",
            idleSince: null,
          },
        }),
    });
    await openDialog();
    const h1 = await screen.findByRole("heading", {
      name: "Update autonomOS to v0.7.0",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    fireEvent.click(await startButton());
    const h2 = await screen.findByRole("heading", {
      name: "Update to v0.7.0 is waiting for busy-bee",
    });
    await waitFor(() => expect(document.activeElement).toBe(h2));
  });

  it("Tab wraps inside the dialog in both directions", async () => {
    installServer();
    await openDialog();
    const dialog = await screen.findByRole("dialog");
    const last = await startButton();
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    const first = document.activeElement as HTMLElement;
    expect(first).not.toBe(last);
    expect(dialog.contains(first)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("cancelling from the pill lands focus on the new pill (never <body>) and says so", async () => {
    const armedRec = {
      target: "0.7.0",
      armedAt: "2026-09-23T10:00:00Z",
      idleSince: null,
    };
    let armed = true;
    installServer({
      "GET /api/system/upgrade": () =>
        json({
          ...IDLE_UPGRADE,
          busy: [{ id: "a", name: "busy-bee", status: "working" }],
          armed: armed ? armedRec : null,
        }),
      "DELETE /api/system/upgrade": () => {
        armed = false;
        return json({ ok: true });
      },
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />, { container: appRoot });
    });
    fireEvent.click(await screen.findByTestId("update-armed-open"));
    await screen.findByTestId("update-waiting");
    fireEvent.click(screen.getByTestId("update-cancel-armed"));
    const pill = await screen.findByTestId("update-badge");
    await waitFor(() => expect(document.activeElement).toBe(pill));
    expect(document.body.textContent).toContain(
      "Scheduled update cancelled. Update to v0.7.0 is still available.",
    );
  });

  it("while the restart overlay is up, the dialog underneath is gone (one modal at a time)", async () => {
    installServer();
    let down = false;
    routes["POST /api/system/upgrade"] = () =>
      json({ ok: true, launched: true });
    routes["GET /api/system/upgrade"] = () => {
      if (down) throw new TypeError("Failed to fetch");
      return json({ ...IDLE_UPGRADE, status: null });
    };
    await openDialog();
    fireEvent.click(await startButton());
    await screen.findByRole("heading", { name: "Updating to v0.7.0" });
    down = true;
    routes["GET /api/system/version"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await screen.findByTestId("update-reconnecting");
    expect(screen.queryByTestId("update-dialog")).toBeNull();
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  });

  it("announces the agent check politely", async () => {
    installServer();
    await openDialog();
    const dialog = await screen.findByRole("dialog");
    const live = dialog.querySelector('output[aria-live="polite"]');
    await waitFor(() =>
      expect(live?.textContent).toBe(
        "No agents running. Nothing to interrupt.",
      ),
    );
  });
});
