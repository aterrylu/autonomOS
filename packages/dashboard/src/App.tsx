import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SessionViewManager } from "./components/SessionViewManager";
import { Sidebar, SidebarResizeHandle } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThemeVars } from "./components/ThemeVars";
import { DragProvider } from "./layout/DragContext";
import { LayoutProvider } from "./layout/LayoutContext";
import {
  activeTabPane,
  allLeafIds,
  findLeaf,
  findLeafByPaneId,
} from "./layout/layoutTree";
import { SessionMountLayer } from "./layout/SessionMountLayer";
import { requestNotificationPermission, THEMES, useStore } from "./store";
import { isMac } from "./utils/platform";

type AuthState = "checking" | "authenticated" | "unauthenticated" | "error";

function LoginPage() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setError("");
    let res: Response;
    try {
      res = await fetch("/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
    } catch {
      setError("Cannot reach server — check that it is running");
      return;
    }
    if (res.ok) {
      window.location.reload();
    } else {
      setError("Invalid token");
    }
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
    const { layout, openCreateAgent } = useStore.getState();
    if (findLeafByPaneId(layout, "create-agent")) return;
    sessionStorage.setItem("autonomos_first_run_handled", "1");
    openCreateAgent();
  }, [authState, sessionsCount, sessionsInitialFetchDone]);

  // Check auth on mount by hitting a protected endpoint. Three-state
  // classification (not just `=== 401 ? "unauthenticated" : "authenticated"`)
  // so a 5xx / 404 / 403 from the probe doesn't masquerade as authenticated
  // and silently land the user on a broken main UI — the "Cannot connect
  // to server" screen with a Retry button is the better landing.
  useEffect(() => {
    fetch("/api/agents")
      .then((res) => {
        if (res.status === 401) {
          setAuthState("unauthenticated");
        } else if (res.ok) {
          setAuthState("authenticated");
        } else {
          console.error(`[auth] probe returned HTTP ${res.status}`);
          setAuthState("error");
        }
      })
      .catch((err) => {
        console.error("[auth] probe network failure:", err);
        setAuthState("error");
      });
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Cmd/Ctrl+B — toggle sidebar
      if (mod && e.key === "b") {
        e.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }

      // Ctrl+D — split focused pane vertically (side-by-side), new session
      if (e.ctrlKey && !e.shiftKey && e.key === "d") {
        e.preventDefault();
        const { focusedLeafId, layout, sessions } = useStore.getState();
        const leaf = findLeaf(layout, focusedLeafId);
        const cwd = (() => {
          const p = leaf ? activeTabPane(leaf) : null;
          return p?.type === "session"
            ? (sessions.find((s) => s.id === p.id)?.workingDirectory ?? "~")
            : "~";
        })();
        useStore
          .getState()
          .createSessionIntoLeaf(focusedLeafId, "vertical", "second", cwd);
        return;
      }

      // Ctrl+Shift+D — split focused pane horizontally (top/bottom), new session
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        const { focusedLeafId, layout, sessions } = useStore.getState();
        const leaf = findLeaf(layout, focusedLeafId);
        const cwd = (() => {
          const p = leaf ? activeTabPane(leaf) : null;
          return p?.type === "session"
            ? (sessions.find((s) => s.id === p.id)?.workingDirectory ?? "~")
            : "~";
        })();
        useStore
          .getState()
          .createSessionIntoLeaf(focusedLeafId, "horizontal", "second", cwd);
        return;
      }

      // Ctrl+W — close focused pane
      if (e.ctrlKey && !e.shiftKey && e.key === "w") {
        const { focusedLeafId, layout } = useStore.getState();
        if (allLeafIds(layout).length > 1) {
          e.preventDefault();
          useStore.getState().closeLeaf(focusedLeafId);
        }
        return;
      }
    };
    // Use capture phase so App shortcuts fire even when xterm.js has focus
    // (xterm calls stopPropagation in the bubble phase, blocking window listeners)
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

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
              // Same three-state classification as the mount-time probe
              // above — 5xx / 404 / 403 must NOT slip through as
              // authenticated (would put the user back on a broken
              // main UI with no retry path).
              fetch("/api/agents")
                .then((res) => {
                  if (res.status === 401) {
                    setAuthState("unauthenticated");
                  } else if (res.ok) {
                    setAuthState("authenticated");
                  } else {
                    console.error(
                      `[auth] retry probe returned HTTP ${res.status}`,
                    );
                    setAuthState("error");
                  }
                })
                .catch((err) => {
                  console.error("[auth] retry probe network failure:", err);
                  setAuthState("error");
                });
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <DragProvider>
      <LayoutProvider>
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
            {/* Absolutely positions all session/preview instances into their slot rects */}
            <SessionMountLayer />
          </div>
          <StatusBar />
        </div>
      </LayoutProvider>
    </DragProvider>
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
