import type { IDockviewPanelHeaderProps } from "dockview-react";
import {
  type AgentStatus,
  AgentStatusIcon,
} from "../../components/ui/agent-status-icon";
import { orderedPaneIds } from "../../shortcuts/orderedPaneIds";
import { digitForPane } from "../../shortcuts/paneDigits";
import { THEMES, useStore } from "../../store";
import type { PaneParams } from "./PaneContent";
import { paneFromPanel } from "./paneId";

/**
 * StatusTab — custom dockview tab renderer (registered as `"status"` and the
 * default tab). Shows the agent status icon + title + a close button, matching
 * the legacy TabBar (ADR-047). Reuses AgentStatusIcon.
 *
 * Close removes the panel via dockview's panel API (dockview owns the topology),
 * then reconciles the bound workspace: drop the closed pane from its group's
 * membership and re-serialize the remainder, or dissolve the group entirely once
 * only one pane is left (a 1-pane group is just a solo pane). Finally it moves
 * the active pane to whatever dockview now shows.
 */
export function StatusTab(props: IDockviewPanelHeaderProps<PaneParams>) {
  const { pane } = props.params;
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const agentStatuses = useStore((s) => s.agentStatuses);
  const page = THEMES[theme].page;

  // `pane` is typed non-nullable but comes from persisted panel params, which
  // are never validated (see PaneContent) — so every read here is nullish-safe.
  // Read the raw discriminant up front: inside the exhausted `default` below,
  // TS has narrowed `pane` to `never`, so it can't be inspected there.
  const declaredType = (pane as { type?: unknown } | undefined)?.type;
  const title = ((): string => {
    switch (pane?.type) {
      case "session":
        return (
          sessions.find((s) => s.id === pane.id)?.name || pane.id.slice(0, 8)
        );
      case "orgchart":
        return "Org Chart";
      case "templates":
        return "Templates";
      case "schedules":
        return "Schedules";
      case "create-agent":
        return "New Agent";
      default:
        // Only reachable from a saved layout naming a since-removed (or absent)
        // pane type; PaneContent closes such panels, but name the type so the
        // brief moment it is on screen — or a screenshot of it — is diagnosable.
        return `Unknown (${String(declaredType)})`;
    }
  })();

  const status: AgentStatus | null =
    pane?.type === "session"
      ? ((agentStatuses[pane.id]?.status as AgentStatus) ?? "unknown")
      : null;

  // Hold-mod hint (useModKeyHold): the digit that focuses THIS pane, computed
  // from the same visual-order walk the mod+digit shortcuts use — the badge is
  // the chord, so it cannot disagree with what pressing the number does.
  const modKeyHeld = useStore((s) => s.modKeyHeld);
  const paneDigit = ((): number | null => {
    if (!modKeyHeld) return null;
    const ids = orderedPaneIds(props.containerApi.toJSON());
    return digitForPane(ids.indexOf(props.api.id), ids.length);
  })();

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation();
    const api = props.containerApi;
    const st = useStore.getState();
    const paneId = pane?.id;
    const wsId = paneId ? st.dvPaneWorkspace[paneId] : undefined;

    // Remove the panel from dockview (it owns the topology).
    props.api.close();

    // Reconcile the bound workspace this pane belonged to. A panel with no
    // usable descriptor has no binding to reconcile — closing it is the job.
    if (paneId && wsId && st.dvWorkspaces[wsId]) {
      const ws = st.dvWorkspaces[wsId];
      const remaining = ws.paneIds.filter((id) => id !== paneId);
      const workspaces = { ...st.dvWorkspaces };
      const paneWorkspace = { ...st.dvPaneWorkspace };
      delete paneWorkspace[paneId];
      if (remaining.length <= 1) {
        // A lone pane isn't a group — dissolve the workspace, unbind the rest.
        delete workspaces[wsId];
        for (const id of ws.paneIds) delete paneWorkspace[id];
      } else {
        // toJSON() now reflects the post-close arrangement.
        workspaces[wsId] = { paneIds: remaining, serialized: api.toJSON() };
      }
      st.setDvWorkspaces(workspaces, paneWorkspace);
    }

    // Follow dockview's new active panel (or clear to the empty state).
    const nextId = api.activePanel?.id;
    st.setActivePane(
      nextId ? paneFromPanel(nextId, api.activePanel?.params?.pane) : null,
    );
  }

  return (
    <div
      className="group/tab flex items-center gap-1.5 px-2 h-full text-xs"
      style={{ color: page.fg }}
    >
      {paneDigit !== null && (
        <kbd
          data-testid="pane-digit-badge"
          className="shrink-0 rounded px-1 font-mono font-semibold"
          style={{
            fontSize: 10,
            lineHeight: "14px",
            background: page.fg,
            color: page.bg,
          }}
        >
          {paneDigit}
        </kbd>
      )}
      <span className="shrink-0" style={{ width: 12, height: 12 }}>
        {status && <AgentStatusIcon status={status} size={12} />}
      </span>
      <span className="truncate">{title}</span>
      <button
        type="button"
        className="shrink-0 rounded opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 cursor-pointer ml-1"
        style={{
          fontSize: 10,
          lineHeight: 1,
          background: "none",
          border: "none",
          color: "inherit",
        }}
        onClick={handleClose}
        tabIndex={-1}
        aria-label={`Close ${title}`}
      >
        ✕
      </button>
    </div>
  );
}
