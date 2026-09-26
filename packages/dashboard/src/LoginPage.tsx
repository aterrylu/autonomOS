// The signed-out surface: the login form, and the sign-in link's hand-off.
//
// A sign-in link (…/#token=<token>) is consumed by the inline script at the
// top of index.html, before this bundle loads: it strips the token from the
// address bar and POSTs it to /api/auth. This module only ever sees the
// exchange's RESULT (window.__autonomosLinkLogin), never the token.

import { useState } from "react";
import { ApiError, request } from "./api/core";
import { THEMES, useStore } from "./store";

export type AuthState =
  | "checking"
  | "signing-in"
  | "authenticated"
  | "unauthenticated"
  | "error";

/** The sign-in link's outcome, from the inline script in index.html. The app
 *  never sees the token itself — only whether the exchange worked. */
export interface LinkLoginResult {
  ok: boolean;
  status: number;
}

declare global {
  interface Window {
    __autonomosLinkLogin?: Promise<LinkLoginResult>;
  }
}

/** Shown on the login screen when a sign-in link's token was refused. */
export const LINK_LOGIN_ERROR =
  "That sign-in link didn't work. It may be from another autonomOS instance, or the token has changed. Paste the current token instead.";

/** The exchange never got an answer (network, timeout, server error). */
export const LINK_LOGIN_UNREACHABLE =
  "Couldn't reach the server to use the sign-in link. Open the link again, or paste the token.";

/** The server accepted the link, but the session cookie didn't stick. */
export const LINK_LOGIN_NO_COOKIE =
  "The sign-in link was accepted, but this browser didn't keep the session cookie. Check that cookies are allowed for this site.";

/** Take (once) the pending sign-in link exchange, if the page was opened with one. */
export function takeLinkLogin(): Promise<LinkLoginResult> | undefined {
  const pending = window.__autonomosLinkLogin;
  window.__autonomosLinkLogin = undefined;
  return pending;
}

/**
 * Finish a sign-in link: wait for the exchange, then probe. The PROBE decides
 * the state, not the exchange — a refused link never clears an existing
 * session (a stale link opened while signed in just lands you in). Signed
 * out, the error says WHY: refused (400/401), unreachable (network, timeout,
 * 5xx), or accepted but the cookie didn't stick.
 */
export async function settleLinkLogin(
  link: Promise<LinkLoginResult>,
  probe: () => Promise<AuthState>,
): Promise<{ state: AuthState; error: string }> {
  const result = await link;
  if (!result.ok)
    console.error(`[auth] sign-in link exchange failed: HTTP ${result.status}`);
  const state = await probe();
  if (state !== "unauthenticated") return { state, error: "" };
  if (result.ok) {
    console.error(
      "[auth] sign-in link accepted, but the session cookie was not kept",
    );
    return { state, error: LINK_LOGIN_NO_COOKIE };
  }
  const refused = result.status === 401 || result.status === 400;
  return { state, error: refused ? LINK_LOGIN_ERROR : LINK_LOGIN_UNREACHABLE };
}

export function LoginPage({ initialError = "" }: { initialError?: string }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [token, setToken] = useState("");
  const [error, setError] = useState(initialError);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setError("");
    try {
      // No api/ module for /api/auth — it is the one endpoint that runs BEFORE
      // a session exists — so this goes through the client core directly.
      await request("/api/auth", {
        method: "POST",
        body: { token: token.trim() },
      });
    } catch (err) {
      setError(
        !(err instanceof ApiError) || err.unreachable
          ? "Cannot reach server — check that it is running"
          : err.status === 401
            ? "Invalid token"
            : `Server error (HTTP ${err.status}) — check autonomos logs`,
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
          Open the sign-in link from the install output, or run
          <br />
          <code className="font-mono">cat ~/.autonomos/token</code> on the
          machine running autonomOS
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
          <p
            className="text-xs text-center"
            style={{ color: "#ea6c73" }}
            role="alert"
          >
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
