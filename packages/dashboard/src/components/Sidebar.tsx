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
import { AgentContextMenu, type AgentMenuTarget } from "./AgentContextMenu";
import { Codicon } from "./Codicon";
import { hierDropIndex, reorderLiveInFullOrder } from "./hierarchyReorder";
import {
  mergeOrgWithSessions,
  type SidebarHierarchyNode,
} from "./mergeOrgWithSessions";
import { isLightBg, recencyTimestampStyle } from "./recency";
import { dropEdgeAt, flatDropIndex, insertionBoundary } from "./sidebarReorder";
import {
  arrowForRow,
  digitForRow,
  flattenHierarchyRows,
} from "./sidebarRowOrder";
import { statusLabelStyle } from "./statusLabelStyle";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";
import { ProviderAgentIcon } from "./ui/provider-icon";

/**
 * Edge auto-scroll during a drag. Native HTML5 DnD gives none, so we hand-roll
 * it: while dragging near the top/bottom edge of the scroll container, scroll it
 * on a rAF loop with a velocity that ramps up toward the edge. `onDragOver` is
 * fed the pointer Y each dragover; `stop` is called on drop/end/leave.
 */
function useDragAutoScroll(ref: React.RefObject<HTMLElement | null>) {
  const rafRef = useRef<number | null>(null);
  const velRef = useRef(0);
  const loop = useCallback(() => {
    const el = ref.current;
    if (el && velRef.current !== 0) {
      el.scrollTop += velRef.current;
      rafRef.current = requestAnimationFrame(loop);
    } else {
      rafRef.current = null;
    }
  }, [ref]);
  const onDragOver = useCallback(
    (clientY: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const EDGE = 48;
      const MAX = 14;
      let v = 0;
      if (clientY < r.top + EDGE) {
        v = -Math.ceil(((r.top + EDGE - clientY) / EDGE) * MAX);
      } else if (clientY > r.bottom - EDGE) {
        v = Math.ceil(((clientY - (r.bottom - EDGE)) / EDGE) * MAX);
      }
      velRef.current = v;
      if (v !== 0 && rafRef.current == null) {
        rafRef.current = requestAnimationFrame(loop);
      }
    },
    [ref, loop],
  );
  const stop = useCallback(() => {
    velRef.current = 0;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);
  return { onDragOver, stop };
}

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
    reorderFlat,
    pinAgent,
    unpinAgent,
  } = useSidebarActions();
  const page = THEMES[theme].page;
  // Theme accent (gold) + icon style — for the slide-apart ghost preview row,
  // which is rendered outside SessionRow (where these are read per-row).
  const accent = THEMES[theme].terminal.yellow;
  const agentIconStyle = useStore((s) => s.agentIconStyle);

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
  // Row context menu (ADR-093). One menu at a time; opened by right-click on a
  // SessionRow (running) or an exited Projects-panel row. Positioned at the
  // pointer, dismissed via the escape stack / click-away inside the component.
  const [agentMenu, setAgentMenu] = useState<{
    target: AgentMenuTarget;
    x: number;
    y: number;
  } | null>(null);
  const openAgentMenu = useCallback(
    (e: React.MouseEvent, target: AgentMenuTarget) => {
      e.preventDefault();
      setAgentMenu({ target, x: e.clientX, y: e.clientY });
    },
    [],
  );
  // Stable identity: the menu registers this on the ADR-065 escape stack keyed
  // by [onClose], so a fresh function each Sidebar render would churn the
  // registration and could invert the LIFO order against another open overlay.
  const closeAgentMenu = useCallback(() => setAgentMenu(null), []);
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
    edge: "above" | "below";
  } | null>(null);
  // FREEZE the tree at hier drag-start so live polls can't shift rows mid-drag.
  const [frozenTree, setFrozenTree] = useState<SidebarHierarchyNode[] | null>(
    null,
  );

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
  // `edge` = which side of the hovered row's midpoint the cursor is on. The gold
  // insertion line is drawn at that edge AND the commit lands there — same math,
  // so the indicator and the result agree (fixes the old top-edge-vs-splice
  // off-by-one on downward drags).
  const [dropTarget, setDropTarget] = useState<{
    section: FlatSection;
    idx: number;
    edge: "above" | "below";
  } | null>(null);
  // FREEZE: snapshot the section order at drag-start so a live poll tick can't
  // shift rows under the cursor mid-drag (FM-3).
  const [frozenFlat, setFrozenFlat] = useState<{
    pinned: SessionInfo[];
    unpinned: SessionInfo[];
  } | null>(null);
  // Measured row height (px), captured from the dragged row's rect at drag-start,
  // so the slide-apart GAP + ghost-preview match the real row height exactly
  // (rows vary — a row with a meta line is taller). Falls back if the rect is 0
  // (jsdom). Shared by both views.
  const [dragRowHeight, setDragRowHeight] = useState(DRAG_ROW_HEIGHT_FALLBACK);
  const asideRef = useRef<HTMLElement | null>(null);
  const flatAutoScroll = useDragAutoScroll(asideRef);
  const hierAutoScroll = useDragAutoScroll(asideRef);

  function handleDragStart(
    e: React.DragEvent,
    section: FlatSection,
    idx: number,
    pane: ActivePane,
  ) {
    dragRef.current = { section, idx };
    setFrozenFlat(flatSections);
    setDragRowHeight(
      e.currentTarget.getBoundingClientRect().height ||
        DRAG_ROW_HEIGHT_FALLBACK,
    );
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
    const edge = dropEdgeAt(e.clientY, e.currentTarget.getBoundingClientRect());
    setDropTarget({ section, idx, edge });
    // Auto-scroll is fed once, from the <aside> onDragOver (single source) — so
    // it keeps working even when the cursor is over the pointerEvents:none ghost,
    // where this per-row handler never fires.
  }

  function endFlatDrag() {
    dragRef.current = null;
    setDropTarget(null);
    setFrozenFlat(null);
    flatAutoScroll.stop();
  }

  function endHierDrag() {
    hierDrag.current = null;
    setFrozenTree(null);
    setHierDropTarget(null);
    hierAutoScroll.stop();
  }

  // Commit the flat reorder from the current drag + drop-target STATE (not from
  // an event target). The single drop authority is the <aside> onDrop, which
  // fires for a release on a row OR in the opened gap — the slide-apart ghost
  // has pointerEvents:none, so an upper-half hover drops through it and the drop
  // lands on the container, not the row (nox 🔴). Commit is by KEY so a mid-drag
  // arrival can't shift the landing slot (nox Thread-0): resolve the frozen
  // dragKey + the key it lands BEFORE against the live list.
  function commitFlatFromState() {
    const d = dragRef.current;
    const dt = dropTarget;
    if (!d || !dt || dt.section !== d.section) return;
    const rows = flatView[d.section];
    const to = flatDropIndex(d.idx, dt.idx, dt.edge);
    if (to === null) return; // no-op — landing back at origin
    const dragKey = sessionOrderKey(rows[d.idx]);
    const postRemoval = rows.filter((_, i) => i !== d.idx);
    const beforeKey =
      to < postRemoval.length ? sessionOrderKey(postRemoval[to]) : null;
    reorderFlat(d.section, dragKey, beforeKey);
  }

  function commitHierFromState() {
    const d = hierDrag.current;
    const dt = hierDropTarget;
    if (!d || !dt || dt.group !== d.group) return;
    const to = hierDropIndex(d.idx, dt.idx, dt.edge);
    if (to !== null) commitHierReorder(d.group, d.idx, to);
  }

  // Commit a hierarchy sibling reorder BY NAME within the full persisted order,
  // so a stopped sibling holding a slot doesn't move the wrong agent (nox
  // Thread-1). `from`/`to` are LIVE-sibling indices (the tree is pruned,
  // hideStopped=true) resolved against `hierarchyOrder[gk]` which may keep
  // stopped names. Hoisted from the inline onReorder so the <aside> drop
  // authority can reach it too.
  function commitHierReorder(gk: string, from: number, to: number) {
    const liveSibs =
      gk === "__root__"
        ? (frozenTree ?? hierarchyTree).map((n) =>
            (n.org.name ?? "").toLowerCase(),
          )
        : (() => {
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
            return findChildren(frozenTree ?? hierarchyTree) ?? [];
          })();
    const existing = hierarchyOrder[gk];
    const full = existing && existing.length > 0 ? existing : liveSibs;
    const next = reorderLiveInFullOrder(full, liveSibs, from, to);
    useStore.setState((prev) => ({
      hierarchyOrder: { ...prev.hierarchyOrder, [gk]: next },
    }));
  }

  function isPaneActive(pane: ActivePane): boolean {
    if (!activePane) return false;
    return activePane.type === pane.type && activePane.id === pane.id;
  }

  // Render one flat-view row within a given section. Drag handlers are bound to
  // the section so reordering stays section-local; the pin/unpin button is the
  // only way to cross sections.
  // The flat drag geometry for a section, derived once per render from the drag
  // refs + the hovered drop target. `boundary` is the gap slot (null unless the
  // hover is a real move — a no-op hover on the row's own slot opens nothing);
  // `origin` is the dragged row's index (dimmed). Rows at/below `boundary` slide
  // down by one row height. Reads the frozen snapshot's section, so the geometry
  // matches exactly what's on screen (FM-3 freeze).
  function flatDragGeom(section: FlatSection): {
    boundary: number | null;
    origin: number | null;
    // The hover currently resolves to the dragged row's OWN slot (a no-op): no
    // gap opens, so the origin row itself shows the dashed preview (ADR-095).
    originIsTarget: boolean;
    dragged: SessionInfo | null;
  } {
    const rows = section === "pinned" ? flatView.pinned : flatView.unpinned;
    const d = dragRef.current;
    const active =
      frozenFlat != null &&
      d?.section === section &&
      dropTarget?.section === section;
    if (!active || !d)
      return {
        boundary: null,
        origin: null,
        originIsTarget: false,
        dragged: null,
      };
    // flatDropIndex returns null IFF the drop lands back at `from` (to === from),
    // so `!committing` means exactly "the hover lands the row at its own slot."
    const committing =
      flatDropIndex(d.idx, dropTarget.idx, dropTarget.edge) !== null;
    return {
      boundary: committing
        ? insertionBoundary(dropTarget.idx, dropTarget.edge)
        : null,
      origin: d.idx,
      originIsTarget: !committing,
      dragged: rows[d.idx] ?? null,
    };
  }

  function renderFlatItem(
    session: SessionInfo,
    section: FlatSection,
    idx: number,
  ) {
    const { origin, originIsTarget } = flatDragGeom(section);
    const isDragOrigin = origin === idx;
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
        isDragOrigin={isDragOrigin}
        isDropLandingHere={isDragOrigin && originIsTarget}
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
        onDragEnd={endFlatDrag}
        onClick={() => {
          switchPane(pane);
          focusTerminal(session.id);
          if (notificationCounts[session.id]) markNotificationsRead(session.id);
        }}
        onContextMenu={(e) => openAgentMenu(e, runningTarget(session))}
      />
    );
  }

  // Render a flat section's rows, splicing the slide-apart ghost preview into the
  // gap at the drag boundary. The ghost sits at DOM index `boundary`, so the rows
  // that shifted down by `slideY` leave exactly its slot open (ADR-095).
  function renderFlatSection(section: FlatSection, rows: SessionInfo[]) {
    const { boundary, dragged } = flatDragGeom(section);
    const out: React.ReactNode[] = [];
    rows.forEach((session, idx) => {
      if (boundary === idx && dragged)
        out.push(renderFlatGhost(section, dragged));
      out.push(renderFlatItem(session, section, idx));
    });
    if (boundary === rows.length && dragged)
      out.push(renderFlatGhost(section, dragged));
    return out;
  }

  function renderFlatGhost(section: FlatSection, dragged: SessionInfo) {
    return (
      <DragGhostRow
        key={`ghost-${section}`}
        session={dragged}
        status={(agentStatuses[dragged.id]?.status as AgentStatus) ?? "unknown"}
        agentIconStyle={agentIconStyle}
        page={page}
        accent={accent}
        height={dragRowHeight}
        paddingLeft={9}
      />
    );
  }

  // During a drag, render the sections from the FROZEN snapshot so live polls
  // can't shift rows under the cursor (FM-3). The published row order (ADR-066)
  // stays live — only the drag view freezes.
  const flatView = frozenFlat ?? flatSections;

  return (
    <>
      <aside
        ref={asideRef}
        className="absolute inset-y-0 left-0 z-20 flex shrink-0 flex-col overflow-y-auto md:relative"
        onDragOver={(e) => {
          // SINGLE drop authority for reorder. The slide-apart ghost sets
          // pointerEvents:none, so an upper-half hover leaves the cursor over the
          // ghost/gap where per-row dragover no longer fires; without a
          // preventDefault here the browser sets dropEffect=none and suppresses
          // the drop, silently cancelling the reorder at exactly the spot the gap
          // invites (nox 🔴). Also the one place auto-scroll is fed, so it keeps
          // running over the ghost too. Per-row dragover still owns the edge /
          // dropTarget math; this only keeps the whole sidebar droppable.
          if (dragRef.current) {
            e.preventDefault();
            flatAutoScroll.onDragOver(e.clientY);
          } else if (hierDrag.current) {
            e.preventDefault();
            hierAutoScroll.onDragOver(e.clientY);
          }
        }}
        onDrop={(e) => {
          // Commit from the already-correct dropTarget/hierDropTarget STATE, so a
          // release on a row OR in the opened gap lands identically.
          if (dragRef.current) {
            e.preventDefault();
            commitFlatFromState();
            endFlatDrag();
          } else if (hierDrag.current) {
            e.preventDefault();
            commitHierFromState();
            endHierDrag();
          }
        }}
        onDragLeave={(e) => {
          // Left the sidebar entirely (e.g. dragging a row body toward the
          // terminal to open a tab/split): clear the slide-apart gap + ghost and
          // STOP auto-scroll so it doesn't run away while the drag sits over the
          // dockview area. dragleave also fires crossing between children, and
          // `relatedTarget` is null on drag events in Chrome, so use a geometry
          // test — clear only when the pointer is genuinely outside the box.
          const r = e.currentTarget.getBoundingClientRect();
          const outside =
            e.clientX < r.left ||
            e.clientX >= r.right ||
            e.clientY < r.top ||
            e.clientY >= r.bottom;
          if (outside) {
            setDropTarget(null);
            setHierDropTarget(null);
            flatAutoScroll.stop();
            hierAutoScroll.stop();
          }
        }}
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
            {flatView.pinned.length === 0 && flatView.unpinned.length === 0 && (
              <p
                className="px-3 py-3 text-center text-xs"
                style={{ color: page.statusFg }}
              >
                No active agents
              </p>
            )}

            {renderFlatSection("pinned", flatView.pinned)}

            {/* Divider — only between two non-empty sections (no dangling line). */}
            {flatView.pinned.length > 0 && flatView.unpinned.length > 0 && (
              <div
                data-testid="flat-section-divider"
                className="mx-3 my-1.5"
                style={{
                  height: 1,
                  background: page.statusFg,
                  opacity: 0.25,
                }}
                aria-hidden="true"
              />
            )}

            {renderFlatSection("unpinned", flatView.unpinned)}
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
              (() => {
                const rootNodes = frozenTree ?? hierarchyTree;
                const geom = hierGroupGeom(
                  "__root__",
                  rootNodes,
                  hierDrag.current,
                  hierDropTarget,
                );
                const ghost = geom.dragged ? (
                  <HierGhost
                    key="hghost-__root__"
                    node={geom.dragged}
                    depth={0}
                    page={page}
                    accent={accent}
                    agentIconStyle={agentIconStyle}
                    agentStatuses={agentStatuses}
                    height={dragRowHeight}
                  />
                ) : null;
                const out: React.ReactNode[] = [];
                rootNodes.forEach((node, idx, arr) => {
                  if (geom.boundary === idx && ghost) out.push(ghost);
                  out.push(
                    <HierarchyNodeRow
                      key={
                        node.org.name ??
                        node.org.claudeSessionId ??
                        `node-${idx}`
                      }
                      node={node}
                      depth={0}
                      groupKey="__root__"
                      indexInGroup={idx}
                      isLastChild={idx === arr.length - 1}
                      ancestorIsLast={[]}
                      isDragOrigin={geom.origin === idx}
                      isDropLandingHere={
                        geom.origin === idx && geom.originIsTarget
                      }
                      page={page}
                      accent={accent}
                      agentIconStyle={agentIconStyle}
                      dragRowHeight={dragRowHeight}
                      isPaneActive={isPaneActive}
                      visiblePaneIds={visiblePaneIds}
                      sessionMetaMap={sessionMetaMap}
                      agentStatuses={agentStatuses}
                      notificationCounts={notificationCounts}
                      collapsedGroups={collapsedGroups}
                      toggleCollapsed={toggleCollapsed}
                      switchPane={switchPane}
                      markNotificationsRead={markNotificationsRead}
                      openAgentMenu={openAgentMenu}
                      hierDrag={hierDrag}
                      hierDropTarget={hierDropTarget}
                      setHierDropTarget={setHierDropTarget}
                      onHierDragStart={() => setFrozenTree(hierarchyTree)}
                      onHierDragEnd={endHierDrag}
                      hierAutoScroll={hierAutoScroll}
                    />,
                  );
                });
                if (geom.boundary === rootNodes.length && ghost)
                  out.push(ghost);
                return out;
              })()}
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
              onAgentContextMenu={openAgentMenu}
            />
          ))}
        </div>
      </aside>
      {agentMenu && (
        <AgentContextMenu
          target={agentMenu.target}
          x={agentMenu.x}
          y={agentMenu.y}
          page={page}
          onClose={closeAgentMenu}
        />
      )}
    </>
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
  /** This row is the drag source — dim it while it's being moved (the vivid
   *  copy is the ghost preview in the opened gap; ADR-095). */
  isDragOrigin?: boolean;
  /** This row is the drag source AND the current hover lands it back at its own
   *  slot (a no-op). No gap opens there, so the row ITSELF takes the dashed-ghost
   *  preview styling — so there is always exactly one dashed "will land here"
   *  marker, including 'right back where it started' (ADR-095). */
  isDropLandingHere?: boolean;
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
  /** Right-click on the row. Row-scoped by design — never a document handler
   *  (xterm owns right-click inside terminal panes, ADR-072). */
  onContextMenu?: (e: React.MouseEvent) => void;
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

