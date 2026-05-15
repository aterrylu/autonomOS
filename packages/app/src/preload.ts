// Preload script — injected into the dashboard webview before any page JS
// runs. Exposes a minimal `window.autonomosShell` bridge that the dashboard
// can feature-detect.
//
// Contract is intentionally tiny in 1B.1: just enough to prove the bridge
// works. Native API surface grows in Phase 1B.2 (native notifications,
// dock badges, file dialogs, system tray, etc.).

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("autonomosShell", {
  /** Bridge protocol version. The dashboard checks this before calling
   *  any method — old shells with new dashboards skip unrecognized features. */
  version: 1,

  /** Host platform info, surfaced for telemetry / UI hints. */
  platform: process.platform,
  arch: process.arch,

  /** Whether the renderer is running inside the autonomOS desktop shell
   *  (vs a plain browser pointed at the same server). Used by the dashboard
   *  to suppress PWA install prompts, route notifications natively, etc. */
  isDesktop: true,
});
