import { useEffect, useState } from "react";
import { agentsApi } from "./api/agents";
import { ApiError, request } from "./api/core";
import { Header } from "./components/Header";
import { SessionViewManager } from "./components/SessionViewManager";
import { Sidebar, SidebarResizeHandle } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThemeVars } from "./components/ThemeVars";
import { QuickSwitcher } from "./shortcuts/QuickSwitcher";
import { ShortcutHelpOverlay } from "./shortcuts/ShortcutHelpOverlay";
import { useModKeyHold } from "./shortcuts/useModKeyHold";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { requestNotificationPermission, THEMES, useStore } from "./store";

type AuthState = "checking" | "authenticated" | "unauthenticated" | "error";

/**
 * Probe a protected endpoint to classify the session into THREE states, not two:
 * a 5xx / 404 / 403 must not masquerade as authenticated and silently land the
 * user on a broken main UI — the "Cannot connect to server" screen with a Retry
 * button is the better landing.
 *
 * `label` distinguishes the mount-time probe from the Retry one in the console.
 */
async function probeAuth(label: "probe" | "retry probe"): Promise<AuthState> {
  try {
    await agentsApi.list();
    return "authenticated";
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return "unauthenticated";
    if (err instanceof ApiError && !err.unreachable) {
      console.error(`[auth] ${label} returned HTTP ${err.status}`);
      return "error";
    }
    console.error(`[auth] ${label} network failure:`, err);
    return "error";
  }
}

function LoginPage() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setError("");
    try {
      // No api/ module for /auth — it is the one endpoint that runs BEFORE a
      // session exists — so this goes through the client core directly.
      await request("/auth", { method: "POST", body: { token: token.trim() } });
    } catch (err) {
      setError(
        err instanceof ApiError && err.unreachable
          ? "Cannot reach server — check that it is running"
          : "Invalid token",
      );
      return;
    }
    window.location.reload();
  }

  return (
    <div
      className="flex h-screen items-center justify-center font-sans"
      style={{ background: page.bg, color: page.fg }}
    >
      <form onSubmit={handleSubmit} className="w-80 space-y-4">
        <h1 className="text-lg font-semibold text-center">autonomOS</h1>
        <p className="text-xs text-center" style={{ color: page.statusFg }}>
          Enter your access token to continue
        </p>
        <p
          className="text-xs text-center leading-relaxed"
          style={{ color: page.statusFg, opacity: 0.7 }}
        >
          Find your token in the server console output
          <br />
          or in <code className="font-mono">~/.autonomos/token</code>
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token here..."
          // biome-ignore lint/a11y/noAutofocus: login page primary input
          autoFocus
          className="w-full rounded px-3 py-2 text-sm font-mono"
          style={{
            background: page.border,
            color: page.fg,
            border: "none",
            outline: "none",
          }}
        />
        {error && (
          <p className="text-xs text-center" style={{ color: "#ea6c73" }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!token.trim()}
          className="w-full rounded px-3 py-2 text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#16825d", color: "#fff" }}
        >
          Authenticate
        </button>
      </form>
    </div>
  );
}

export function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const page = THEMES[theme].page;
  const viewportHeight = useViewportHeight();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const sessionsCount = useStore((s) => s.sessions.length);
  const sessionsInitialFetchDone = useStore((s) => s.sessionsInitialFetchDone);

  /** First-run UX: when the user authenticates against an autonomos server
   *  that has zero agents (fresh install, Try-It-Out mode, etc.), auto-open
   *  the Create Agent panel so the next click already shapes a new agent.
   *  Fires at most once per tab session — closing the panel without creating
   *  an agent leaves them alone until the next reload. */
  useEffect(() => {
    if (authState !== "authenticated") return;
    if (!sessionsInitialFetchDone) return;
    if (sessionsCount > 0) return;
    if (sessionStorage.getItem("autonomos_first_run_handled") === "1") return;
    const { activePane, openCreateAgent } = useStore.getState();
    if (activePane?.type === "create-agent") return;
    sessionStorage.setItem("autonomos_first_run_handled", "1");
    openCreateAgent();
  }, [authState, sessionsCount, sessionsInitialFetchDone]);

  // Check auth on mount by hitting a protected endpoint (see probeAuth).
  useEffect(() => {
    probeAuth("probe").then(setAuthState);
  }, []);

  // Global keyboard shortcuts (see src/shortcuts/registry.ts). Gated on auth
  // so no chord fires over the login page's password field.
  useShortcuts(authState === "authenticated");
  // Hold the primary modifier → pane-digit badges on the tabs (same gate).
  useModKeyHold(authState === "authenticated");

  if (authState === "checking") {
    return (
      <div
        className="flex h-screen items-center justify-center font-sans"
        style={{ background: page.bg, color: page.statusFg }}
      >
        Connecting...
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <LoginPage />;
  }

  if (authState === "error") {
    return (
      <div
        className="flex h-screen items-center justify-center font-sans"
        style={{ background: page.bg, color: page.statusFg }}
      >
        <div className="text-center space-y-3">
          <div>Cannot connect to server</div>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs cursor-pointer"
            style={{ background: page.border, color: page.fg }}
            onClick={() => {
              setAuthState("checking");
              // Same three-state classification as the mount-time probe.
              probeAuth("retry probe").then(setAuthState);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <ThemeVars />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: notification permission on first interaction */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: notification permission on first interaction */}
      <div
        className="flex flex-col font-sans"
        style={{
          background: page.bg,
          color: page.fg,
          height: viewportHeight,
        }}
        onClick={requestNotificationPermission}
      >
        <Header />
        <div className="relative flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
              <div
                className="absolute inset-0 z-10 md:hidden"
                onClick={() => useStore.getState().toggleSidebar()}
              />
              <Sidebar />
              <SidebarResizeHandle />
            </>
          )}
          <SessionViewManager />
        </div>
        <StatusBar />
        <ShortcutHelpOverlay />
        <QuickSwitcher />
      </div>
    </>
  );
}

/**
 * Returns a CSS height string that tracks the visual viewport.
 * On mobile, the visual viewport shrinks when the virtual keyboard opens,
 * so this ensures the app resizes to fit above the keyboard.
 * Falls back to "100dvh" on desktop or unsupported browsers.
 */
function useViewportHeight() {
  const [height, setHeight] = useState("100dvh");

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => setHeight(`${vv.height}px`);
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

  return height;
}
