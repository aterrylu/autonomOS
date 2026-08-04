import type { IDockviewPanelHeaderProps } from "dockview-react";
import {
  type AgentStatus,
  AgentStatusIcon,
} from "../../components/ui/agent-status-icon";
import { THEMES, useStore } from "../../store";
import type { PaneParams } from "./PaneContent";
import { paneFromPanel, paneTitle } from "./paneId";

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
  // are never validated (see PaneContent) — so paneTitle reads it nullish-safe.
  const title = paneTitle(pane, sessions);

  const status: AgentStatus | null =
    pane?.type === "session"
      ? ((agentStatuses[pane.id]?.status as AgentStatus) ?? "unknown")
      : null;

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
