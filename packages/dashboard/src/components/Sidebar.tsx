import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { Poll } from "../api/poll";
import { agentsPoll, projectsPoll, statusPoll, treePoll } from "../api/polls";
import { usePoll } from "../api/usePoll";
import { focusTerminal } from "../hooks/useTerminal";
import { DRAG_TYPE, encodeDragData } from "../layout/DragContext";
import type { ActivePane, ProjectInfo, SessionInfo } from "../store";
import {
  applyAgentsSnapshot,
  applyProjectsSnapshot,
  applyStatusSnapshot,
  buildFlatSections,
  sessionOrderKey,
  THEMES,
  useStore,
} from "../store";
import { Codicon } from "./Codicon";
import {
  mergeOrgWithSessions,
  type SidebarHierarchyNode,
} from "./mergeOrgWithSessions";
import { recencyTimestampStyle } from "./recency";
import {
  arrowForRow,
  digitForRow,
  flattenHierarchyRows,
} from "./sidebarRowOrder";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";
import { ProviderAgentIcon } from "./ui/provider-icon";

/** Select data fields that change over time — useShallow prevents re-renders when values are equal */
function useSidebarData() {
  return useStore(
    useShallow((s) => ({
      theme: s.theme,
      sessions: s.sessions,
      projects: s.projects,
      activePane: s.activePane,
      pinnedOrder: s.pinnedOrder,
      unpinnedOrder: s.unpinnedOrder,
      status: s.status,
      notificationCounts: s.notificationCounts,
      agentStatuses: s.agentStatuses,
      visiblePaneIds: s.visiblePaneIds,
      sidebarViewMode: s.sidebarViewMode,
      hierarchyOrder: s.hierarchyOrder,
    })),
  );
}

/** Select store actions — useShallow needed because the selector returns a new object */
function useSidebarActions() {
  return useStore(
    useShallow((s) => ({
      createSession: s.createSession,
      switchPane: s.switchPane,
      reorderFlat: s.reorderFlat,
      pinAgent: s.pinAgent,
      unpinAgent: s.unpinAgent,
      markNotificationsRead: s.markNotificationsRead,
      openOrgChart: s.openOrgChart,
      openTemplates: s.openTemplates,
      openSchedules: s.openSchedules,
      openPresets: s.openPresets,
      openCreateAgent: s.openCreateAgent,
      toggleSidebarViewMode: s.toggleSidebarViewMode,
      reorderHierarchy: s.reorderHierarchy,
    })),
  );
}

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

/** Which flat-view section a row belongs to. */
type FlatSection = "pinned" | "unpinned";

/**
 * Read the shared org-chart poll and surface fetch errors so the UI can warn
 * instead of silently hiding agents.
 *
 * `refreshKey` is a monotonic counter — when bumped, the hook forces an
 * immediate refresh. Callers use this to sync org chart refreshes with session
 * changes rather than waiting for the next 5s tick.
 *
 * This used to run its own 5s timer against `/api/agents/tree?k=<key>` with
 * `cache: "no-store"`, alongside an identical timer in HierarchyPanel. Both now
 * subscribe to ONE `treePoll`; the cache-buster is gone because a per-render
 * query param would have split this consumer off from that shared poll (and the
 * client's in-flight dedup + the poll's own equality check already make a
 * proxy-cached response a non-issue).
 */
function useOrgChartData(refreshKey: number) {
  const { data, error } = usePoll(treePoll);

  useEffect(() => {
    // Subscribing already fires an immediate refresh, so the mount value (0)
    // needs nothing — only a real session change forces an extra fetch.
    if (refreshKey > 0) void treePoll.refresh();
  }, [refreshKey]);

  useEffect(() => {
    if (error) {
      console.error(
        "[useOrgChartData] /api/agents/tree failed:",
        error.status,
        error.message,
      );
    } else if (data !== null && !Array.isArray(data)) {
      console.error("[useOrgChartData] unexpected response shape", data);
    }
  }, [error, data]);

  // Defensive: the server contract is `AgentTreeNode[]`. A non-array means the
  // server regressed or auth-gated the endpoint with a 200 + error envelope —
  // treat it as a real failure (the degraded banner) rather than an empty chart.
  const chart = Array.isArray(data) ? data : [];
  /** Whether the most recent fetch succeeded. "unknown" = pre-first-fetch. */
  const status: "unknown" | "ok" | "error" = error
    ? "error"
    : data === null
      ? "unknown"
      : Array.isArray(data)
        ? "ok"
        : "error";

  return { chart, status };
}

/** Enriched project data for one session, keyed by CC providerSessionId. */
type SessionMeta = {
  summary?: string;
  projectName?: string;
  gitBranch?: string;
  lastModified: number;
};

/**
 * Read sessionMetaMap for a live session, trying BOTH id-spaces.
 *
 * The map is keyed by `ProjectSession.sessionId` (the CC providerSessionId)
 * while a live session is identified by `claudeSessionId` (the agent id). Those
 * are equal for unified-id agents but DIFFER for split-id ones (spawned
 * post-#165, before the id unification), so an agent-id-only lookup silently
 * drops the summary / project / branch enrichment for exactly those agents.
 * Prefer the CC id — it is what the map is actually keyed by.
 */
function lookupSessionMeta(
  map: Map<string, SessionMeta>,
  session: { claudeSessionId?: string; providerSessionId?: string },
): SessionMeta | undefined {
  return (
    (session.providerSessionId
      ? map.get(session.providerSessionId)
      : undefined) ??
    (session.claudeSessionId ? map.get(session.claudeSessionId) : undefined)
  );
}

