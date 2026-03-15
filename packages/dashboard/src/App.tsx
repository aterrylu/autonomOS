import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SessionViewManager } from "./components/SessionViewManager";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { THEMES, useStore } from "./store";
import { isMac } from "./utils/platform";

type AuthState = "checking" | "authenticated" | "unauthenticated";

function LoginPage() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setError("");
    const res = await fetch(`/auth?token=${encodeURIComponent(token.trim())}`, {
      redirect: "manual",
    }).catch(() => null);
    // /auth redirects on success (302), returns 401 on bad token
    if (
      res &&
      (res.status === 200 || res.status === 0 || res.type === "opaqueredirect")
    ) {
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

  // Check auth on mount by hitting a protected endpoint
  useEffect(() => {
    fetch("/api/sessions")
      .then((res) => {
        setAuthState(res.status === 401 ? "unauthenticated" : "authenticated");
      })
      .catch(() => setAuthState("authenticated")); // No server = skip auth
  }, []);

  // Cmd/Ctrl+B toggles sidebar (global handler — works even without a terminal)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "b") {
        e.preventDefault();
        useStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  return (
    <div
      className="flex flex-col font-sans"
      style={{ background: page.bg, color: page.fg, height: viewportHeight }}
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
          </>
        )}
        <SessionViewManager />
      </div>
      <StatusBar />
    </div>
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
