// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/** A child that throws on render, to drive the boundary's catch path. */
function Boom(): React.ReactElement {
  throw new Error("boom");
}

const RESET_MARKER = "autonomos:layoutResetAt";

/** Minimal Map-backed Storage — jsdom's built-in localStorage in this setup is
 *  missing methods, so we stub a hermetic one instead of depending on the env. */
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("ErrorBoundary", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
    reload = vi.fn();
    // location.reload is non-configurable in jsdom (can't redefine it directly)
    // AND calling the real one throws "navigation not implemented" — an
    // unhandled error vitest may treat as a run failure. Spy the location GETTER
    // to return a stub whose reload is a no-op we can assert on.
    vi.spyOn(window, "location", "get").mockReturnValue({
      reload,
    } as unknown as Location);
    // React logs caught boundary errors to console.error — silence the noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("shows the tier-1 recovery screen on a crash (not a blank tree)", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The dashboard hit an error")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reset layout & reload" }),
    ).toBeTruthy();
  });

  it("tier-1 reset drops layout keys, keeps other prefs, stamps a marker, reloads", () => {
    localStorage.setItem(
      "autonomos",
      JSON.stringify({
        state: {
          theme: "void",
          dvWorkspaces: { w1: { paneIds: ["a"], serialized: {} } },
          dvPaneWorkspace: { a: "w1" },
          activePane: { type: "session", id: "a" },
        },
        version: 0,
      }),
    );

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset layout & reload" }),
    );

    const saved = JSON.parse(localStorage.getItem("autonomos") as string);
    expect(saved.state.theme).toBe("void"); // non-layout pref preserved
    expect(saved.state.dvWorkspaces).toBeUndefined();
    expect(saved.state.dvPaneWorkspace).toBeUndefined();
    expect(saved.state.activePane).toBeUndefined();
    expect(sessionStorage.getItem(RESET_MARKER)).toBeTruthy(); // loop marker set
    expect(reload).toHaveBeenCalledOnce();
  });

  it("escalates to a full wipe when a reset already just failed", () => {
    sessionStorage.setItem(RESET_MARKER, String(Date.now())); // reset just happened
    localStorage.setItem(
      "autonomos",
      JSON.stringify({ state: { theme: "void" } }),
    );

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // Escalated copy + second-tier action, not the layout-reset screen.
    expect(screen.getByText("Resetting the layout didn't fix it")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear all saved data & reload" }),
    );

    expect(localStorage.getItem("autonomos")).toBeNull(); // everything wiped
    expect(reload).toHaveBeenCalledOnce();
  });

  it("treats a STALE reset marker as first-time (no false escalation)", () => {
    // Marker older than the 10s window → the last crash is unrelated to a reset.
    sessionStorage.setItem(RESET_MARKER, String(Date.now() - 60_000));
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The dashboard hit an error")).toBeTruthy();
  });
});
