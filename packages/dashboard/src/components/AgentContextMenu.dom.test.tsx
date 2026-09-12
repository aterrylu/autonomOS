// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { hasEscapeCloser } from "../shortcuts/escapeStack";
import { THEMES, useStore } from "../store";
import { AgentContextMenu, type AgentMenuTarget } from "./AgentContextMenu";

// focusTerminal reaches into the live-terminal registry (RAF/DOM); stub it so
// the "Open" action can be exercised in jsdom without touching real terminals.
vi.mock("../hooks/useTerminal", () => ({ focusTerminal: vi.fn() }));

const page = Object.values(THEMES)[0].page;

const RUNNING: AgentMenuTarget = {
  id: "agent-1",
  name: "TeamLead",
  status: "running",
  manager: undefined,
  workingDirectory: "/repo",
};
const EXITED: AgentMenuTarget = {
  id: "agent-2",
  name: "gemini-test",
  status: "exited",
  resumeKey: "cc-sess-2",
  workingDirectory: "/repo",
  isAutonomosAgent: true,
};

function seedStore() {
  useStore.setState({
    sessions: [
      { id: "agent-1", name: "TeamLead" },
      { id: "mgr-a", name: "Alpha" },
      { id: "mgr-b", name: "Beta" },
      // biome-ignore lint/suspicious/noExplicitAny: partial SessionInfo for test
    ] as any,
    exitedSessions: [],
    switchPane: vi.fn(),
    killSession: vi.fn(),
    restartSession: vi.fn(),
    renameSession: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    setManager: vi.fn().mockResolvedValue(undefined),
    // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
  } as any);
}

function renderMenu(target: AgentMenuTarget, onClose = vi.fn()) {
  render(
    <AgentContextMenu
      target={target}
      x={100}
      y={100}
      page={page}
      onClose={onClose}
    />,
  );
  return { onClose };
}

beforeEach(seedStore);
afterEach(() => vi.clearAllMocks());

describe("AgentContextMenu — item sets per status", () => {
  // Accessible names exclude the aria-hidden icon glyph, so query by name.
  it("running target shows Open, Rename…, Restart, Kill, Set manager, Delete…", () => {
    renderMenu(RUNNING);
    const menu = within(screen.getByRole("menu"));
    for (const name of [
      "Open",
      "Rename…",
      "Restart",
      "Kill",
      "Set manager",
      "Delete…",
    ]) {
      expect(menu.getByRole("menuitem", { name })).toBeTruthy();
    }
    // No Resume in the running menu.
    expect(menu.queryByRole("menuitem", { name: "Resume" })).toBeNull();
  });

  it("exited target shows Resume + Set manager + Delete, no Kill/Restart", () => {
    renderMenu(EXITED);
    const menu = within(screen.getByRole("menu"));
    for (const name of ["Resume", "Set manager", "Delete…"]) {
      expect(menu.getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(menu.queryByRole("menuitem", { name: "Kill" })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: "Restart" })).toBeNull();
    // Rename is running-only (it restarts under the new name) — resume first.
    expect(menu.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
  });

  it("exited target WITHOUT an agent record is Resume-only (no delete/set-manager)", () => {
    renderMenu({
      name: "external-session",
      status: "exited",
      resumeKey: "cc-x",
      workingDirectory: "/repo",
    });
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Resume" })).toBeTruthy();
    expect(menu.queryByRole("menuitem", { name: "Delete…" })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: "Set manager" })).toBeNull();
  });
});

describe("AgentContextMenu — never-wrap invariant", () => {
  it("every item label is white-space:nowrap and the menu has a min-width", () => {
    renderMenu(RUNNING);
    const menu = screen.getByRole("menu");
    // The menu reserves a minimum width so short menus aren't cramped…
    expect(menu.style.minWidth).toBe("194px");
    // …and NO label may wrap — the layout invariant Terry called out.
    for (const item of within(menu).getAllByRole("menuitem")) {
      const label = item.querySelector("span:nth-child(2)") as HTMLElement;
      expect(label.style.whiteSpace).toBe("nowrap");
    }
  });
});