/** Normalize a live session into the context-menu's target shape. */
function runningTarget(s: SessionInfo): AgentMenuTarget {
  return {
    id: s.id,
    name: s.name,
    status: "running",
    manager: s.manager,
    workingDirectory: s.workingDirectory,
  };
}

function SessionRow({
  session: s,
  pane,
  idx,
  page,
  isActive,
  isVisible,
  isDragOrigin,
  isDropLandingHere,
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
  onContextMenu,
}: SessionRowProps) {
  // Prefer the persisted activity timestamp (hook/turn-driven; upgrade-proof)
  // over the CC transcript mtime — a resumed CC process touches its JSONL at
  // boot, which is exactly the "every session shows 1m after upgrade" bug.
  const lastActive = s.lastActivityAt ?? meta?.lastModified ?? s.createdAt;
  const paddingLeft = paddingLeftOverride ?? 9 + indent * 10;
  const agentIconStyle = useStore((st) => st.agentIconStyle);
  const status = (agentState?.status as AgentStatus) ?? "unknown";
  const isLightTheme = isLightBg(page.bg);
  const labelStyle = statusLabelStyle(status, isLightTheme);
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
      data-session-id={s.id}
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
        borderRadius: isDropLandingHere || highlight ? "5px" : undefined,
        background: isDropLandingHere
          ? `${accent}1f`
          : highlight
            ? highlight.background
            : "transparent",
        boxShadow: isDropLandingHere ? undefined : highlight?.boxShadow,
        // Affordance continuity (ADR-095): when the hover lands the row back at
        // its own slot no gap opens, so the row ITSELF becomes the preview —
        // dashed outline + fill matching DragGhostRow, at full opacity — so there
        // is always exactly one dashed "will land here" marker, including 'right
        // back where it started.' An outline (not a border) draws inside the box
        // with no reflow and coexists with the 3px tree borderLeft.
        outline: isDropLandingHere ? `1px dashed ${accent}aa` : undefined,
        outlineOffset: isDropLandingHere ? -1 : undefined,
        // Slide-apart origin dim: when dragged AWAY, the source fades in place
        // while its vivid copy is the ghost preview in the opened gap. Visual
        // only — the commit math is untouched.
        opacity: isDragOrigin && !isDropLandingHere ? 0.4 : undefined,
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
          {/* Hand-off pending badge (ADR-094): messages queued for human
              hand-delivery to this manual-queue (Gemini) agent. Gold accent
              (theme yellow), NOT a status color — independent of the status
              dot/label, like the env-preset pill. Absent when the queue is
              empty. The overlay itself lives in the terminal pane. */}
          {(s.pendingHandoffCount ?? 0) > 0 && (
            <span
              className="shrink-0 text-[10px] font-semibold leading-[14px]"
              style={{
                color: "#e6b450",
                border: "1px solid #e6b450",
                background: "#e6b4501f",
                borderRadius: 999,
                padding: "0 5px",
              }}
              title={`${s.pendingHandoffCount} awaiting your delivery`}
            >
              ✉ {s.pendingHandoffCount}
            </span>
          )}
          {/* Recency treatment (B2 — timestamp-only fade): the AGE TEXT fades
              with age so wildly-stale sessions recede. The unread prefix stays
              full-strength (an attention signal, like the status dot/label) —
              only the formatAge() text is wrapped in the faded span. Computed
              from the same lastActive the text renders from, so it rides the
              sidebar's existing ~5s render cadence — no new timer. */}
          <span
            className="shrink-0 text-[10px]"
            style={{ color: page.statusFg }}
          >
            {notifCount > 0 && (
              <span style={{ color: "#ea6c73" }}>{notifCount} unread · </span>
            )}
            <span
              style={recencyTimestampStyle(
                lastActive,
                Date.now(),
                page.statusFg,
                page.fg,
                page.bg,
              )}
            >
              {formatAge(lastActive)}
            </span>
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
              repo text and the pill on narrow rows. Muted-accent color per
              status (theme-aware); active-work statuses shimmer via the
              theme-appropriate CSS class (the inline color is skipped so the
              class wins). */}
          {agentState?.status && agentState.status !== "unknown" && (
            <span
              className={`ml-auto min-w-0 truncate pl-1.5${
                labelStyle.shimmer
                  ? isLightTheme
                    ? " status-shimmer-light"
                    : " status-shimmer"
                  : ""
              }`}
              style={
                labelStyle.shimmer ? undefined : { color: labelStyle.color }
              }
            >
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
  /** This node is the drag source — dim its row (slide-apart, ADR-095). */
  isDragOrigin?: boolean;
  /** Drag source AND the hover lands it back at its own slot — the row itself
   *  shows the dashed preview instead of a gap (ADR-095). */
  isDropLandingHere?: boolean;
  page: PageTheme;
  /** Theme accent (gold) + icon style + measured row height — for the ghost
   *  preview this node renders in its OWN children group's gap. */
  accent: string;
  agentIconStyle: "provider" | "status";
  dragRowHeight: number;
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
  openAgentMenu: (e: React.MouseEvent, target: AgentMenuTarget) => void;
  /** Shared drag state across all hierarchy rows */
  hierDrag: React.MutableRefObject<{ group: string; idx: number } | null>;
  hierDropTarget: {
    group: string;
    idx: number;
    edge: "above" | "below";
  } | null;
  setHierDropTarget: (
    v: { group: string; idx: number; edge: "above" | "below" } | null,
  ) => void;
  /** Snapshot the live tree at drag-start so polls can't shift rows mid-drag. */
  onHierDragStart: () => void;
  /** Clear the freeze + drop indicator + auto-scroll at drag-end. */
  onHierDragEnd: () => void;
  /** Edge auto-scroll driver (shared with the flat view). */
  hierAutoScroll: { onDragOver: (clientY: number) => void; stop: () => void };
}

// ── Tree-line geometry ──────────────────────────────────────────────────
//
// Guide lines at each depth are aligned with the parent row's status icon
// center. This means guideX is computed recursively from the parent's
// actual content position rather than a fixed linear formula.
//
//   SessionRow layout:  [3px border] [paddingLeft ...] [14px icon] [content]
//   Icon center = 3 + paddingLeft + 7

/** Fallback slide-apart row height (px) when a rect measures 0 (jsdom). Matches
 *  a real single-line SessionRow: py-1 (8) + ~14/16px icon-line + border ≈ 39. */
const DRAG_ROW_HEIGHT_FALLBACK = 39;

/**
 * The slide-apart PREVIEW row (ADR-095, replacing the gold insertion line). A
 * ghost of the agent being dragged, shown in the gap that opens at the insertion
 * boundary — "preview the agent row in between the place to be inserted." It is a
 * real-height element spliced into the list at the boundary, so ordinary layout
 * flow pushes every following row (and, in the tree, its whole subtree) down by
 * one row — the "push the other sessions away." Its height animates 0 → measured
 * row height on mount, so that reflow is a smooth open rather than a jump.
 * Purely presentational — pointer-events off, aria-hidden.
 */
function DragGhostRow({
  session,
  status,
  agentIconStyle,
  page,
  accent,
  height,
  paddingLeft,
}: {
  session: SessionInfo;
  status: AgentStatus;
  agentIconStyle: "provider" | "status";
  page: PageTheme;
  accent: string;
  height: number;
  paddingLeft: number;
}) {
  // Grow the gap on first mount (0 → height): the surrounding rows reflow with
  // it, so the gap opens smoothly. A stable key keeps ONE instance as the drag
  // moves, so it doesn't re-grow on every boundary step.
  const [h, setH] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setH(height));
    return () => cancelAnimationFrame(raf);
  }, [height]);

  return (
    <div
      data-testid="drag-ghost-row"
      aria-hidden="true"
      className="flex items-center gap-1.5"
      style={{
        height: h,
        overflow: "hidden",
        boxSizing: "border-box",
        paddingLeft: `${paddingLeft}px`,
        paddingRight: "12px",
        borderRadius: 5,
        border: `1px dashed ${accent}aa`,
        background: `${accent}1f`,
        opacity: h ? 1 : 0,
        pointerEvents: "none",
        transition: "height 140ms ease-out, opacity 140ms ease-out",
      }}
    >
      {agentIconStyle === "provider" ? (
        <ProviderAgentIcon
          provider={session.provider}
          status={status}
          size={16}
        />
      ) : (
        <AgentStatusIcon status={status} size={14} />
      )}
      <span className="flex-1 truncate text-xs" style={{ color: page.fg }}>
        {session.name}
      </span>
    </div>
  );
}