export function Sidebar() {
  const {
    theme,
    sessions,
    projects,
    activePane,
    pinnedOrder,
    unpinnedOrder,
    status,
    notificationCounts,
    agentStatuses,
    visiblePaneIds: visiblePaneIdList,
    sidebarViewMode,
    hierarchyOrder,
  } = useSidebarData();
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const {
    switchPane,
    markNotificationsRead,
    openOrgChart,
    openTemplates,
    openSchedules,
    openPresets,
    openCreateAgent,
    toggleSidebarViewMode,
    reorderHierarchy,
    reorderFlat,
    pinAgent,
    unpinAgent,
  } = useSidebarActions();
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";

  // Set of pane IDs dockview is currently showing (sourced from the store via
  // DockviewLayout's onDidLayoutChange). Used to mark which rows are on-screen.
  const visiblePaneIds = useMemo(
    () => new Set(visiblePaneIdList),
    [visiblePaneIdList],
  );

  // Flat-view sections — pinned on top, unpinned below. Each is a plain list of
  // sessions (no group containers).
  const flatSections = useMemo(
    () => buildFlatSections(sessions, pinnedOrder, unpinnedOrder),
    [sessions, pinnedOrder, unpinnedOrder],
  );

  // Compute a stable fingerprint of the session fields that affect the org
  // chart. When this changes (spawn, kill, rename, set_manager, status flip),
  // we bump `orgRefreshKey` to force an immediate /api/agents/tree refetch —
  // otherwise the hierarchy lags by up to 5s behind the flat view.
  const sessionFingerprint = useMemo(
    () =>
      sessions
        .map(
          (s) =>
            `${s.id}:${s.name}:${s.claudeSessionId ?? ""}:${s.manager ?? ""}:${s.template ?? ""}:${s.status}`,
        )
        .sort()
        .join("|"),
    [sessions],
  );
  const [orgRefreshKey, setOrgRefreshKey] = useState(0);
  const prevFingerprintRef = useRef(sessionFingerprint);
  useEffect(() => {
    if (prevFingerprintRef.current !== sessionFingerprint) {
      prevFingerprintRef.current = sessionFingerprint;
      setOrgRefreshKey((k) => k + 1);
    }
  }, [sessionFingerprint]);

  // Fetch org chart for hierarchy view
  const { chart: orgChart, status: orgStatus } = useOrgChartData(orgRefreshKey);

  // Merge org chart tree with live sessions. Stopped agents are always pruned
  // from the tree — the sidebar no longer surfaces exited agents.
  const hierarchyTree = useMemo(
    () => mergeOrgWithSessions(orgChart, sessions, true, hierarchyOrder),
    [orgChart, sessions, hierarchyOrder],
  );

  /**
   * Hierarchy is "degraded" when the user has live sessions we can't show in
   * the tree, OR when /api/agents/tree is outright broken.
   * `HierarchyFallbackNotice` renders a banner with a one-click escape hatch
   * to the flat view — it does NOT render an inline flat list (the user opts
   * in via the button).
   *
   * We surface the `"error"` state even with zero sessions so a broken
   * tree endpoint is visible to the user instead of masquerading as
   * "No agents".
   */
  const hierarchyDegraded =
    orgStatus === "error" ||
    (sessions.length > 0 && hierarchyTree.length === 0);

  // Collapsed state for hierarchy groups (manager name → collapsed)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  // Publish the RENDERED agent-row order (ADR-066): the mod+digit shortcuts
  // switch to sidebarRowOrder[n-1] and the hold-badges number the same list,
  // so what you see is exactly what the digits do. Mirrors the JSX: flat =
  // pinned then unpinned; hierarchy = DFS skipping collapsed subtrees and
  // non-clickable "stopped" rows; degraded hierarchy shows no rows → empty.
  const renderedRowOrder = useMemo(
    () =>
      sidebarViewMode === "flat"
        ? [...flatSections.pinned, ...flatSections.unpinned].map((s) => s.id)
        : hierarchyDegraded
          ? []
          : flattenHierarchyRows(hierarchyTree, collapsedGroups),
    [
      sidebarViewMode,
      flatSections,
      hierarchyTree,
      collapsedGroups,
      hierarchyDegraded,
    ],
  );
  const setSidebarRowOrder = useStore((s) => s.setSidebarRowOrder);
  useEffect(() => {
    setSidebarRowOrder(renderedRowOrder);
  }, [renderedRowOrder, setSidebarRowOrder]);
  // The sidebar can unmount/hide entirely — digits must go dead, not stale.
  useEffect(() => {
    return () => useStore.getState().setSidebarRowOrder([]);
  }, []);
  const toggleCollapsed = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Shared drag state for hierarchy reordering
  const hierDrag = useRef<{ group: string; idx: number } | null>(null);
  const [hierDropTarget, setHierDropTarget] = useState<{
    group: string;
    idx: number;
  } | null>(null);

  // Build a lookup map from the CC providerSessionId → enriched project data.
  // NOTE the key: ProjectSession.sessionId is the CC session id, NOT the agent
  // id. Read it via lookupSessionMeta, which tries both id-spaces.
  const sessionMetaMap = useMemo(() => {
    const map = new Map<
      string,
      {
        summary?: string;
        projectName?: string;
        gitBranch?: string;
        lastModified: number;
      }
    >();
    for (const p of projects) {
      for (const ps of p.sessions) {
        map.set(ps.sessionId, {
          summary: ps.summary,
          projectName: p.name,
          gitBranch: ps.gitBranch,
          lastModified: ps.lastModified,
        });
      }
    }
    return map;
  }, [projects]);

  // Ids that have an active live session. Holds BOTH id-spaces: this set is
  // built from live sessions (keyed by agent id) but tested against
  // ProjectSession.sessionId (the CC providerSessionId). Those are equal for
  // unified-id agents and DIFFER for split-id ones (spawned post-#165, before
  // the id unification) — so an agent-id-only set leaves split-id agents
  // without their live dot in the Projects panel.
  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.claudeSessionId) set.add(s.claudeSessionId);
      if (s.providerSessionId) set.add(s.providerSessionId);
    }
    return set;
  }, [sessions]);

  // Feed the store from the shared polls — live sessions every 5s, projects
  // every 30s, notifications every 3s: the same three cadences the three
  // setIntervals here used to drive, now one timer per resource shared with
  // every other subscriber. Subscribing kicks off an immediate refresh, which
  // is what the old mount-time fetch trio did. The store stays the source of
  // truth (every selector below reads it); the polls only feed it.
  //
  // Scope is deliberately unchanged: the Sidebar unmounts when collapsed, which
  // stopped all three intervals before and stops all three polls now.
  useEffect(() => {
    const bridge = <T,>(poll: Poll<T>, apply: (data: T) => void) =>
      poll.subscribe(() => {
        const { data } = poll.getSnapshot();
        if (data) apply(data);
      });
    const unsubscribes = [
      bridge(agentsPoll, applyAgentsSnapshot),
      bridge(projectsPoll, applyProjectsSnapshot),
      bridge(statusPoll, applyStatusSnapshot),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);

  // Drag state — section-scoped. Reordering is confined to within one section;
  // moving between pinned/unpinned is done via the pin/unpin button, not drag.
  const dragRef = useRef<{ section: FlatSection; idx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    section: FlatSection;
    idx: number;
  } | null>(null);

  function handleDragStart(
    e: React.DragEvent,
    section: FlatSection,
    idx: number,
    pane: ActivePane,
  ) {
    dragRef.current = { section, idx };
    const data = { pane };
    e.dataTransfer.setData(DRAG_TYPE, encodeDragData(data));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(
    e: React.DragEvent,
    section: FlatSection,
    idx: number,
  ) {
    // Only a same-section drop is a reorder; ignore hovers from the other
    // section so the cursor shows "no drop" there.
    if (dragRef.current?.section !== section) return;
    e.preventDefault();
    setDropTarget({ section, idx });
  }

  function handleDrop(section: FlatSection, idx: number) {
    const d = dragRef.current;
    if (d && d.section === section && d.idx !== idx) {
      reorderFlat(section, d.idx, idx);
    }
    dragRef.current = null;
    setDropTarget(null);
  }

  function handleDragEnd() {
    dragRef.current = null;
    setDropTarget(null);
  }

  function isPaneActive(pane: ActivePane): boolean {
    if (!activePane) return false;
    return activePane.type === pane.type && activePane.id === pane.id;
  }

  // Render one flat-view row within a given section. Drag handlers are bound to
  // the section so reordering stays section-local; the pin/unpin button is the
  // only way to cross sections.
  function renderFlatItem(
    session: SessionInfo,
    section: FlatSection,
    idx: number,
  ) {
    const isDropTarget =
      dropTarget?.section === section && dropTarget.idx === idx;
    const isPinned = section === "pinned";
    const pane: ActivePane = { type: "session", id: session.id };
    // Pin/unpin address rows by their ORDER key (claudeSessionId || id), which
    // is not always the agent id — see sessionOrderKey.
    const orderKey = sessionOrderKey(session);

    return (
      <SessionRow
        key={`s-${session.id}`}
        session={session}
        pane={pane}
        idx={idx}
        page={page}
        isActive={isPaneActive(pane)}
        isVisible={visiblePaneIds.has(session.id)}
        isDropTarget={isDropTarget}
        meta={lookupSessionMeta(sessionMetaMap, session)}
        agentState={agentStatuses[session.id]}
        notifCount={notificationCounts[session.id] ?? 0}
        indent={0}
        isPinned={isPinned}
        onTogglePin={() =>
          isPinned ? unpinAgent(orderKey) : pinAgent(orderKey)
        }
        draggable
        onDragStart={(e, i, dragPane) =>
          handleDragStart(e, section, i, dragPane)
        }
        onDragOver={(e, i) => handleDragOver(e, section, i)}
        onDrop={(i) => handleDrop(section, i)}
        onDragEnd={handleDragEnd}
        onClick={() => {
          switchPane(pane);
          focusTerminal(session.id);
          if (notificationCounts[session.id]) markNotificationsRead(session.id);
        }}
      />
    );
  }

  return (
    <aside
      className="absolute inset-y-0 left-0 z-20 flex shrink-0 flex-col overflow-y-auto md:relative"
      style={{
        width: sidebarWidth,
        borderRight: `1px solid ${page.border}`,
        background: page.bg,
      }}
    >
      {/* Singleton pane buttons */}
      <SidebarNavButton
        label="Org Chart"
        active={activePane?.type === "orgchart"}
        page={page}
        onClick={openOrgChart}
        dragPane={{ type: "orgchart", id: "orgchart" }}
      />
      <SidebarNavButton
        label="Templates"
        active={activePane?.type === "templates"}
        page={page}
        onClick={openTemplates}
        dragPane={{ type: "templates", id: "templates" }}
      />
      <SidebarNavButton
        label="Schedules"
        active={activePane?.type === "schedules"}
        page={page}
        onClick={openSchedules}
        dragPane={{ type: "schedules", id: "schedules" }}
      />
      <SidebarNavButton
        label="Presets"
        active={activePane?.type === "presets"}
        page={page}
        onClick={openPresets}
        dragPane={{ type: "presets", id: "presets" }}
      />

      {/* Agents section header + toggle + New button */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase flex-1"
          style={{ color: page.statusFg }}
        >
          Agents
        </span>
        <button
          type="button"
          onClick={toggleSidebarViewMode}
          className="text-[10px] cursor-pointer px-1 rounded transition-colors"
          style={{
            color: sidebarViewMode === "hierarchy" ? page.fg : page.statusFg,
          }}
          title={
            sidebarViewMode === "flat"
              ? "Switch to hierarchy view"
              : "Switch to flat view"
          }
        >
          <Codicon
            name={sidebarViewMode === "flat" ? "list-tree" : "list-flat"}
            size={12}
          />
        </button>
        <button
          type="button"
          onClick={() => openCreateAgent()}
          disabled={isSpawning}
          className="rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
          title="New Agent"
        >
          + New
        </button>
      </div>

      {sidebarViewMode === "flat" ? (
        /* ── Flat view: pinned section, divider, unpinned section ── */
        <div className="py-1">
          {flatSections.pinned.length === 0 &&
            flatSections.unpinned.length === 0 && (
              <p
                className="px-3 py-3 text-center text-xs"
                style={{ color: page.statusFg }}
              >
                No active agents
              </p>
            )}

          {flatSections.pinned.map((session, idx) =>
            renderFlatItem(session, "pinned", idx),
          )}

          {/* Divider — only between two non-empty sections (no dangling line). */}
          {flatSections.pinned.length > 0 &&
            flatSections.unpinned.length > 0 && (
              <div
                data-testid="flat-section-divider"
                className="mx-3 my-1.5"
                style={{ height: 1, background: page.statusFg, opacity: 0.25 }}
                aria-hidden="true"
              />
            )}

          {flatSections.unpinned.map((session, idx) =>
            renderFlatItem(session, "unpinned", idx),
          )}
        </div>
      ) : (
        /* ── Hierarchy view ───────────────────────────────────── */
        <div className="py-1">
          {hierarchyDegraded && (
            <HierarchyFallbackNotice
              orgStatus={orgStatus}
              sessionCount={sessions.length}
              onSwitchToFlat={toggleSidebarViewMode}
              page={page}
            />
          )}

          {!hierarchyDegraded && hierarchyTree.length === 0 && (
            <p
              className="px-3 py-3 text-center text-xs"
              style={{ color: page.statusFg }}
            >
              No active agents
            </p>
          )}

          {!hierarchyDegraded &&
            hierarchyTree.map((node, idx) => (
              <HierarchyNodeRow
                key={node.org.name ?? node.org.claudeSessionId ?? `node-${idx}`}
                node={node}
                depth={0}
                groupKey="__root__"
                indexInGroup={idx}
                isLastChild={idx === hierarchyTree.length - 1}
                ancestorIsLast={[]}
                page={page}
                isPaneActive={isPaneActive}
                visiblePaneIds={visiblePaneIds}
                sessionMetaMap={sessionMetaMap}
                agentStatuses={agentStatuses}
                notificationCounts={notificationCounts}
                collapsedGroups={collapsedGroups}
                toggleCollapsed={toggleCollapsed}
                switchPane={switchPane}
                markNotificationsRead={markNotificationsRead}
                onReorder={(gk, from, to) => {
                  // Initialize order for this group if not yet stored
                  const existing = hierarchyOrder[gk];
                  if (!existing || existing.length === 0) {
                    // Determine current sibling names for this group
                    const siblings =
                      gk === "__root__"
                        ? hierarchyTree.map((n) =>
                            (n.org.name ?? "").toLowerCase(),
                          )
                        : (() => {
                            // Find parent node and get its children names
                            function findChildren(
                              nodes: SidebarHierarchyNode[],
                            ): string[] | null {
                              for (const n of nodes) {
                                if ((n.org.name ?? "").toLowerCase() === gk)
                                  return n.children.map((c) =>
                                    (c.org.name ?? "").toLowerCase(),
                                  );
                                const found = findChildren(n.children);
                                if (found) return found;
                              }
                              return null;
                            }
                            return findChildren(hierarchyTree) ?? [];
                          })();
                    // Set it first, then reorder
                    const order = [...siblings];
                    const [moved] = order.splice(from, 1);
                    order.splice(to, 0, moved);
                    useStore.setState((prev) => ({
                      hierarchyOrder: { ...prev.hierarchyOrder, [gk]: order },
                    }));
                  } else {
                    reorderHierarchy(gk, from, to);
                  }
                }}
                hierDrag={hierDrag}
                hierDropTarget={hierDropTarget}
                setHierDropTarget={setHierDropTarget}
              />
            ))}
        </div>
      )}

      {/* Projects Section */}
      <div
        className="flex items-center px-3 py-2"
        style={{
          borderTop: `1px solid ${page.border}`,
          borderBottom: `1px solid ${page.border}`,
        }}
      >
        <span
          className="text-xs font-medium uppercase"
          style={{ color: page.statusFg }}
        >
          Projects
        </span>
      </div>

      <div className="flex-1 py-1">
        {projects.length === 0 && (
          <p
            className="px-3 py-3 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No projects found
          </p>
        )}

        {projects.map((project) => (
          <ProjectItem
            key={project.path}
            project={project}
            page={page}
            liveSessionIds={liveSessionIds}
          />
        ))}
      </div>
    </aside>
  );
}

export function SidebarResizeHandle() {
  const page = THEMES[useStore((s) => s.theme)].page;
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const resetSidebarWidth = useStore((s) => s.resetSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const listenersRef = useRef<{
    move: (ev: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (listenersRef.current) {
        document.removeEventListener("mousemove", listenersRef.current.move);
        document.removeEventListener("mouseup", listenersRef.current.up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        listenersRef.current = null;
      }
    };
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);

      const onMouseMove = (ev: MouseEvent) => {
        setSidebarWidth(ev.clientX);
      };
      const onMouseUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        listenersRef.current = null;
      };

      listenersRef.current = { move: onMouseMove, up: onMouseUp };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [setSidebarWidth],
  );

  return (
    // Zero-width wrapper so the handle takes no layout space — the content sits
    // flush against the sidebar's 1px right border (no gap). The grab area is an
    // absolutely-positioned overlay straddling the boundary: invisible at rest,
    // highlighted on hover/drag.
    <div className="relative z-20 shrink-0" style={{ width: 0 }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: resize drag handle */}
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={resetSidebarWidth}
        className="absolute inset-y-0 transition-colors"
        style={{
          left: -2,
          width: 5,
          cursor: "col-resize",
          background: dragging ? page.statusFg : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!dragging)
            (e.currentTarget as HTMLElement).style.background = page.border;
        }}
        onMouseLeave={(e) => {
          if (!dragging)
            (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      />
    </div>
  );
}

function SidebarNavButton({
  label,
  active,
  page,
  onClick,
  dragPane,
}: {
  label: string;
  active: boolean;
  page: PageTheme;
  onClick: () => void;
  /** When set, the button is draggable into the layout (dockview drop wiring
   *  reads DRAG_TYPE). Lets Org Chart / Templates / Schedules be dragged into
   *  the terminal area as a tab/split, same as agent rows. */
  dragPane?: ActivePane;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      draggable={dragPane ? true : undefined}
      onDragStart={
        dragPane
          ? (e) => {
              e.dataTransfer.setData(
                DRAG_TYPE,
                encodeDragData({ pane: dragPane }),
              );
              e.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      className="flex items-center px-3 py-2 w-full text-left cursor-pointer transition-colors"
      style={{
        borderBottom: `1px solid ${page.border}`,
        color: active ? page.fg : page.statusFg,
        background: active ? page.border : "transparent",
      }}
    >
      <span className="text-xs font-medium uppercase">{label}</span>
    </button>
  );
}

// ── Extracted row components ────────────────────────────────────────────

interface SessionRowProps {
  session: SessionInfo;
  pane: ActivePane;
  idx: number;
  page: PageTheme;
  isActive: boolean;
  isVisible: boolean;
  isDropTarget: boolean;
  meta?: {
    summary?: string;
    projectName?: string;
    gitBranch?: string;
    lastModified: number;
  };
  agentState?: { status: string; currentTool?: string; toolDetail?: string };
  notifCount: number;
  indent: number;
  /** Override the left border color (e.g. to indicate parent with children) */
  borderColor?: string;
  /** Callback when the left border zone is clicked (e.g. expand/collapse) */
  onBorderClick?: () => void;
  /** Override left padding (used by hierarchy tree-line layout) */
  paddingLeftOverride?: number;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, idx: number, pane: ActivePane) => void;
  onDragOver?: (e: React.DragEvent, idx: number) => void;
  onDrop?: (idx: number) => void;
  onDragEnd?: () => void;
  /** Whether this row is in the pinned section (flat view only). */
  isPinned?: boolean;
  /** Toggle pin state. Presence enables the hover-reveal pin button. */
  onTogglePin?: () => void;
  onClick: () => void;
}

/**
 * Active-agent highlight: a gold/amber outline ring + soft glow, drawn with an
 * inset box-shadow so there is NO layout reflow on activation and it stays
 * orthogonal to the 3px left border hierarchy view uses for parent rows (the
 * ring sits inside that border, so both signals coexist). `accent` is the
 * theme's gold/amber token (THEMES[theme].terminal.yellow). Alpha suffixes
 * follow the existing 8-digit-hex convention (cf. `${page.border}80`).
 * Medium intensity — bump the alphas for "strong", drop them for "subtle".
 */
function activeHighlight(accent: string) {
  return {
    background: `${accent}14`, // ~8% gold fill
    boxShadow: `inset 0 0 0 1px ${accent}a8, 0 0 12px ${accent}33`, // ~66% ring + ~20% glow
  };
}

/**
 * Co-visible highlight: a row whose pane is on-screen in the active workspace
 * group but is NOT the focused one. A neutral (page.fg) outline ring + faint
 * fill — the same ring affordance as the active gold highlight but a quieter,
 * different color, so grouped panes read as "also here, just not focused." No
 * glow — the glow is reserved as the focus signal. `neutral` is the theme's
 * foreground token, so it inverts correctly on light themes.
 */
function visibleHighlight(neutral: string) {
  return {
    background: `${neutral}0a`, // ~4% neutral fill
    boxShadow: `inset 0 0 0 1px ${neutral}4d`, // ~30% neutral ring
  };
}

/** Compose the active ring/glow with the drop-target indicator (a row can be both). */
function rowBoxShadow(
  highlight: { boxShadow: string } | null,
  isDropTarget: boolean,
  dropColor: string,
): string | undefined {
  return (
    [highlight?.boxShadow, isDropTarget ? `inset 0 2px 0 ${dropColor}` : null]
      .filter(Boolean)
      .join(", ") || undefined
  );
}

function SessionRow({
  session: s,
  pane,
  idx,
  page,
  isActive,
  isVisible,
  isDropTarget,
  meta,
  agentState,
  notifCount,
  indent,
  borderColor,
  onBorderClick,
  paddingLeftOverride,
  draggable: isDraggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isPinned,
  onTogglePin,
  onClick,
}: SessionRowProps) {
  const lastActive = meta?.lastModified ?? s.createdAt;
  const paddingLeft = paddingLeftOverride ?? 9 + indent * 10;
  const agentIconStyle = useStore((st) => st.agentIconStyle);
  const status = (agentState?.status as AgentStatus) ?? "unknown";
  const accent = THEMES[useStore((st) => st.theme)].terminal.yellow;

  // Hold-mod hints (useModKeyHold): the digit that switches to THIS row, and
  // the ↑/↓ arrow when this row is the mod+↑/mod+↓ target relative to the
  // active agent — both looked up in the same published order the shortcuts
  // execute against.
  const modKeyHeld = useStore((st) => st.modKeyHeld);
  const rowOrder = useStore((st) => st.sidebarRowOrder);
  const activeSessionId = useStore((st) =>
    st.activePane?.type === "session" ? st.activePane.id : null,
  );
  const rowIndex = modKeyHeld ? rowOrder.indexOf(s.id) : -1;
  const rowDigit = modKeyHeld ? digitForRow(rowIndex, rowOrder.length) : null;
  const rowArrow = modKeyHeld
    ? arrowForRow(
        rowIndex,
        activeSessionId ? rowOrder.indexOf(activeSessionId) : -1,
      )
    : null;
  const highlight = isActive
    ? activeHighlight(accent)
    : isVisible
      ? visibleHighlight(page.fg)
      : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
    <div
      role="button"
      tabIndex={-1}
      onMouseDown={(e: React.MouseEvent) => {
        if (!(e.currentTarget as HTMLElement).draggable) e.preventDefault();
      }}
      draggable={isDraggable}
      onDragStart={
        isDraggable && onDragStart
          ? (e) => onDragStart(e, idx, pane)
          : undefined
      }
      onDragOver={
        isDraggable && onDragOver ? (e) => onDragOver(e, idx) : undefined
      }
      onDrop={isDraggable && onDrop ? () => onDrop(idx) : undefined}
      onDragEnd={isDraggable ? onDragEnd : undefined}
      className="group flex w-full items-center gap-1.5 py-1 cursor-pointer text-left relative"
      style={{
        borderLeft: `3px solid ${borderColor ?? "transparent"}`,
        paddingLeft: `${paddingLeft}px`,
        paddingRight: "12px",
        borderRadius: highlight ? "5px" : undefined,
        background: highlight ? highlight.background : "transparent",
        boxShadow: rowBoxShadow(highlight, isDropTarget, page.fg),
      }}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      {/* Clickable left border zone for expand/collapse */}
      {onBorderClick && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: border toggle zone
        // biome-ignore lint/a11y/noStaticElementInteractions: border toggle zone
        <div
          className="absolute inset-y-0 left-0 cursor-pointer"
          style={{ width: `${paddingLeft + 3}px` }}
          onClick={(e) => {
            e.stopPropagation();
            onBorderClick();
          }}
        />
      )}
      {rowDigit !== null && (
        <kbd
          data-testid="agent-digit-badge"
          className="shrink-0 rounded px-1 font-mono font-semibold"
          style={{
            fontSize: 10,
            lineHeight: "14px",
            background: page.fg,
            color: page.bg,
          }}
        >
          {rowDigit}
        </kbd>
      )}
      {rowArrow !== null && (
        <kbd
          data-testid="agent-arrow-badge"
          className="shrink-0 rounded px-1 font-mono font-semibold"
          style={{
            fontSize: 10,
            lineHeight: "14px",
            background: page.statusFg,
            color: page.bg,
          }}
        >
          {rowArrow === "up" ? "↑" : "↓"}
        </kbd>
      )}
      {agentIconStyle === "provider" ? (
        <ProviderAgentIcon provider={s.provider} status={status} size={16} />
      ) : (
        <AgentStatusIcon status={status} size={14} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="flex-1 truncate text-xs">{s.name}</span>
          {/* Recency treatment (B2 — timestamp-only fade): the timestamp fades
              with age so wildly-stale sessions recede. Only this span changes;
              the row, name, status, and repo·branch line are untouched. Computed
              from the same lastActive the text renders from, so it rides the
              sidebar's existing ~5s render cadence — no new timer. */}
          <span
            className="shrink-0 text-[10px]"
            style={recencyTimestampStyle(
              lastActive,
              Date.now(),
              page.statusFg,
              page.fg,
              page.bg,
            )}
          >
            {notifCount > 0 && (
              <span style={{ color: "#ea6c73" }}>{notifCount} unread · </span>
            )}
            {formatAge(lastActive)}
          </span>
        </div>
        <div
          className="flex items-center text-[10px]"
          style={{ color: page.statusFg }}
        >
          {/* NOT flex-1: shrink to content so the pill sits immediately right
              of the repo·branch text (Terry's spec), rather than being pushed
              to the far corner. min-w-0 keeps long branch names truncatable. */}
          <span className="min-w-0 truncate">
            {meta?.projectName ?? s.workingDirectory.split("/").pop()}
            {meta?.gitBranch &&
              meta.gitBranch !== "HEAD" &&
              ` · ${meta.gitBranch}`}
          </span>
          {/* shrink-0 with NO width cap — the preset name always renders in
              full (Terry's spec); the repo text and status label are the
              members that give way on narrow rows. */}
          {s.envPreset && (
            <span
              className="shrink-0 ml-1.5 px-1 rounded"
              style={{
                color: accent,
                background: `${accent}1f`,
                border: `1px solid ${accent}`,
              }}
              title={`Env preset: ${s.envPreset}`}
            >
              {s.envPreset}
            </span>
          )}
          {/* ml-auto keeps the transient label right-aligned; min-w-0 +
              truncate (NOT shrink-0) because currentTool is a raw hook
              tool_name ("Running mcp__autonomos__create_schedule") and the
              sidebar clips on x — a non-shrinking label would crowd out the
              repo text and the pill on narrow rows. */}
          {agentState?.status && agentState.status !== "unknown" && (
            <span className="ml-auto min-w-0 truncate pl-1.5 opacity-75">
              {agentStatusLabel(
                agentState.status as AgentStatus,
                agentState.currentTool,
              )}
            </span>
          )}
        </div>
      </div>
      {onTogglePin && (
        <button
          type="button"
          // Not draggable: keep a drag started on the pin glyph from
          // initiating a row drag (the button lives inside the draggable row).
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          // Top-left corner, out of layout flow. Hidden until row-hover when
          // unpinned; stays visible once pinned (persistent pinned indicator).
          // NOTE: this sits over the same top-left spot as the onBorderClick
          // zone, so it's only safe because pinning is flat-view-only (rows with
          // onTogglePin never get onBorderClick). Don't pass both to one row.
          className={`absolute left-0 top-0 z-10 rounded cursor-pointer transition-opacity ${
            isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          style={{ color: isPinned ? page.fg : page.statusFg }}
          title={isPinned ? "Unpin agent" : "Pin agent"}
        >
          <Codicon
            name={isPinned ? "pinned" : "pin"}
            size={11}
            // Both states point straight down. The two glyphs have different
            // default orientations: "pinned" tip is down-left (−45° → vertical),
            // "pin" tip is horizontal-left (−90° → vertical).
            style={{
              transform: isPinned ? "rotate(-45deg)" : "rotate(-90deg)",
            }}
          />
        </button>
      )}
    </div>
  );
}

// ── Hierarchy fallback notice ───────────────────────────────────────────
//
// Safety net for the case where the hierarchy would otherwise show "No agents"
// despite live sessions existing — e.g. /api/agents/tree errored, or name-
// matching failed for every node. Shows a one-line banner with a "Switch to
// flat view" button so the user always has a path back to their agents.
function HierarchyFallbackNotice({
  orgStatus,
  sessionCount,
  onSwitchToFlat,
  page,
}: {
  orgStatus: "unknown" | "ok" | "error";
  sessionCount: number;
  onSwitchToFlat: () => void;
  page: PageTheme;
}) {
  const agentWord = sessionCount === 1 ? "agent" : "agents";
  const message =
    orgStatus === "error"
      ? `Hierarchy unavailable — ${sessionCount} live ${agentWord} hidden`
      : `Hierarchy syncing — ${sessionCount} live ${agentWord} not yet matched`;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-[10px]"
      style={{
        color: page.statusFg,
        borderBottom: `1px solid ${page.border}`,
      }}
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onSwitchToFlat}
        className="shrink-0 rounded px-1.5 py-0.5 cursor-pointer"
        style={{ color: page.fg, border: `1px solid ${page.border}` }}
        title="Switch to flat view"
      >
        Show flat
      </button>
    </div>
  );
}

// ── Hierarchy tree node ─────────────────────────────────────────────────

interface HierarchyNodeRowProps {
  node: SidebarHierarchyNode;
  depth: number;
  /** Key identifying this node's group (parent name, or "__root__") */
  groupKey: string;
  /** Index of this node within its sibling group */
  indexInGroup: number;
  /** Whether this node is the last child in its parent group */
  isLastChild: boolean;
  /**
   * For each ancestor depth (index 0 = depth 0, index 1 = depth 1, etc.),
   * true means that ancestor was the last child — so NO continuing vertical
   * line at that level.  Index 0 (root) is skipped since depth-0 nodes have
   * no branch connector to continue.
   */
  ancestorIsLast: boolean[];
  page: PageTheme;
  isPaneActive: (pane: ActivePane) => boolean;
  visiblePaneIds: Set<string>;
  sessionMetaMap: Map<
    string,
    {
      summary?: string;
      projectName?: string;
      gitBranch?: string;
      lastModified: number;
    }
  >;
  agentStatuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  >;
  notificationCounts: Record<string, number>;
  collapsedGroups: Set<string>;
  toggleCollapsed: (name: string) => void;
  switchPane: (pane: ActivePane | null) => void;
  markNotificationsRead: (sessionId: string) => Promise<void>;
  onReorder: (groupKey: string, fromIndex: number, toIndex: number) => void;
  /** Shared drag state across all hierarchy rows */
  hierDrag: React.MutableRefObject<{ group: string; idx: number } | null>;
  hierDropTarget: { group: string; idx: number } | null;
  setHierDropTarget: (v: { group: string; idx: number } | null) => void;
}

// ── Tree-line geometry ──────────────────────────────────────────────────
//
// Guide lines at each depth are aligned with the parent row's status icon
// center. This means guideX is computed recursively from the parent's
// actual content position rather than a fixed linear formula.
//
//   SessionRow layout:  [3px border] [paddingLeft ...] [14px icon] [content]
//   Icon center = 3 + paddingLeft + 7

/** Width of the horizontal branch arm (px) */
const TREE_BRANCH_WIDTH = 4;
/** Gap between end of branch arm and row content (px) */
const TREE_BRANCH_GAP = 2;
/** Half the AgentStatusIcon size (14px) */
const TREE_ICON_HALF = 7;
/** SessionRow borderLeft width (always 3px, colored or transparent) */
const TREE_BORDER = 3;

/** X position of the vertical guide line at a given depth (aligned to parent icon center) */
function guideX(depth: number): number {
  if (depth <= 0 || !Number.isFinite(depth)) return 0;
  // Align with icon center of the parent row at depth-1
  return TREE_BORDER + treePaddingLeft(depth - 1) + TREE_ICON_HALF;
}

/** Left padding for row content (after the branch arm + gap, minus border) */
function treePaddingLeft(depth: number): number {
  if (depth <= 0 || !Number.isFinite(depth)) return 9;
  // Subtract TREE_BORDER because SessionRow's borderLeft adds 3px before padding
  return guideX(depth) + TREE_BRANCH_WIDTH + TREE_BRANCH_GAP - TREE_BORDER;
}

/**
 * Renders vertical continuation lines + the branch/elbow connector for one
 * hierarchy row.  Pure presentational — no interactivity.
 */
function TreeLineGuides({
  depth,
  isLastChild,
  ancestorIsLast,
  lineColor,
}: {
  depth: number;
  isLastChild: boolean;
  ancestorIsLast: boolean[];
  lineColor: string;
}) {
  if (depth === 0) return null;

  const branchAtX = guideX(depth);

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 1 }}>
      {/* Vertical continuation lines for ancestor levels (skip depth 0 — roots have no connector) */}
      {ancestorIsLast.reduce<React.ReactNode[]>((acc, isLast, i) => {
        if (!isLast && i > 0) {
          const x = guideX(i);
          acc.push(
            <div
              key={`vl${x}`}
              className="absolute top-0 bottom-0"
              style={{
                left: `${x}px`,
                width: "1px",
                background: lineColor,
              }}
            />,
          );
        }
        return acc;
      }, [])}

      {/* Branch connector: ├── or └── */}
      {/* Vertical segment (half-height for └, full for ├) */}
      <div
        className="absolute"
        style={{
          left: `${branchAtX}px`,
          top: 0,
          bottom: isLastChild ? "50%" : 0,
          width: "1px",
          background: lineColor,
        }}
      />
      {/* Horizontal arm */}
      <div
        className="absolute"
        style={{
          left: `${branchAtX}px`,
          top: "50%",
          width: `${TREE_BRANCH_WIDTH}px`,
          height: "1px",
          background: lineColor,
        }}
      />
    </div>
  );
}

function HierarchyNodeRow({
  node,
  depth,
  groupKey,
  indexInGroup,
  isLastChild,
  ancestorIsLast,
  page,
  isPaneActive,
  visiblePaneIds,
  sessionMetaMap,
  agentStatuses,
  notificationCounts,
  collapsedGroups,
  toggleCollapsed,
  switchPane,
  markNotificationsRead,
  onReorder,
  hierDrag,
  hierDropTarget,
  setHierDropTarget,
}: HierarchyNodeRowProps) {
  const s = node.session; // may be undefined for exited agents
  const nodeName = node.org.name ?? "";
  const isCollapsed = collapsedGroups.has(nodeName.toLowerCase());
  const hasChildren = node.children.length > 0;

  const isDropTarget =
    hierDropTarget?.group === groupKey && hierDropTarget?.idx === indexInGroup;

  const lineColor = `${page.statusFg}55`;
  const rowPaddingLeft = depth > 0 ? treePaddingLeft(depth) : 9;

  // Colored left border for parents with children (existing design)
  const borderColor = hasChildren
    ? isCollapsed
      ? "rgba(255,255,255,0.15)"
      : "rgba(59,130,246,0.5)"
    : undefined;

  // Shared tree guides + downward connector (used by both live and exited rows)
  const treeGuides = (
    <>
      <TreeLineGuides
        depth={depth}
        isLastChild={isLastChild}
        ancestorIsLast={ancestorIsLast}
        lineColor={lineColor}
      />
      {/* Downward connector from parent icon to children (depth+1) */}
      {hasChildren && !isCollapsed && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: `${guideX(depth + 1)}px`,
            top: "50%",
            bottom: 0,
            width: "1px",
            background: lineColor,
            zIndex: 1,
          }}
        />
      )}
    </>
  );

  return (
    <>
      {s ? (
        <div className="relative">
          {treeGuides}
          <SessionRow
            session={s}
            pane={{ type: "session", id: s.id }}
            idx={indexInGroup}
            page={page}
            isActive={isPaneActive({ type: "session", id: s.id })}
            isVisible={visiblePaneIds.has(s.id)}
            isDropTarget={isDropTarget}
            meta={lookupSessionMeta(sessionMetaMap, s)}
            agentState={agentStatuses[s.id]}
            notifCount={notificationCounts[s.id] ?? 0}
            indent={0}
            borderColor={borderColor}
            onBorderClick={
              hasChildren
                ? () => toggleCollapsed(nodeName.toLowerCase())
                : undefined
            }
            paddingLeftOverride={rowPaddingLeft}
            draggable
            onDragStart={(e, _idx, pane) => {
              hierDrag.current = { group: groupKey, idx: indexInGroup };
              // Carry the pane so it can be dropped into the dockview layout as a
              // tab/split (same as flat view). In-sidebar reorder uses the
              // hierDrag ref above, so it's unaffected by the data type.
              e.dataTransfer.setData(DRAG_TYPE, encodeDragData({ pane }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (hierDrag.current?.group === groupKey) {
                e.preventDefault();
                setHierDropTarget({ group: groupKey, idx: indexInGroup });
              }
            }}
            onDrop={() => {
              if (
                hierDrag.current &&
                hierDrag.current.group === groupKey &&
                hierDrag.current.idx !== indexInGroup
              ) {
                onReorder(groupKey, hierDrag.current.idx, indexInGroup);
              }
              hierDrag.current = null;
              setHierDropTarget(null);
            }}
            onDragEnd={() => {
              hierDrag.current = null;
              setHierDropTarget(null);
            }}
            onClick={() => {
              const pane: ActivePane = { type: "session", id: s.id };
              switchPane(pane);
              focusTerminal(pane.id);
              if (notificationCounts[s.id]) markNotificationsRead(s.id);
            }}
          />
        </div>
      ) : (
        /* Exited / no live session — borderless wrapper for correct guide alignment */
        <div className="relative">
          {treeGuides}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: non-critical stopped row */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: non-critical stopped row */}
          <div
            className={`flex items-center gap-1.5 py-1${hasChildren ? " cursor-pointer" : ""}`}
            style={{
              borderLeft: `3px solid ${borderColor ?? "transparent"}`,
              paddingLeft: `${rowPaddingLeft}px`,
              paddingRight: "12px",
              opacity: 0.4,
            }}
            onClick={
              hasChildren
                ? () => toggleCollapsed(nodeName.toLowerCase())
                : undefined
            }
          >
            <AgentStatusIcon status="stopped" size={14} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="flex-1 truncate text-xs">{node.org.name}</span>
                <span
                  className="shrink-0 text-[10px]"
                  style={{ color: page.statusFg }}
                >
                  stopped
                </span>
              </div>
              {node.org.template && (
                <div className="text-[10px]" style={{ color: page.statusFg }}>
                  {node.org.template}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Children (if expanded) */}
      {hasChildren &&
        !isCollapsed &&
        node.children.map((child, idx) => (
          <HierarchyNodeRow
            key={child.org.name ?? child.org.claudeSessionId ?? `child-${idx}`}
            node={child}
            depth={depth + 1}
            groupKey={nodeName.toLowerCase()}
            indexInGroup={idx}
            isLastChild={idx === node.children.length - 1}
            ancestorIsLast={[...ancestorIsLast, isLastChild]}
            page={page}
            isPaneActive={isPaneActive}
            visiblePaneIds={visiblePaneIds}
            sessionMetaMap={sessionMetaMap}
            agentStatuses={agentStatuses}
            notificationCounts={notificationCounts}
            collapsedGroups={collapsedGroups}
            toggleCollapsed={toggleCollapsed}
            switchPane={switchPane}
            markNotificationsRead={markNotificationsRead}
            onReorder={onReorder}
            hierDrag={hierDrag}
            hierDropTarget={hierDropTarget}
            setHierDropTarget={setHierDropTarget}
          />
        ))}
    </>
  );
}

// ── Project item ────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: ProjectInfo;
  page: PageTheme;
  liveSessionIds: Set<string>;
}

const ProjectItem = React.memo(function ProjectItem({
  project,
  page,
  liveSessionIds,
}: ProjectItemProps) {
  const resumeSession = useStore((s) => s.resumeSession);
  const createSession = useStore((s) => s.createSession);
  const status = useStore((s) => s.status);
  const isBusy = status === "resuming..." || status === "spawning...";

  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="group flex items-center">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 px-3 py-1.5 cursor-pointer text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          <span
            className="text-[10px] shrink-0"
            style={{ color: page.statusFg }}
          >
            {expanded ? "▼" : "▶"}
          </span>
          <span className="flex-1 truncate text-xs font-medium">
            {project.name}
          </span>
          <span
            className="shrink-0 text-[10px]"
            style={{ color: page.statusFg }}
          >
            {project.sessions.length}
          </span>
        </button>
        <button
          type="button"
          disabled={isBusy}
          className="shrink-0 rounded px-1.5 mr-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer disabled:opacity-50"
          style={{ color: "#238636" }}
          title={`New session in ${project.name}`}
          // Fire-and-forget: spawnSession now throws on failure (so panels with
          // an error UI can show the reason) and already records it in `status`.
          // This quick-spawn button has no inline error surface, so swallow the
          // rejection here only to keep it from becoming unhandled.
          onClick={() => {
            createSession(project.path).catch(() => {});
          }}
        >
          +
        </button>
      </div>

      {expanded && (
        <div className="pl-4">
          {project.sessions.map((s) => {
            const isLive = liveSessionIds.has(s.sessionId);
            const isExited = s.autonomosStatus === "exited" && !isLive;

            let dotColor = "transparent";
            let tooltip = "Resume this session";
            if (isLive) {
              dotColor = "#238636";
              tooltip = "Switch to live session";
            } else if (isExited) {
              dotColor = "#848d97";
              tooltip = "Resume autonomOS agent with full config";
            }

            return (
              <button
                type="button"
                key={s.sessionId}
                disabled={isBusy}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-xs text-left cursor-pointer hover:opacity-80 disabled:opacity-50"
                style={{
                  color: page.fg,
                  opacity: isExited ? 0.6 : 1,
                }}
                onClick={() => {
                  // Fire-and-forget; spawnSession now throws on failure and
                  // records it in `status`. Swallow here (no inline error UI on
                  // this row) only to avoid an unhandled rejection.
                  resumeSession(s.sessionId, project.path, s.summary, {
                    isAutonomosAgent: s.isAutonomosAgent,
                  }).catch(() => {});
                }}
                title={tooltip}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full mt-1"
                  style={{ background: dotColor }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <p className="truncate flex-1">{s.summary}</p>
                    {isExited && (
                      <span
                        className="shrink-0 text-[10px]"
                        title={`autonomOS agent${s.template ? ` (${s.template})` : ""}`}
                      >
                        stopped
                      </span>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 mt-0.5"
                    style={{ color: page.statusFg }}
                  >
                    {s.isAutonomosAgent && (
                      <span className="text-[10px]">
                        {s.template ?? "agent"}
                      </span>
                    )}
                    {s.gitBranch && (
                      <span className="text-[10px] truncate max-w-[120px]">
                        {s.gitBranch}
                      </span>
                    )}
                    <span className="text-[10px]">
                      {formatAge(s.lastModified)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

function formatAge(timestamp: number): string {
  // Guard against missing/NaN/negative timestamps — a pre-schema record with
  // neither exitedAt nor updatedAt would otherwise render as "NaNd".
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return "now"; // clock skew — display cleanly
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
