// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { Sidebar } from "./Sidebar";

// The forge report: two DIFFERENT dirs, both named "work", listed as two
// identical "work" rows. The list must label them apart.
const PROJECTS = [
  { path: "/tmp/aq/work", name: "work", sessions: [], lastActive: 2 },
  { path: "/tmp/ax/work", name: "work", sessions: [], lastActive: 1 },
  { path: "/Users/t/app", name: "app", sessions: [], lastActive: 0 },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      const body = u.includes("/api/projects") ? PROJECTS : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions: [],
    exitedSessions: [],
    projects: PROJECTS as never,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({ projects: [] });
});

describe("Sidebar Projects — same-named dirs are labelled apart", () => {
  it("renders 'aq/work' and 'ax/work' (never two 'work' rows), leaves unique names bare", () => {
    render(<Sidebar />);
    expect(screen.getByText("aq/work")).toBeTruthy();
    expect(screen.getByText("ax/work")).toBeTruthy();
    expect(screen.queryByText("work")).toBeNull();
    expect(screen.getByText("app")).toBeTruthy();
  });

  it("the full path is the row's tooltip, and the quick-spawn names the right one", () => {
    render(<Sidebar />);
    expect(screen.getByText("aq/work").getAttribute("title")).toBe(
      "/tmp/aq/work",
    );
    expect(screen.getByLabelText("New session in ax/work")).toBeTruthy();
  });
});