/**
 * Slide-apart geometry for one hierarchy sibling group (shared by the root map
 * and the recursive children map). `boundary` is the gap slot (null unless the
 * hover is a real move; a no-op hover on the row's own slot opens nothing),
 * `origin` the dragged sibling's index (dimmed), `dragged` the node to preview.
 * Same `insertionBoundary`/`hierDropIndex` the commit uses, so the opened gap is
 * exactly where the drop lands (indicated == committed).
 */
function hierGroupGeom(
  groupKey: string,
  siblings: SidebarHierarchyNode[],
  drag: { group: string; idx: number } | null,
  drop: { group: string; idx: number; edge: "above" | "below" } | null,
): {
  boundary: number | null;
  origin: number | null;
  // Hover resolves to the dragged sibling's OWN slot (a no-op) — the origin row
  // itself shows the dashed preview instead of a gap (ADR-095).
  originIsTarget: boolean;
  dragged: SidebarHierarchyNode | null;
} {
  if (!drag || drag.group !== groupKey || drop?.group !== groupKey)
    return {
      boundary: null,
      origin: null,
      originIsTarget: false,
      dragged: null,
    };
  // hierDropIndex returns null IFF the drop lands back at `from`, so `!committing`
  // means exactly "the hover lands the sibling at its own slot."
  const committing = hierDropIndex(drag.idx, drop.idx, drop.edge) !== null;
  return {
    boundary: committing ? insertionBoundary(drop.idx, drop.edge) : null,
    origin: drag.idx,
    originIsTarget: !committing,
    dragged: siblings[drag.idx] ?? null,
  };
}

