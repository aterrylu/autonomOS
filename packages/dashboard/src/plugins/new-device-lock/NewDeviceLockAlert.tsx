// The owner's lockout alert, under the header (ADR-148, Terry's mockup B1).
//
// Prominent but not blocking: a lock is usually scanner noise, and this device
// keeps working, so it never takes over the screen. [Unlock new devices]
// [Details] [Hide]; after Hide the status-bar pill takes over until the next
// lock. Renders nothing unless locked (also keeps the README hero unaffected).

import { THEMES, useStore } from "../../store";
import { accentsFor } from "../update-badge/UpdateDialog";
import { barVisible, useLockStore } from "./lockState";

export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
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

/** "14:32 today", or a date for an older lock. */
export function formatLockedAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString()
    ? `${time} today`
    : `${d.toLocaleDateString()} ${time}`;
}

export function failuresSentence(failures: number): string {
  return `${failures} failed sign-in attempt${failures === 1 ? "" : "s"} came from devices that haven't signed in before.`;
}

/** Shared by the bar and the bell: unlock, then say what happened. */
export async function unlockAndReport(): Promise<void> {
  const ok = await useLockStore.getState().unlock();
  useStore
    .getState()
    .showActionToast(
      ok
        ? "New devices can sign in again."
        : "Couldn't unlock. Run `autonomos auth unlock` on the server.",
      ok,
    );
}

export function NewDeviceLockAlert() {
  const lock = useLockStore((s) => s.lock);
  const visible = useLockStore(barVisible);
  const detailsOpen = useLockStore((s) => s.detailsOpen);
  const unlocking = useLockStore((s) => s.unlocking);
  const hide = useLockStore((s) => s.hide);
  const toggleDetails = useLockStore((s) => s.toggleDetails);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { amber: AMBER } = accentsFor(page.bg);

  if (!visible || !lock) return null;

  return (
    <div
      role="alert"
      data-testid="new-device-lock-alert"
      className="shrink-0"
      style={{ background: `${AMBER}17`, borderBottom: `1px solid ${AMBER}73` }}
    >
      <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
        <span className="flex" style={{ color: AMBER }}>
          <LockIcon size={18} />
        </span>
        <div
          className="min-w-[12rem] flex-1 text-[13.5px] leading-snug"
          style={{ color: page.fg }}
        >
          <span className="font-semibold">New devices are locked out.</span>{" "}
          <span style={{ color: page.statusFg }}>
            {failuresSentence(lock.failures)}
          </span>
        </div>
        <button
          type="button"
          disabled={unlocking}
          onClick={() => void unlockAndReport()}
          data-testid="new-device-lock-unlock"
          className="h-8 cursor-pointer whitespace-nowrap rounded px-3.5 text-[13px] font-semibold disabled:cursor-default disabled:opacity-60"
          style={{ background: AMBER, color: page.bg, border: "none" }}
        >
          Unlock new devices
        </button>
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={toggleDetails}
          data-testid="new-device-lock-details"
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded px-2.5 text-[13px]"
          style={{
            background: "transparent",
            color: page.fg,
            border: `1px solid ${AMBER}73`,
          }}
        >
          Details
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
            style={{ transform: detailsOpen ? "rotate(180deg)" : undefined }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={hide}
          data-testid="new-device-lock-hide"
          className="h-8 cursor-pointer rounded px-2.5 text-[13px]"
          style={{
            background: "transparent",
            color: page.statusFg,
            border: "none",
          }}
        >
          Hide
        </button>
      </div>
      {detailsOpen && (
        <div
          data-testid="new-device-lock-details-row"
          className="flex flex-wrap gap-x-5 gap-y-1.5 pb-3 pl-[46px] pr-5 text-[12.5px]"
          style={{ color: page.fg }}
        >
          {lock.lockedAt !== null && lock.lockedAt > 0 && (
            <span>
              <span style={{ color: page.statusFg }}>Locked at</span>{" "}
              {formatLockedAt(lock.lockedAt)}
            </span>
          )}
          {lock.lastFailureFrom && (
            <span>
              <span style={{ color: page.statusFg }}>Last attempt from</span>{" "}
              <span className="font-mono text-xs">{lock.lastFailureFrom}</span>
              {lock.lastFailureLogin && (
                <span> · {lock.lastFailureLogin} (Tailscale)</span>
              )}
            </span>
          )}
          <span style={{ color: page.statusFg }}>
            This device, your other signed-in devices and the server keep
            working.
          </span>
        </div>
      )}
    </div>
  );
}
