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
import { type ActivePane, THEMES, type ThemeName, useStore } from "../../store";
import { DRAG_TYPE, decodeDragData } from "../DragContext";
import { PaneContent, type PaneParams } from "./PaneContent";
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
 * rendered only when `layoutEngine === "dockview"`.
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

/** Pane types that exist as a single global instance (the id IS the type). */
export const SINGLETON_TYPES = new Set<string>([
  "orgchart",
  "templates",
  "schedules",
  "create-agent",
]);

/**
 * Reconstruct an ActivePane descriptor from a dockview panel id. The id space is
 * unambiguous: singleton views use a fixed id == their type, preview panes are
 * tracked in the store, everything else is a session.
 */
export function paneFromId(id: string, previewIds: Set<string>): ActivePane {
  if (SINGLETON_TYPES.has(id))
    return { type: id as ActivePane["type"], id } as ActivePane;
  if (previewIds.has(id)) return { type: "preview", id };
  return { type: "session", id };
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

  const activePane = useStore((s) => s.activePane);
  const sessions = useStore((s) => s.sessions);
  const theme = useStore((s) => s.theme);

  // Apply the arrangement for `pane`: restore its bound workspace (drag-composed
  // group) via fromJSON, or show it solo. fromJSON / solo re-create panels — the
  // accepted keep-alive tradeoff for workspace switching (ADR-047): terminals
  // reconnect to their PTY on remount, so no scrollback-loss beyond a reattach.
  const syncToActive = useCallback((api: DockviewApi, pane: ActivePane) => {
    const st = useStore.getState();
    const wsId = st.dvPaneWorkspace[pane.id];
    const ws = wsId ? st.dvWorkspaces[wsId] : undefined;
    const desired = ws ? ws.paneIds : [pane.id];
    const current = api.panels.map((p) => p.id);
    const sameSet =
      desired.length === current.length &&
      desired.every((id) => current.includes(id));

    suppressWriteback.current = true;
    try {
      if (!sameSet) {
        if (ws) {
          api.fromJSON(ws.serialized as Parameters<typeof api.fromJSON>[0]);
        } else {
          for (const panel of [...api.panels]) api.removePanel(panel);
          if (!api.getPanel(pane.id)) {
            api.addPanel<PaneParams>({
              id: pane.id,
              component: "pane",
              tabComponent: "status",
              params: { pane },
            });
          }
        }
      }
      api.getPanel(pane.id)?.api.setActive();
      appliedActiveId.current = pane.id;
    } finally {
      suppressWriteback.current = false;
    }
  }, []);

  // Drop panels for sessions that no longer exist (exited / killed agents),
  // preventing ghost tabs from lingering once dockview owns the topology.
  const pruneDead = useCallback((api: DockviewApi) => {
    const st = useStore.getState();
    // Don't prune before the first real fetch lands — on cold load `sessions` is
    // briefly empty, and pruning then would nuke just-restored workspace panels
    // (their sessions aren't "live" yet) leaving a blank pane area.
    if (!st.sessionsInitialFetchDone) return;
    const live = new Set(st.sessions.map((s) => s.id));
    const previewIds = new Set(st.previewPanes.map((p) => p.id));
    suppressWriteback.current = true;
    try {
      for (const panel of [...api.panels]) {
        const id = panel.id;
        const isSession = !SINGLETON_TYPES.has(id) && !previewIds.has(id);
        if (isSession && !live.has(id)) api.removePanel(panel);
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
      crypto.randomUUID();
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
      useStore.getState().setActivePane(pane);
    },
    [bindWorkspace],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;

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
        appliedActiveId.current = id;
        const previewIds = new Set(st.previewPanes.map((p) => p.id));
        st.setActivePane(paneFromId(id, previewIds));
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
    [handleExternalDrop],
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

  // Prune ghost panels whenever the live session list changes. `sessions` is the
  // intentional trigger — pruneDead reads the list fresh via getState(), so biome
  // can't see the usage; keep the dep or the prune never re-runs on exit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessions is the re-run trigger
  useEffect(() => {
    if (apiRef.current) pruneDead(apiRef.current);
  }, [sessions, pruneDead]);

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
    const onDragEnd = () => {
      draggingPaneId.current = null;
      if (!internalDragActive.current) return;
      // Defer one frame so dockview has finished its drop/rebuild and
      // api.activePanel + api.panels are final, then: clear the drag gate,
      // write back the single final active panel (no flicker), and re-bind the
      // rearranged panes into their workspace so the change survives a switch.
      requestAnimationFrame(() => {
        internalDragActive.current = false;
        const api = apiRef.current;
        if (!api) return;
        bindWorkspace(api);
        const id = api.activePanel?.id;
        if (!id) return;
        const st = useStore.getState();
        if (st.activePane?.id === id) return;
        appliedActiveId.current = id;
        const previewIds = new Set(st.previewPanes.map((p) => p.id));
        st.setActivePane(paneFromId(id, previewIds));
      });
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
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