/** The slide-apart ghost preview for a hierarchy sibling, indented to its depth
 *  so it lines up with the group whose gap it fills. */
function HierGhost({
  node,
  depth,
  page,
  accent,
  agentIconStyle,
  agentStatuses,
  height,
}: {
  node: SidebarHierarchyNode;
  depth: number;
  page: PageTheme;
  accent: string;
  agentIconStyle: "provider" | "status";
  agentStatuses: Record<string, { status: string }>;
  height: number;
}) {
  const s = node.session;
  if (!s) return null;
  return (
    <DragGhostRow
      session={s}
      status={(agentStatuses[s.id]?.status as AgentStatus) ?? "unknown"}
      agentIconStyle={agentIconStyle}
      page={page}
      accent={accent}
      height={height}
      paddingLeft={depth > 0 ? treePaddingLeft(depth) : 9}
    />
  );
}

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
  isDragOrigin,
  isDropLandingHere,
  page,
  accent,
  agentIconStyle,
  dragRowHeight,
  isPaneActive,
  visiblePaneIds,
  sessionMetaMap,
  agentStatuses,
  notificationCounts,
  collapsedGroups,
  toggleCollapsed,
  switchPane,
  markNotificationsRead,
  openAgentMenu,
  hierDrag,
  hierDropTarget,
  setHierDropTarget,
  onHierDragStart,
  onHierDragEnd,
  hierAutoScroll,
}: HierarchyNodeRowProps) {
  const s = node.session; // may be undefined for exited agents
  const nodeName = node.org.name ?? "";
  const isCollapsed = collapsedGroups.has(nodeName.toLowerCase());
  const hasChildren = node.children.length > 0;

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
            isDragOrigin={isDragOrigin}
            isDropLandingHere={isDropLandingHere}
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
              onHierDragStart(); // freeze the tree so polls can't shift rows
              // Carry the pane so it can be dropped into the dockview layout as a
              // tab/split (same as flat view). In-sidebar reorder uses the
              // hierDrag ref above, so it's unaffected by the data type.
              e.dataTransfer.setData(DRAG_TYPE, encodeDragData({ pane }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              // Only a same-parent drag reorders (re-parent is out of scope).
              // Auto-scroll is fed once from the <aside> (single source); this
              // handler only owns the edge / hierDropTarget math. The commit is
              // the <aside> onDrop, so the opened gap is droppable (nox 🔴).
              if (hierDrag.current?.group === groupKey) {
                e.preventDefault();
                const edge = dropEdgeAt(
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
                setHierDropTarget({ group: groupKey, idx: indexInGroup, edge });
              }
            }}
            onDragEnd={() => {
              // A drag that ends outside the sidebar (drag-into-dockview) or is
              // cancelled cleans up here; a real drop is committed + ended by the
              // <aside> onDrop before this fires (endHierDrag is idempotent).
              onHierDragEnd();
            }}
            onClick={() => {
              const pane: ActivePane = { type: "session", id: s.id };
              switchPane(pane);
              focusTerminal(pane.id);
              if (notificationCounts[s.id]) markNotificationsRead(s.id);
            }}
            onContextMenu={(e) => openAgentMenu(e, runningTarget(s))}
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

      {/* Children (if expanded) — with the slide-apart ghost spliced into this
          group's gap at the drag boundary (ADR-095). */}
      {hasChildren &&
        !isCollapsed &&
        (() => {
          const childGroup = nodeName.toLowerCase();
          const geom = hierGroupGeom(
            childGroup,
            node.children,
            hierDrag.current,
            hierDropTarget,
          );
          const ghost = geom.dragged ? (
            <HierGhost
              key={`hghost-${childGroup}`}
              node={geom.dragged}
              depth={depth + 1}
              page={page}
              accent={accent}
              agentIconStyle={agentIconStyle}
              agentStatuses={agentStatuses}
              height={dragRowHeight}
            />
          ) : null;
          const out: React.ReactNode[] = [];
          node.children.forEach((child, idx) => {
            if (geom.boundary === idx && ghost) out.push(ghost);
            out.push(
              <HierarchyNodeRow
                key={
                  child.org.name ?? child.org.claudeSessionId ?? `child-${idx}`
                }
                node={child}
                depth={depth + 1}
                groupKey={childGroup}
                indexInGroup={idx}
                isLastChild={idx === node.children.length - 1}
                ancestorIsLast={[...ancestorIsLast, isLastChild]}
                isDragOrigin={geom.origin === idx}
                isDropLandingHere={geom.origin === idx && geom.originIsTarget}
                page={page}
                accent={accent}
                agentIconStyle={agentIconStyle}
                dragRowHeight={dragRowHeight}
                isPaneActive={isPaneActive}
                visiblePaneIds={visiblePaneIds}
                sessionMetaMap={sessionMetaMap}
                agentStatuses={agentStatuses}
                notificationCounts={notificationCounts}
                collapsedGroups={collapsedGroups}
                toggleCollapsed={toggleCollapsed}
                switchPane={switchPane}
                markNotificationsRead={markNotificationsRead}
                openAgentMenu={openAgentMenu}
                hierDrag={hierDrag}
                hierDropTarget={hierDropTarget}
                setHierDropTarget={setHierDropTarget}
                onHierDragStart={onHierDragStart}
                onHierDragEnd={onHierDragEnd}
                hierAutoScroll={hierAutoScroll}
              />,
            );
          });
          if (geom.boundary === node.children.length && ghost) out.push(ghost);
          return out;
        })()}
    </>
  );
}

