import "dockview-react/dist/styles/dockview.css";
import "./dockview-autonomos.css";
import {
  type DockviewApi,
  type DockviewDidDropEvent,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
} from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import {
  registerDockviewApi,
  unregisterDockviewApi,
} from "../../shortcuts/dockviewApi";
import { type ActivePane, THEMES, type ThemeName, useStore } from "../../store";
import { DRAG_TYPE, decodeDragData } from "../DragContext";
import { PaneContent, type PaneParams } from "./PaneContent";
import { paneFromPanel, SINGLETON_TYPES } from "./paneId";
import { StatusTab } from "./StatusTab";

/** dockview drop Position → addPanel Direction (inlined to avoid importing from
 *  the transitive `dockview` package). */
const POSITION_TO_DIRECTION = {
  center: "within",
  top: "above",
  bottom: "below",
  left: "left",
  right: "right",
} as const;

/**
 * dockview v7 selects its palette via the `theme` prop (a DockviewTheme whose
 * `className` carries the `--dv-*` variable values). With no theme it defaults
 * to `abyss` — a blue-tinted palette. We instead use `dockview-theme-dark` for
 * structure plus our own `autonomos-vars` class (defined in the CSS file) which
 * maps the color variables onto the `--ao-*` greyscale custom properties set
 * inline below. Result: a strictly dark/grey/white layout, no hue, on any
 * autonomOS theme (ADR-047).
 */
const AUTONOMOS_DV_THEME: DockviewTheme = {
  name: "autonomos",
  className: "dockview-theme-dark autonomos-vars",
  colorScheme: "dark",
  // Disable dockview's JS-positioned SVG active-tab underline — it re-renders on
  // focus/tab changes (appearing only once a panel is focused), which read as a
  // flickering border. Our static CSS box-shadow border is the sole indicator.
  tabGroupIndicator: "none",
};

/** Relative luminance (0–255) of a hex color. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** A pure grey `#yyyyyy` at the given luminance (0–255). */
function grey(y: number): string {
  const v = Math.max(0, Math.min(255, Math.round(y)));
  const hh = v.toString(16).padStart(2, "0");
  return `#${hh}${hh}${hh}`;
}

/** Convert a hex color to its luminance grey, so the dockview chrome carries no
 *  color tint even when the active theme's palette is tinted (e.g. midnight). */
function toGrey(hex: string): string {
  return grey(luminance(hex));
}

/** Greyscale `--ao-*` palette consumed by the `autonomos-vars` class. Derived
 *  from the active theme's luminance so it tracks dark vs light without hue. */
function dockviewThemeVars(theme: ThemeName): React.CSSProperties {
  const { page, terminal } = THEMES[theme];
  const bgY = luminance(page.bg);
  const fgY = luminance(page.fg);
  return {
    height: "100%",
    width: "100%",
    "--ao-bg": toGrey(page.bg),
    // The content-area background sits *behind* the terminal; match it to the
    // actual terminal background (not the greyscale chrome) so the terminal's
    // column-remainder + the sash region blend invisibly into it on every
    // theme (on tinted themes the greyscale bg would show as a gap).
    "--ao-term-bg": terminal.background,
    "--ao-elevated": toGrey(page.border),
    "--ao-fg": toGrey(page.fg),
    "--ao-muted": toGrey(page.statusFg),
    // Split divider: a subtle hairline ~20% of the way from background toward
    // foreground — visible enough to delineate panes, but not a bright white
    // line. The dim-inactive contrast does most of the split signalling.
    "--ao-divider": grey(bgY + (fgY - bgY) * 0.2),
    // Faint tab outline — a touch stronger than the divider so the active tab
    // (which shares the terminal background) is still legible.
    "--ao-border": grey(bgY + (fgY - bgY) * 0.32),
  } as React.CSSProperties;
}

/**
 * DockviewLayout — the dockview-react rewrite of the pane area (ADR-047),
 * the only layout engine.
 *
 * dockview OWNS the pane topology here (the ownership inversion). Clicking a
 * sidebar item just sets `activePane`; this component reacts by restoring that
 * pane's bound *workspace* (a drag-composed tab/split group, persisted via
 * dockview's toJSON) or, if it isn't in one, showing it solo. Dragging a
 * sidebar item composes a tab/split and BINDS the result into a workspace.
 * `defaultRenderer: "always"` keeps every panel's xterm mounted across tab
 * switches — the keep-alive that retires the legacy detached overlay.
 */

