// New-device lock pill (ADR-148).
//
// With a short operator token, the server locks out devices that have never
// signed in after a fixed number of failed sign-ins. This dashboard is on a
// device that HAS signed in, so it still works, and it is where the operator
// learns about the lock and lifts it. Renders null unless locked (the normal
// state, which also keeps the README hero unaffected). Styled exactly like
// the update badge's amber "armed" pill: no new visual language.

import { useCallback, useEffect, useState } from "react";
import { request } from "../../api/core";
import { THEMES, useStore } from "../../store";
import { accentsFor } from "../update-badge/UpdateDialog";

const POLL_INTERVAL_MS = 60_000;

export type LockState = {
  enabled: boolean;
  locked: boolean;
  failures: number;
  limit: number;
};

function isLockState(v: unknown): v is LockState {
  const o = v as Partial<LockState> | null;
  return (
    !!o &&
    typeof o.locked === "boolean" &&
    typeof o.failures === "number" &&
    typeof o.limit === "number"
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function NewDeviceLockStatusBarItem() {
  const [lock, setLock] = useState<LockState | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useStore((s) => s.theme);
  const showActionToast = useStore((s) => s.showActionToast);
  const page = THEMES[theme].page;
  const { amber: AMBER } = accentsFor(page.bg);

  const refresh = useCallback(async () => {
    try {
      const data = await request<unknown>("/api/auth/lock", {
        fresh: true,
        signal: AbortSignal.timeout(5_000),
      });
      // An older server has no such route (404 → throws): stay hidden.
      setLock(isLockState(data) ? data : null);
    } catch {
      // Unreachable / older server: keep what we had.
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (mounted) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  if (!lock?.locked) return null;

  async function unlock() {
    setBusy(true);
    try {
      const next = await request<unknown>("/api/auth/unlock", {
        method: "POST",
        body: {},
      });
      setLock(isLockState(next) ? next : null);
      showActionToast("New devices can sign in again.", true);
    } catch {
      showActionToast(
        "Couldn't unlock. Run `autonomos auth unlock` on the server.",
        false,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className="flex items-center whitespace-nowrap rounded-full"
      style={{
        color: AMBER,
        boxShadow: `inset 0 0 0 1px ${AMBER}66`,
        background: `${AMBER}14`,
        height: 24,
      }}
      data-testid="new-device-lock"
    >
      <span
        className="flex h-6 items-center gap-1.5 px-2"
        title={`${lock.failures} failed sign-ins from devices that had never signed in, so new devices are locked out. Devices already signed in (like this one) keep working.`}
      >
        <LockIcon />
        <span>New devices locked</span>
      </span>
      <button
        type="button"
        disabled={busy}
        title="Let new devices sign in again"
        className="h-6 min-w-6 cursor-pointer rounded-full px-2 hover:brightness-125 disabled:cursor-default disabled:opacity-60"
        style={{ color: page.fg, borderLeft: `1px solid ${AMBER}66` }}
        onClick={() => void unlock()}
        data-testid="new-device-unlock"
      >
        Unlock
      </button>
    </span>
  );
}
