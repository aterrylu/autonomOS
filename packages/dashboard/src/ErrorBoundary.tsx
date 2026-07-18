import { Component, type ErrorInfo, type ReactNode } from "react";

const PERSIST_KEY = "autonomos";
// Stamped in sessionStorage just before a layout-reset reload. If the app
// crashes AGAIN within this window, the reset didn't fix it — the fault is
// almost certainly NOT layout, so we escalate to a full wipe instead of looping
// the user on a recovery that can't work. Time-bounded, so a genuinely unrelated
// crash later starts fresh at tier 1 (no explicit marker cleanup needed).
const RESET_MARKER = "autonomos:layoutResetAt";
const RESET_WINDOW_MS = 10_000;

/**
 * Persisted keys that drive the dockview layout. If restore feeds a corrupt one
 * into dockview (a bad `activePane`, a poison `dvWorkspaces` blob), the render
 * throws — and because the value re-persists, it throws again on every reload.
 * Clearing just these keys recovers the layout while preserving theme, sidebar,
 * and other preferences.
 */
const LAYOUT_KEYS = [
  "dvWorkspaces",
  "dvPaneWorkspace",
  "activePane",
  "previewPanes",
];

/** True if a layout reset was attempted in the last RESET_WINDOW_MS — i.e. this
 *  mount is the reload that followed a reset. A crash now means the reset failed. */
function resetJustFailed(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RESET_MARKER));
    return at > 0 && Date.now() - at < RESET_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Surgically drop the layout keys from the persisted zustand blob, then reload.
 * Falls back to nuking the whole persisted state if the blob can't be parsed —
 * either way the next boot starts from a clean layout instead of re-crashing.
 */
function resetLayoutAndReload() {
  try {
    sessionStorage.setItem(RESET_MARKER, String(Date.now()));
  } catch {
    // sessionStorage unavailable — we just lose loop-detection, not recovery.
  }
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.state && typeof parsed.state === "object") {
        for (const k of LAYOUT_KEYS) delete parsed.state[k];
        localStorage.setItem(PERSIST_KEY, JSON.stringify(parsed));
      } else {
        localStorage.removeItem(PERSIST_KEY);
      }
    }
  } catch {
    // Unparseable / storage error → clear everything and start fresh.
    try {
      localStorage.removeItem(PERSIST_KEY);
    } catch {
      // Storage entirely unavailable; the reload is still the best we can do.
    }
  }
  window.location.reload();
}

/**
 * Escalation path when a layout reset already failed: wipe ALL persisted state
 * (not just layout — the fault is elsewhere) and reload from clean defaults.
 */
function clearAllAndReload() {
  try {
    localStorage.removeItem(PERSIST_KEY);
    sessionStorage.removeItem(RESET_MARKER);
  } catch {
    // Storage unavailable; reload anyway.
  }
  window.location.reload();
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level crash guard. Without this, any throw during layout restore unmounts
 * the whole React tree into a blank white screen with no in-app recovery — the
 * only escape is manually clearing localStorage, which a non-technical user
 * can't do. This converts every such crash into a recoverable "Reset layout"
 * screen. See the dashboard stuck-state audit (cluster A).
 *
 * React error boundaries catch ALL render errors, not just layout ones, so a
 * non-layout crash would otherwise loop the user on a layout reset that can't
 * fix it. `resetJustFailed()` detects that case and escalates to a full wipe
 * with honest copy instead of blaming (and re-trying) the layout forever.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[autonomOS] Uncaught render error:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // A reset already ran and we crashed again → the layout wasn't the cause.
    // Escalate to a full wipe with honest copy rather than looping on a layout
    // reset that can't fix a non-layout fault.
    if (resetJustFailed()) {
      return this.renderShell(
        "Resetting the layout didn't fix it",
        "The problem is likely something other than the saved layout. Clearing all saved data (theme, sidebar, and layout) and reloading should recover the dashboard.",
        "Clear all saved data & reload",
        clearAllAndReload,
      );
    }

    return this.renderShell(
      "The dashboard hit an error",
      "Resetting the saved layout fixes most cases — it clears the tab arrangement while keeping your agents, theme, and other settings, then reloads.",
      "Reset layout & reload",
      resetLayoutAndReload,
    );
  }

  /** Shared fallback UI: title + explanation + one recovery button (+ dev stack). */
  private renderShell(
    title: string,
    message: string,
    buttonLabel: string,
    onRecover: () => void,
  ) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          background: "#0a0e14",
          color: "#b3b1ad",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: "#e6e1cf" }}>
          {title}
        </div>
        <div style={{ fontSize: 13, maxWidth: 440, opacity: 0.8 }}>
          {message}
        </div>
        <button
          type="button"
          onClick={onRecover}
          style={{
            padding: "8px 18px",
            fontSize: 14,
            fontWeight: 600,
            color: "#0a0e14",
            background: "#ffcc66",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {buttonLabel}
        </button>
        {import.meta.env.DEV && this.state.error && (
          <pre
            style={{
              fontSize: 11,
              maxWidth: "80vw",
              maxHeight: "30vh",
              overflow: "auto",
              opacity: 0.6,
              textAlign: "left",
              whiteSpace: "pre-wrap",
            }}
          >
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
        )}
      </div>
    );
  }
}