describe("AgentContextMenu — dismissal", () => {
  it("registers an escape-stack closer while open and clears it on unmount", () => {
    const { unmount } = render(
      <AgentContextMenu
        target={RUNNING}
        x={1}
        y={1}
        page={page}
        onClose={vi.fn()}
      />,
    );
    expect(hasEscapeCloser()).toBe(true);
    unmount();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("Escape key closes", () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pointerdown outside the menu closes; inside does not", () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("AgentContextMenu — actions wire to the store", () => {
  it("Kill calls killSession with the agent id and closes", () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Kill" }));
    expect(useStore.getState().killSession).toHaveBeenCalledWith("agent-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("Restart calls restartSession", () => {
    renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart" }));
    expect(useStore.getState().restartSession).toHaveBeenCalledWith("agent-1");
  });

  it("Open switches to the pane", () => {
    renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "agent-1",
    });
  });

  it("Resume resumes the exited session by its resume key", () => {
    renderMenu(EXITED);
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
    expect(useStore.getState().resumeSession).toHaveBeenCalledWith(
      "cc-sess-2",
      "/repo",
      "gemini-test",
      { isAutonomosAgent: true },
    );
  });
});

describe("AgentContextMenu — inline delete confirm", () => {
  it("Delete… swaps to an inline confirm; Delete removes, Cancel aborts", async () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    // Swapped in-place — the permanence warning appears at decision time.
    expect(screen.getByText("Delete permanently?")).toBeTruthy();
    // Cancel returns to the menu without deleting.
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    expect(useStore.getState().removeSession).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeTruthy();
    // Re-open and confirm — the delete awaits, then closes on success.
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(useStore.getState().removeSession).toHaveBeenCalledWith("agent-1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the confirm open and shows the reason when delete FAILS", async () => {
    // removeSession rethrows the typed ApiError; the menu must not close.
    useStore.setState({
      removeSession: vi.fn().mockRejectedValue(new Error("record is locked")),
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await screen.findByText("Delete failed: record is locked");
    expect(onClose).not.toHaveBeenCalled();
    // The confirm stays open so the user can retry or cancel.
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
});

describe("AgentContextMenu — inline rename", () => {
  it("Rename… opens a pre-filled input + restart warning; submit renames and closes", async () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    // Menu body swaps to the rename form — the restart warning shows at decision time.
    expect(
      screen.getByText(
        "Renaming restarts this session — the conversation resumes.",
      ),
    ).toBeTruthy();
    const input = screen.getByLabelText("New agent name") as HTMLInputElement;
    // Pre-filled with the current name so the user edits rather than retypes.
    expect(input.value).toBe("TeamLead");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(useStore.getState().renameSession).toHaveBeenCalledWith(
      "agent-1",
      "Renamed",
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Cancel returns to the menu without renaming", () => {
    renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useStore.getState().renameSession).not.toHaveBeenCalled();
    // Back to the normal menu.
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
  });

  it("an empty or UNCHANGED name is a no-op (never a bare restart)", () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    // Submit the pre-filled (unchanged) name → cancels, no rename/restart.
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(useStore.getState().renameSession).not.toHaveBeenCalled();
    // Now blank it and submit → still a no-op.
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByLabelText("New agent name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(useStore.getState().renameSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the form open and shows the reason when rename FAILS", async () => {
    // renameSession rethrows the namesake 409 / stale error BEFORE any teardown.
    useStore.setState({
      renameSession: vi
        .fn()
        .mockRejectedValue(
          new Error('An active agent named "Renamed" is already running.'),
        ),
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByLabelText("New agent name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByText(
      'Rename failed: An active agent named "Renamed" is already running.',
    );
    expect(onClose).not.toHaveBeenCalled();
    // The form stays open so the user can fix the name and retry.
    expect(screen.getByLabelText("New agent name")).toBeTruthy();
  });
});

describe("AgentContextMenu — set-manager submenu", () => {
  it("opens a flyout on click and reparents by manager id on pick", () => {
    renderMenu(RUNNING);
    // No flyout until Set manager is opened.
    expect(screen.queryByRole("menuitem", { name: "Beta" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    // Candidates exclude self (TeamLead), include the others.
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "TeamLead" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Beta" }));
    // Set by the candidate's id (exact), not its name.
    expect(useStore.getState().setManager).toHaveBeenCalledWith(
      "agent-1",
      "mgr-b",
    );
  });

  it("click-open moves keyboard focus into the flyout", () => {
    renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    const flyout = screen.getByRole("menu", { name: /Set manager for/ });
    expect(flyout.contains(document.activeElement)).toBe(true);
  });

  it("surfaces the reason and stays open when a pick fails", async () => {
    useStore.setState({
      setManager: vi
        .fn()
        .mockRejectedValue(
          new Error("Cycle: proposed manager is a descendant"),
        ),
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Beta" }));
    await screen.findByText(/Couldn't set manager: Cycle/);
    expect(onClose).not.toHaveBeenCalled();
    // Flyout stays open for another try.
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeTruthy();
  });

  it("Escape peels the submenu before the menu (LIFO)", () => {
    const { onClose } = renderMenu(RUNNING);
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    const flyout = screen.getByRole("menu", { name: /Set manager for/ });
    fireEvent.keyDown(flyout, { key: "Escape" });
    // Submenu closed, but the parent menu stays open.
    expect(screen.queryByRole("menuitem", { name: "Beta" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Set manager" })).toBeTruthy();
  });

  it("marks the current manager and can open via ArrowRight/Enter", () => {
    renderMenu({ ...RUNNING, manager: "Alpha" });
    const smItem = screen.getByRole("menuitem", { name: "Set manager" });
    fireEvent.keyDown(smItem, { key: "ArrowRight" });
    // The current manager row carries a check (✓) in its accessible name.
    expect(screen.getByRole("menuitem", { name: /Alpha/ })).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("excludes the target's descendants from candidates (no cycles)", () => {
    useStore.setState({
      sessions: [
        { id: "agent-1", name: "TeamLead" },
        { id: "mgr-a", name: "Alpha" },
        { id: "child", name: "Child", manager: "TeamLead" },
        { id: "grand", name: "Grand", manager: "Child" },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: partial SessionInfo for test
    } as any);
    renderMenu(RUNNING); // target = TeamLead
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    // A non-descendant is a valid manager…
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeTruthy();
    // …but the target's direct report and grandchild would form a cycle.
    expect(screen.queryByRole("menuitem", { name: "Child" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Grand" })).toBeNull();
  });

  it("excludes a descendant reached through an EXITED intermediary", () => {
    // TeamLead → E (exited, mgr=TeamLead) → R (running, mgr=E). A live-only walk
    // misses E, offers R, and the pick 409s. The walk must see exited records.
    useStore.setState({
      sessions: [
        { id: "agent-1", name: "TeamLead" },
        { id: "mgr-a", name: "Alpha" },
        { id: "r", name: "R", manager: "E" },
      ],
      exitedSessions: [{ id: "e", name: "E", manager: "TeamLead" }],
      // biome-ignore lint/suspicious/noExplicitAny: partial SessionInfo for test
    } as any);
    renderMenu(RUNNING); // target = TeamLead
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "R" })).toBeNull();
  });

  it("Clear manager clears when a manager is set", () => {
    renderMenu({ ...RUNNING, manager: "Beta" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Set manager" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear manager" }));
    expect(useStore.getState().setManager).toHaveBeenCalledWith(
      "agent-1",
      null,
    );
  });
});