// ── Project item ────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: ProjectInfo;
  page: PageTheme;
  liveSessionIds: Set<string>;
  onAgentContextMenu: (e: React.MouseEvent, target: AgentMenuTarget) => void;
}

const ProjectItem = React.memo(function ProjectItem({
  project,
  page,
  liveSessionIds,
  onAgentContextMenu,
}: ProjectItemProps) {
  const resumeSession = useStore((s) => s.resumeSession);
  const createSession = useStore((s) => s.createSession);
  // For the row context menu: a Projects row is a session *summary* keyed by CC
  // session id, not a SessionInfo — resolve the agent record (for id-based
  // actions) from the store's live/exited lists by matching either id space.
  const sessions = useStore((s) => s.sessions);
  const exitedSessions = useStore((s) => s.exitedSessions);
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
                onContextMenu={(e) => {
                  // A Projects row is keyed by a CC/provider session id, so match
                  // that id-space FIRST — falling back to the agent-id space only
                  // if nothing matched. A blind first-match across all three
                  // spaces could resolve to a different agent whose agent id
                  // happens to equal this row's CC id, mis-targeting Delete.
                  const all = [...sessions, ...exitedSessions];
                  const rec =
                    all.find(
                      (x) =>
                        x.claudeSessionId === s.sessionId ||
                        x.providerSessionId === s.sessionId,
                    ) ?? all.find((x) => x.id === s.sessionId);
                  onAgentContextMenu(e, {
                    id: rec?.id,
                    name: rec?.name ?? s.summary,
                    status: isLive ? "running" : "exited",
                    manager: rec?.manager,
                    resumeKey: s.sessionId,
                    workingDirectory: project.path,
                    isAutonomosAgent: s.isAutonomosAgent,
                  });
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