const COMPONENTS = { pane: PaneContent };
const TAB_COMPONENTS = { status: StatusTab };

/** A fresh workspace id. `crypto.randomUUID` needs a secure context (HTTPS or
 *  localhost); a plain-HTTP remote deploy would throw, so fall back to a
 *  collision-resistant manual id there. */
function newWorkspaceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function DockviewLayout() {
  const apiRef = useRef<DockviewApi | null>(null);
  // The active pane id we last applied to dockview — lets the activePane effect
  // skip re-syncing a pane we ourselves just activated, and breaks loops.
  const appliedActiveId = useRef<string | null>(null);
  // True while we mutate dockview programmatically (fromJSON / solo / prune) so
  // the onDidActivePanelChange writeback ignores the transient active changes
  // those operations fire — only genuine user tab clicks should write back.
  const suppressWriteback = useRef(false);
  // The pane id of the in-flight sidebar drag, captured at dragstart (the only
  // phase where dataTransfer.getData is readable — it's blocked during dragover).
  // Used to suppress the split overlay when dragging an already-open pane.
  const draggingPaneId = useRef<string | null>(null);
  // True while an INTERNAL dockview tab/group drag is in flight. dockview emits
  // many transient onDidActivePanelChange events as it tears down and rebuilds
  // groups mid-drag; mirroring each into the store walks the sidebar's active
  // highlight through them (the flicker). We gate the writeback while this is
  // set and apply only the FINAL active panel once the drag settles.
  const internalDragActive = useRef(false);
  // Guards against settling the same internal drag twice — a mouse drag fires
  // BOTH dragend and pointerup, and we only want one settle (one bindWorkspace +
  // one writeback).
  const settleScheduled = useRef(false);

  const activePane = useStore((s) => s.activePane);
  const sessions = useStore((s) => s.sessions);
  const theme = useStore((s) => s.theme);

  // Mirror the panel ids dockview is currently showing into the store so the
  // sidebar can mark on-screen rows (replaces the legacy layout-tree scan).
  const pushVisible = useCallback((api: DockviewApi) => {
    useStore.getState().setVisiblePaneIds(api.panels.map((p) => p.id));
  }, []);

  // Apply the arrangement for `pane`: restore its bound workspace (drag-composed
  // group) via fromJSON, or show it solo. fromJSON / solo re-create panels — the
  // accepted keep-alive tradeoff for workspace switching (ADR-047): terminals
  // reconnect to their PTY on remount, so no scrollback-loss beyond a reattach.
  const syncToActive = useCallback(
    (api: DockviewApi, pane: ActivePane) => {
      const st = useStore.getState();
      const wsId = st.dvPaneWorkspace[pane.id];
      const ws = wsId ? st.dvWorkspaces[wsId] : undefined;
      // merge() validates persisted paneIds, but stay defensive at the boundary.
      const desired = ws && Array.isArray(ws.paneIds) ? ws.paneIds : [pane.id];
      const current = api.panels.map((p) => p.id);
      const sameSet =
        desired.length === current.length &&
        desired.every((id) => current.includes(id));

      // Replace the whole dock with just `pane` (the solo / fallback arrangement).
      const showSolo = () => {
        for (const panel of [...api.panels]) api.removePanel(panel);
        if (!api.getPanel(pane.id)) {
          api.addPanel<PaneParams>({
            id: pane.id,
            component: "pane",
            tabComponent: "status",
            params: { pane },
          });
        }
      };

      suppressWriteback.current = true;
      try {
        if (!sameSet) {
          if (ws) {
            let restored = false;
            try {
              api.fromJSON(ws.serialized as Parameters<typeof api.fromJSON>[0]);
              restored = true;
            } catch (err) {
              // A corrupt / version-incompatible persisted layout would otherwise
              // throw on every render and blank the dashboard (no error boundary).
              // Drop the poison workspace so a reload can't re-trigger it, and
              // fall back to showing the pane solo.
              console.error(
                `[autonomOS] dockview workspace restore failed for pane ${pane.id}; dropping it and showing solo:`,
                err,
              );
              const s = useStore.getState();
              const wsMap = { ...s.dvWorkspaces };
              const paneMap = { ...s.dvPaneWorkspace };
              if (wsId) {
                for (const m of wsMap[wsId]?.paneIds ?? []) delete paneMap[m];
                delete wsMap[wsId];
              }
              s.setDvWorkspaces(wsMap, paneMap);
              showSolo();
            }
            // A stale workspace blob can re-add a since-exited agent's panel.
            // Strip dead-session panels the restore brought back — but only once
            // the real session list is known, so a cold load doesn't nuke valid
            // panes before the first fetch lands.
            if (restored && st.sessionsInitialFetchDone) {
              const live = new Set(st.sessions.map((s) => s.id));
              for (const panel of [...api.panels]) {
                const id = panel.id;
                if (!SINGLETON_TYPES.has(id) && !live.has(id))
                  api.removePanel(panel);
              }
            }
          } else {
            showSolo();
          }
        }
        api.getPanel(pane.id)?.api.setActive();
        appliedActiveId.current = pane.id;
      } catch (err) {
        // Last-ditch guard: showSolo()/setActive() throwing here would escape the
        // restore effect and (with the ErrorBoundary) force a full "reset layout"
        // screen. Instead clear the active pane so we land on the recoverable
        // empty state — the user just re-picks an agent from the sidebar.
        console.error(
          `[autonomOS] syncToActive failed for pane ${pane.id}; clearing active pane to recover:`,
          err,
        );
        useStore.getState().setActivePane(null);
      } finally {
        suppressWriteback.current = false;
      }
      pushVisible(api);
    },
    [pushVisible],
  );

  // Drop panels for sessions that no longer exist (exited / killed agents),
  // preventing ghost tabs from lingering once dockview owns the topology.
  const pruneDead = useCallback((api: DockviewApi) => {
    const st = useStore.getState();
    // Don't prune before the first real fetch lands — on cold load `sessions` is
    // briefly empty, and pruning then would nuke just-restored workspace panels
    // (their sessions aren't "live" yet) leaving a blank pane area.
    if (!st.sessionsInitialFetchDone) return;
    const live = new Set(st.sessions.map((s) => s.id));
    suppressWriteback.current = true;
    try {
      for (const panel of [...api.panels]) {
        const id = panel.id;
        if (!SINGLETON_TYPES.has(id) && !live.has(id)) api.removePanel(panel);
      }
    } finally {
      suppressWriteback.current = false;
    }
  }, []);

  // Bind whatever panes are CURRENTLY shown into a persisted workspace, so
  // clicking any member later restores the exact arrangement. Reuses an existing
  // workspace id if any current member already belongs to one (extends it), else
  // mints a fresh id. A lone pane is not a group — it dissolves any workspace its
  // panes belonged to (one pane shouldn't restore a multi-pane layout). Called
  // both after an external sidebar drop AND after an internal tab move/split, so
  // user rearrangements survive a workspace switch.
  const bindWorkspace = useCallback((api: DockviewApi) => {
    const st = useStore.getState();
    const memberIds = api.panels.map((p) => p.id);
    const workspaces = { ...st.dvWorkspaces };
    const paneWorkspace = { ...st.dvPaneWorkspace };

    if (memberIds.length <= 1) {
      for (const id of memberIds) {
        const wsId = paneWorkspace[id];
        if (!wsId) continue;
        for (const member of workspaces[wsId]?.paneIds ?? [])
          delete paneWorkspace[member];
        delete workspaces[wsId];
      }
      st.setDvWorkspaces(workspaces, paneWorkspace);
      return;
    }

    const wsId =
      memberIds.map((id) => st.dvPaneWorkspace[id]).find(Boolean) ??
      newWorkspaceId();
    workspaces[wsId] = { paneIds: memberIds, serialized: api.toJSON() };
    for (const id of memberIds) paneWorkspace[id] = wsId;
    st.setDvWorkspaces(workspaces, paneWorkspace);
  }, []);

  // Dropping a sidebar item onto the dockview area composes a tab/split, then
  // BINDS the resulting arrangement into a persisted workspace.
  const handleExternalDrop = useCallback(
    (event: DockviewDidDropEvent) => {
      const ne = event.nativeEvent;
      if (!(ne instanceof DragEvent)) return;
      const raw = ne.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      const data = decodeDragData(raw);
      if (!data) return;
      const { pane } = data;
      const api = apiRef.current;
      if (!api) return;

      // A drag can outlive the agent's exit — the sidebar only lists live agents,
      // but the payload is captured at dragstart. Dropping a since-dead session
      // would mount a broken terminal stuck in a perpetual WS reconnect loop
      // (the same case store.fetchSessions filters out). Ignore it.
      if (
        pane.type === "session" &&
        !useStore.getState().sessions.some((s) => s.id === pane.id)
      ) {
        console.warn(
          `[autonomOS] ignored drop of dead session ${pane.id} (agent exited mid-drag)`,
        );
        return;
      }

      // Already open — focus it, never add a duplicate (addPanel throws on dupe).
      const existing = api.getPanel(pane.id);
      if (existing) {
        existing.api.setActive();
        return;
      }

      api.addPanel<PaneParams>({
        id: pane.id,
        component: "pane",
        tabComponent: "status",
        params: { pane },
        position: event.group
          ? {
              referenceGroup: event.group,
              direction: POSITION_TO_DIRECTION[event.position],
            }
          : undefined,
      });

      // Pre-arm the guard so the activePane effect (fired by setActivePane below)
      // doesn't re-sync the arrangement we just built by hand.
      appliedActiveId.current = pane.id;
      bindWorkspace(api);
      pushVisible(api);
      useStore.getState().setActivePane(pane);
    },
    [bindWorkspace, pushVisible],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      // Expose the live api to the shortcut layer (mod+1..9 pane switching).
      registerDockviewApi(api);

      // Keep the store's visiblePaneIds in sync with whatever panels dockview is
      // showing — fires on add/remove/move so the sidebar's on-screen marks track
      // every arrangement change.
      api.onDidLayoutChange(() => pushVisible(api));

      // dockview active panel -> store. Only genuine user tab clicks write back;
      // programmatic mutations (syncToActive / prune) suppress this, and an
      // in-flight INTERNAL drag suppresses the transient mid-rebuild activations
      // (the final active panel is applied once on drag end — see the drag
      // effect) to stop the sidebar highlight flickering between panes.
      api.onDidActivePanelChange(() => {
        if (suppressWriteback.current || internalDragActive.current) return;
        const id = api.activePanel?.id;
        if (!id) return;
        const st = useStore.getState();
        if (st.activePane?.id === id) return;
        // Skip retired panels (see paneFromPanel) rather than laundering them
        // into a session pane that would survive the next reload's validation.
        const next = paneFromPanel(id, api.activePanel?.params?.pane);
        if (!next) return;
        appliedActiveId.current = id;
        st.setActivePane(next);
      });

      // Mark internal tab/group drags so the writeback above is gated for their
      // duration. These fire ONLY for dockview-internal drags, never for our
      // external sidebar HTML5 drags — a clean discriminator.
      api.onWillDragPanel(() => {
        internalDragActive.current = true;
      });
      api.onWillDragGroup(() => {
        internalDragActive.current = true;
      });

      // Accept ONLY our sidebar drags, so dockview renders its native edge/center
      // drop overlay and lets the drop land. Without this, no overlay + no drop.
      // (Whether the overlay actually shows is then refined by onWillShowOverlay.)
      api.onUnhandledDragOver((e) => {
        const ne = e.nativeEvent;
        if (
          ne instanceof DragEvent &&
          ne.dataTransfer?.types.includes(DRAG_TYPE)
        ) {
          e.accept();
        }
      });

      // Suppress the split overlay (and the drop) when a pane is being dropped
      // onto ITSELF — you can't split a pane against itself, so the edge/center
      // split zones are misleading. Fires for BOTH internal tab drags
      // (getData().panelId) and external sidebar drags (our captured id). This
      // is what kills the phantom split viz when dragging the highlighted tab.
      api.onWillShowOverlay((e) => {
        const draggedId = e.getData()?.panelId ?? draggingPaneId.current;
        if (draggedId && e.panel?.id === draggedId) e.preventDefault();
      });
      api.onDidDrop(handleExternalDrop);

      // NOTE: do NOT restore here. Calling api.fromJSON() inside onReady is too
      // early — dockview's React layer isn't fully wired and the restore yields
      // zero panels. The mount effect below runs post-commit (where fromJSON
      // works) and performs the initial restore.
    },
    [handleExternalDrop, pushVisible],
  );

  // Initial restore (post-mount) + react to sidebar clicks (switchPane sets
  // activePane): restore the pane's bound workspace or show it solo. Skip when
  // we just applied this pane ourselves. Runs after onReady (child effects fire
  // before parent effects), so apiRef is set.
  useEffect(() => {
    const api = apiRef.current;
    if (api && activePane && activePane.id !== appliedActiveId.current) {
      syncToActive(api, activePane);
    }
  }, [activePane, syncToActive]);

  // Prune ghost panels whenever the live session list changes — a dead session
  // (exit) leaves an orphan panel that pruneDead removes. `sessions` is the
  // intentional trigger (pruneDead reads it fresh via getState(), so biome can't
  // see the usage); keep the dep or the prune never re-runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessions is the re-run trigger
  useEffect(() => {
    if (apiRef.current) pruneDead(apiRef.current);
  }, [sessions, pruneDead]);

  // Clear visiblePaneIds when this component unmounts — SessionViewManager
  // unmounts DockviewLayout when activePane goes null (the empty state), and a
  // stale set would keep the sidebar highlighting rows for a dock that's gone.
  // Also withdraw the shortcut layer's api handle so pane shortcuts become
  // no-ops instead of driving a disposed dockview.
  useEffect(() => {
    return () => {
      useStore.getState().setVisiblePaneIds([]);
      if (apiRef.current) unregisterDockviewApi(apiRef.current);
    };
  }, []);

  // Track the in-flight sidebar drag's pane id (for the onWillShowOverlay
  // decision; getData is readable at dragstart, not during dragover), and settle
  // INTERNAL dockview drags on the dragend terminus.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      draggingPaneId.current = raw
        ? (decodeDragData(raw)?.pane.id ?? null)
        : null;
    };
    // Settle an internal dockview drag on its terminus. The html5 backend (mouse)
    // fires a native `dragend`; the POINTER backend (touch / coarse-pointer /
    // PWA) fires NO drag events at all, so we ALSO settle on pointerup/
    // pointercancel — otherwise `internalDragActive` latches `true` forever after
    // the first touch drag and active-pane tracking (sidebar highlight following
    // taps) silently dies for the rest of the session. A plain tap with no drag
    // in flight is a no-op (the flag is false).
    const settleInternalDrag = () => {
      if (!internalDragActive.current || settleScheduled.current) return;
      settleScheduled.current = true;
      // Defer one frame so dockview has finished its drop/rebuild and
      // api.activePanel + api.panels are final. Keep the drag gate up until then
      // so transient mid-rebuild activations don't flicker the sidebar. Then:
      // clear the gate, write back the single final active panel, and re-bind the
      // rearranged panes into their workspace so the change survives a switch.
      requestAnimationFrame(() => {
        settleScheduled.current = false;
        internalDragActive.current = false;
        const api = apiRef.current;
        if (!api) return;
        bindWorkspace(api);
        const id = api.activePanel?.id;
        if (!id) return;
        const st = useStore.getState();
        if (st.activePane?.id === id) return;
        // Skip retired panels (see paneFromPanel) rather than laundering them
        // into a session pane that would survive the next reload's validation.
        const next = paneFromPanel(id, api.activePanel?.params?.pane);
        if (!next) return;
        appliedActiveId.current = id;
        st.setActivePane(next);
      });
    };
    const onDragEnd = () => {
      draggingPaneId.current = null;
      settleInternalDrag();
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("pointerup", settleInternalDrag);
    document.addEventListener("pointercancel", settleInternalDrag);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("pointerup", settleInternalDrag);
      document.removeEventListener("pointercancel", settleInternalDrag);
    };
  }, [bindWorkspace]);

  return (
    <div
      className="dockview-theme-dark autonomos-dockview"
      style={dockviewThemeVars(theme)}
    >
      <DockviewReact
        theme={AUTONOMOS_DV_THEME}
        components={COMPONENTS}
        tabComponents={TAB_COMPONENTS}
        defaultTabComponent={StatusTab}
        defaultRenderer="always"
        // Hide dockview's "⌄ N" tab-overflow dropdown in each group header — it
        // lists the group's panels (agents), which is redundant with the sidebar
        // and clutters the header. (ADR-047)
        disableTabsOverflowList={true}
        onReady={onReady}
      />
    </div>
  );
}
