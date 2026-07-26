// @vitest-environment jsdom
import { render } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import type { ActivePane } from "../../store";
import { PaneContent, type PaneParams } from "./PaneContent";

/**
 * PaneContent — the retired-pane-type guard.
 *
 * `isValidActivePane` guards `activePane` on rehydrate, but it is not the only
 * carrier of a pane descriptor: dockview's `toJSON()` serializes each panel's
 * `params`, so a descriptor written by an older build survives inside
 * `dvWorkspaces[*].serialized` and is re-created verbatim by `fromJSON` on
 * restore — unvalidated. `{type:"preview"}` (the markdown preview removed in
 * ADR-059) is the concrete case.
 *
 * Before the guard, such a panel fell through PaneContent's `default` to `null`
 * and rendered as an empty body under a tab titled "Tab" — no console output,
 * nothing explaining it. Normally the dead-panel strip in DockviewLayout cleans
 * it up shortly after, but that strip is gated on `sessionsInitialFetchDone`,
 * which never flips while `/api/agents` is failing, making the blank tab
 * permanent for the session.
 *
 * TypeScript cannot protect this path: `"preview"` was deleted from the
 * `ActivePane` union, so the branch looks unreachable to the compiler while
 * being live at runtime against untyped persisted JSON. Hence a runtime test.
 */

/** Minimal stub of the dockview panel API surface PaneContent touches. */
function makeProps(pane: unknown) {
  const close = vi.fn();
  const noopDisposable = { dispose: vi.fn() };
  const api = {
    isVisible: true,
    isGroupActive: true,
    isActive: false,
    close,
    onDidVisibilityChange: vi.fn(() => noopDisposable),
    onDidActiveGroupChange: vi.fn(() => noopDisposable),
    onDidActiveChange: vi.fn(() => noopDisposable),
  };
  return {
    props: {
      api,
      params: { pane: pane as ActivePane },
    } as unknown as IDockviewPanelProps<PaneParams>,
    close,
  };
}

describe("PaneContent — retired pane types", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a panel restored with the removed preview pane type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { props, close } = makeProps({
      type: "preview",
      id: "preview-1750000000000-1",
    });

    render(<PaneContent {...props} />);

    expect(close).toHaveBeenCalledTimes(1);
    // Must name the offending panel + type — this warning is the only signal a
    // user's saved layout referenced a feature that no longer exists.
    const msg = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(msg).toContain("preview-1750000000000-1");
    expect(msg).toContain("preview");
  });

  it("closes a panel carrying an arbitrary unknown pane type", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { props, close } = makeProps({ type: "leaf", id: "x" });
    render(<PaneContent {...props} />);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves a valid session panel mounted and open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { props, close } = makeProps({ type: "session", id: "agent-a" });

    render(<PaneContent {...props} />);

    expect(close).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a valid singleton panel mounted and open", () => {
    const { props, close } = makeProps({ type: "orgchart", id: "orgchart" });
    render(<PaneContent {...props} />);
    expect(close).not.toHaveBeenCalled();
  });
});
