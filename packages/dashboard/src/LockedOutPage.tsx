// What a NEW device sees while new devices are locked out (ADR-148, Terry's
// mockup A). It replaces the login form: the server refuses this device's
// sign-in before looking at the token, so a token box would only invite
// pointless retries. Deliberately says nothing about the lock itself (no
// count, no address, no time, no hint about the token): a visitor here may be
// the one guessing.
//
// "Check again" repeats the page-load probe: a request with no credential,
// which the server answers 423 while locked and which counts as no guess. It
// reveals nothing the server doesn't already tell every request.

import { useState } from "react";
import type { AuthState } from "./LoginPage";
import { accentsFor } from "./plugins/update-badge/UpdateDialog";
import { THEMES, useStore } from "./store";

export function LockedOutPage({
  checkAgain,
}: {
  /** Re-probe; resolves to the new auth state. */
  checkAgain: () => Promise<AuthState>;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { amber: AMBER } = accentsFor(page.bg);
  const [checking, setChecking] = useState(false);
  const [stillLocked, setStillLocked] = useState(false);

  async function onCheck() {
    setChecking(true);
    setStillLocked(false);
    try {
      const next = await checkAgain();
      if (next === "locked-out") setStillLocked(true);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 font-sans"
      style={{ background: page.bg, color: page.fg }}
    >
      <main
        className="flex w-full max-w-[360px] flex-col items-center gap-[18px] text-center"
        data-testid="locked-out-page"
      >
        <div className="text-lg font-semibold">autonomOS</div>
        <div
          className="flex h-[52px] w-[52px] items-center justify-center rounded-full"
          style={{
            color: AMBER,
            background: `${AMBER}17`,
            boxShadow: `inset 0 0 0 1px ${AMBER}73`,
          }}
        >
          <svg
            aria-hidden="true"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <h1 className="m-0 text-xl font-semibold">
          New devices are locked out
        </h1>
        <p
          className="m-0 text-sm leading-relaxed"
          style={{ color: page.statusFg }}
        >
          This server isn't accepting new devices right now. Too many wrong
          sign-in attempts came from devices that haven't signed in before.
        </p>
        <div
          className="flex w-full flex-col gap-2.5 rounded-md px-4 py-3.5 text-left"
          style={{ border: `1px solid ${page.border}` }}
        >
          <div
            className="text-xs font-semibold"
            style={{ color: page.statusFg }}
          >
            The owner can let new devices in again
          </div>
          <div className="text-[13px] leading-normal">
            From a device that's already signed in:{" "}
            <span className="font-semibold">Unlock new devices</span>
          </div>
          <div className="text-[13px] leading-normal">
            Or on the server:{" "}
            <code
              className="rounded px-1.5 py-0.5 font-mono text-xs"
              style={{ background: page.border }}
            >
              autonomos auth unlock
            </code>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onCheck()}
          disabled={checking}
          className="min-h-11 w-full cursor-pointer rounded text-sm font-medium disabled:cursor-default disabled:opacity-60"
          style={{
            border: `1px solid ${page.border}`,
            background: "transparent",
            color: page.fg,
          }}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        <p
          className="m-0 text-xs leading-normal"
          style={{ color: page.statusFg }}
          aria-live="polite"
        >
          {stillLocked
            ? "Still locked. Ask the owner to unlock new devices."
            : "Once new devices are allowed, this page turns back into the sign-in page."}
        </p>
      </main>
    </div>
  );
}
