import type { DockviewApi } from "dockview-react";

/**
 * Module-level handle to the live DockviewApi, so shortcut actions can reach
 * the dock without threading React context (same pattern as the terminal focus
 * registry in useTerminal.ts). Null whenever no dock is mounted —
 * SessionViewManager unmounts DockviewLayout entirely when `activePane` is
 * null (the empty state), so every consumer must tolerate null.
 *
 * Lifecycle asymmetry worth knowing: register runs in dockview's onReady,
 * unregister in an effect cleanup. The dashboard does not use StrictMode; if
 * it ever does, the simulated dev unmount would run the cleanup while onReady
 * does NOT re-fire, leaving pane shortcuts dead in dev builds only.
 */
let current: DockviewApi | null = null;

export function registerDockviewApi(api: DockviewApi): void {
  current = api;
}

/** Unregister only if `api` is still the registered one — a stale unmount
 *  cleanup must not clobber a newer mount's registration. */
export function unregisterDockviewApi(api: DockviewApi): void {
  if (current === api) current = null;
}

export function getDockviewApi(): DockviewApi | null {
  return current;
}
