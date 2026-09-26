import { useEffect, useState } from "react";
import { agentsApi } from "./api/agents";
import { ApiError } from "./api/core";
import { Header } from "./components/Header";
import { SessionViewManager } from "./components/SessionViewManager";
import { Sidebar, SidebarResizeHandle } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThemeVars } from "./components/ThemeVars";
import {
  type AuthState,
  LoginPage,
  settleLinkLogin,
  takeLinkLogin,
} from "./LoginPage";
import { startPushBridge } from "./pushBridge";
import { QuickSwitcher } from "./shortcuts/QuickSwitcher";
import { ShortcutHelpOverlay } from "./shortcuts/ShortcutHelpOverlay";
import { useModKeyHold } from "./shortcuts/useModKeyHold";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { requestNotificationPermission, THEMES, useStore } from "./store";

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

export function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const page = THEMES[theme].page;
  const viewportHeight = useViewportHeight();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [loginError, setLoginError] = useState("");
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

  // Check auth on mount by hitting a protected endpoint (see probeAuth). When
  // the page was opened with a sign-in link, finish that exchange FIRST — a
  // probe with a stale cookie would 401 and flash the login form.
  useEffect(() => {
    const link = takeLinkLogin();
    if (!link) {
      probeAuth("probe").then(setAuthState);
      return;
    }
    setAuthState("signing-in");
    settleLinkLogin(link, () => probeAuth("probe"))
      .then(({ state, error }) => {
        setLoginError(error);
        setAuthState(state);
      })
      .catch((err) => {
        console.error("[auth] sign-in link failed:", err);
        setAuthState("error");
      });
  }, []);

  // Push channel: while /ws/agents is live it feeds agents/tree/statuses and
  // suspends their polls; on socket loss the polls resume seamlessly. Gated
  // on auth — the upgrade rides the auth cookie, so connecting pre-login
  // would just churn 401 reconnects.
  useEffect(() => {
    if (authState !== "authenticated") return;
    return startPushBridge();
  }, [authState]);

  // Global keyboard shortcuts (see src/shortcuts/registry.ts). Gated on auth
  // so no chord fires over the login page's password field.
  useShortcuts(authState === "authenticated");
  // Hold the primary modifier → pane-digit badges on the tabs (same gate).
  useModKeyHold(authState === "authenticated");

  if (authState === "signing-in") {
    return (
      <div
        className="flex h-screen items-center justify-center font-sans"
        style={{ background: page.bg, color: page.statusFg }}
      >
        Signing you in…
      </div>
    );
  }

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
    return <LoginPage initialError={loginError} />;
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
