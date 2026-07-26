import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { CreateAgentPanel } from "../../components/CreateAgentPanel";
import { HierarchyPanel } from "../../components/HierarchyPanel";
import { SchedulesPanel } from "../../components/SchedulesPanel";
import { SessionPane } from "../../components/SessionPane";
import { TemplatesPanel } from "../../components/TemplatesPanel";
import type { ActivePane } from "../../store";
import { isValidActivePane } from "./paneId";

/** Params carried on every dockview panel — the autonomOS pane it renders. */
export interface PaneParams {
  pane: ActivePane;
}

/**
 * PaneContent — the single dockview content component (registered under the
 * `"pane"` key). Dispatches on the pane type to the existing panel components,
 * which are reused verbatim from the legacy layer (ADR-047).
 *
 * Visibility: dockview's `defaultRenderer: "always"` keeps every panel's DOM
 * mounted, hiding inactive ones with `visibility:hidden` (NOT `display:none`),
 * so they retain full layout dimensions. We forward dockview's authoritative
 * `props.api.isVisible` into `SessionPane` as `visible`, which
 * toggles `display:none` on the hidden panel. That is load-bearing for the
 * terminal: `useTerminal` infers "is this pane showing?" from a nonzero offset
 * box (`offsetWidth > 0 && offsetHeight > 0`) to dispose the WebGL context +
 * skip fit() when hidden. Without a real `display:none`, hidden panels keep a
 * full-size offset box →
 * the guard never trips → every terminal holds a WebGL context (context-loss
 * storms) and refits while hidden → the idle self-shrink bug.
 */
export function PaneContent(props: IDockviewPanelProps<PaneParams>) {
  const { pane } = props.params;

  // Retired/unknown pane type → close the panel loudly instead of rendering an
  // empty box. This is reachable ONLY from persisted state: dockview's
  // `toJSON()` serializes each panel's `params`, so a pane descriptor written by
  // an older build (e.g. the removed markdown preview's `{type:"preview"}`)
  // survives inside `dvWorkspaces[*].serialized` and is re-created verbatim by
  // `fromJSON` on restore. `activePane` is validated on rehydrate, but
  // `serialized` is not — so this is the second, unvalidated carrier.
  //
  // The dead-panel strip in DockviewLayout can't be relied on here: it's gated
  // on `sessionsInitialFetchDone`, which never flips while `/api/agents` is
  // failing, leaving a permanently blank tab. TypeScript can't help either —
  // the type was deleted from the union, so this branch looks unreachable to the
  // compiler while being live at runtime against untyped JSON. Hence a runtime
  // check at the one boundary every panel path (fromJSON, showSolo, addPanel,
  // drop) funnels through.
  //
  // `pane` is typed non-nullable but arrives from that untrusted JSON, so it can
  // be absent entirely. Render must therefore bail BEFORE touching `pane.type`
  // (render runs before effects — reading it here would throw a TypeError into
  // the ErrorBoundary instead of closing the panel with the warning below).
  const paneIsRenderable = isValidActivePane(pane);
  useEffect(() => {
    if (paneIsRenderable) return;
    const { type, id } = (pane ?? {}) as { type?: unknown; id?: unknown };
    console.warn(
      `[autonomOS] Closing panel "${String(id)}": unknown pane type "${String(type)}" ` +
        `from a saved layout (feature removed in a newer build).`,
    );
    props.api.close();
  }, [paneIsRenderable, pane, props.api]);

  // Track dockview's real visibility for this panel (active tab in a shown
  // group). Forwarded to the content so hidden panes get `display:none`.
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setVisible(props.api.isVisible);
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  // Dim this panel's content when its group is not the focused one. Driven by
  // the panel API (not CSS on the group) because `renderer: "always"` mounts
  // content in a separate overlay layer outside the group element, so a CSS
  // opacity on `.dv-inactive-group` would never reach the terminal (ADR-047).
  // A lone group is always active, so single-pane never dims.
  const [groupActive, setGroupActive] = useState(props.api.isGroupActive);
  useEffect(() => {
    setGroupActive(props.api.isGroupActive);
    const d = props.api.onDidActiveGroupChange((e) =>
      setGroupActive(e.isActive),
    );
    return () => d.dispose();
  }, [props.api]);

  // When this panel becomes active (e.g. its tab is clicked), move keyboard
  // focus off the clicked tab and into the panel content. dockview otherwise
  // leaves focus on the tab, which both blocks typing into terminals and keeps
  // the active-tab styling from settling for ALL pane types. For terminals we
  // focus the xterm input (so the user can type); for other panels we focus the
  // content wrapper (tabIndex -1) — enough to settle dockview's focus state.
  // rAF covers the normal case; the short timeout wins the race when dockview
  // re-focuses the tab just after activating the panel. (ADR-047)
  const fillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusContent = () => {
      if (!props.api.isActive) return;
      const attempt = () => {
        const root = fillRef.current;
        if (!root) return;
        const term = root.querySelector<HTMLTextAreaElement>(
          ".xterm-helper-textarea",
        );
        (term ?? root).focus();
      };
      requestAnimationFrame(attempt);
      setTimeout(attempt, 60);
    };
    focusContent();
    const d = props.api.onDidActiveChange(focusContent);
    return () => d.dispose();
  }, [props.api]);

  // Nothing to render for a pane the switch below can't handle; the effect
  // above closes the panel. Placed after every hook so hook order is stable.
  if (!paneIsRenderable) return null;

  const inner = (() => {
    switch (pane.type) {
      case "session":
        return <SessionPane sessionId={pane.id} visible={visible} />;
      case "orgchart":
        return <HierarchyPanel />;
      case "templates":
        return <TemplatesPanel />;
      case "schedules":
        return <SchedulesPanel />;
      case "create-agent":
        return <CreateAgentPanel />;
      default:
        return null;
    }
  })();

  // Full-height flex host so the content (esp. the terminal's `flex-1`) fills
  // the dockview panel edge-to-edge — without this the terminal collapses and
  // the panel background shows through as dead space (ADR-047).
  return (
    <div
      ref={fillRef}
      className="dv-pane-fill"
      tabIndex={-1}
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        outline: "none",
        opacity: groupActive ? 1 : 0.5,
        transition: "opacity 0.12s ease",
      }}
    >
      {inner}
    </div>
  );
}
