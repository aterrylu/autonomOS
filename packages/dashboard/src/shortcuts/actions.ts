import { focusTerminal } from "../hooks/useTerminal";
import { SINGLETON_TYPES } from "../layout/dockview/paneId";
import { getDockviewApi } from "./dockviewApi";
import { orderedPaneIds } from "./orderedPaneIds";

/**
 * Focus the Nth open pane (0-based) in VISUAL order — the action behind
 * mod+1..8. Out-of-range index or no mounted dock is a deliberate no-op
 * (pressing mod+5 with three panes open does nothing, like every tabbed app).
 */
export function focusPaneByIndex(index: number): void {
  const ids = currentPaneIds();
  const id = ids[index];
  if (id !== undefined) activatePane(id);
}

/** Focus the LAST open pane — mod+9, the Ghostty/Warp/VS Code idiom. */
export function focusLastPane(): void {
  const ids = currentPaneIds();
  const id = ids[ids.length - 1];
  if (id !== undefined) activatePane(id);
}

/** Tripwire: warn once if the serialized-grid walk disagrees with the panel
 *  count (a dockview upgrade changing the toJSON shape would otherwise kill
 *  every pane shortcut silently — the dispatcher consumes the chord either
 *  way, so nothing else would surface it). */
let warnedShapeDrift = false;

function currentPaneIds(): string[] {
  const api = getDockviewApi();
  if (!api) return [];
  const ids = orderedPaneIds(api.toJSON());
  const panelCount = api.panels.length;
  if (ids.length !== panelCount && panelCount > 0) {
    if (!warnedShapeDrift) {
      warnedShapeDrift = true;
      console.warn(
        `[autonomOS] pane-shortcut ordering walk found ${ids.length} panes but dockview has ${panelCount} — ` +
          "serialized layout shape may have changed (dockview upgrade?). " +
          "Falling back to insertion order; positional shortcuts may misorder panes.",
      );
    }
    // Wrong order beats dead-and-consumed keys.
    return api.panels.map((p) => p.id);
  }
  return ids;
}

/**
 * Activate a pane the way a tab click does: `panel.api.setActive()` — cheap
 * and non-destructive. NEVER the store's `switchPane` here: that path can
 * trigger a full workspace fromJSON/solo rebuild, remounting every terminal.
 * The dockview→store writeback (onDidActivePanelChange) mirrors the change
 * into `activePane` for us, exactly as it does for a real tab click.
 *
 * For session panes we also kick `focusTerminal` so the keyboard lands in the
 * shell, matching the sidebar-click behavior (PaneContent's activation focus
 * covers most cases, but focusTerminal's visibility polling covers the frames
 * where dockview hasn't finished revealing the panel yet).
 */
function activatePane(id: string): void {
  const api = getDockviewApi();
  const panel = api?.getPanel(id);
  if (!panel) return;
  panel.api.setActive();
  if (!SINGLETON_TYPES.has(id)) focusTerminal(id);
}
