// The bell's pinned lockout entry (ADR-148, Terry's mockup B1 + bell). It is
// STATE, not an event: it stays at the top of the panel while new devices are
// locked (hidden bar or not) and goes away on unlock. Details reopens the bar
// with its details row open.

import { THEMES, useStore } from "../../store";
import { accentsFor } from "../update-badge/UpdateDialog";
import { useLockStore } from "./lockState";
import {
  failuresSentence,
  formatLockedAt,
  LockIcon,
  unlockAndReport,
} from "./NewDeviceLockAlert";

export function useLockNoticeShown(): boolean {
  return useLockStore((s) => !!s.lock?.locked);
}

export function NewDeviceLockNotice({ onClose }: { onClose: () => void }) {
  const lock = useLockStore((s) => s.lock);
  const unlocking = useLockStore((s) => s.unlocking);
  const reopen = useLockStore((s) => s.reopen);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { amber: AMBER } = accentsFor(page.bg);

  if (!lock?.locked) return null;

  return (
    <div
      data-testid="new-device-lock-notice"
      className="flex flex-col gap-1.5 px-3 py-2.5"
      style={{
        borderBottom: `1px solid ${page.border}`,
        background: `${AMBER}17`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex" style={{ color: AMBER }}>
          <LockIcon />
        </span>
        <span
          className="flex-1 text-xs font-semibold"
          style={{ color: page.fg }}
        >
          New devices locked out
        </span>
        {lock.lockedAt !== null && lock.lockedAt > 0 && (
          <span className="text-[10px]" style={{ color: page.statusFg }}>
            {formatLockedAt(lock.lockedAt)}
          </span>
        )}
      </div>
      <div className="text-xs leading-snug" style={{ color: page.statusFg }}>
        {failuresSentence(lock.failures)} Your signed-in devices keep working.
      </div>
      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          disabled={unlocking}
          onClick={() => void unlockAndReport()}
          className="h-[26px] cursor-pointer rounded px-2.5 text-xs font-semibold disabled:cursor-default disabled:opacity-60"
          style={{ background: AMBER, color: page.bg, border: "none" }}
        >
          Unlock new devices
        </button>
        <button
          type="button"
          onClick={() => {
            reopen({ details: true });
            onClose();
          }}
          className="h-[26px] cursor-pointer rounded px-2.5 text-xs"
          style={{
            background: "transparent",
            color: page.fg,
            border: `1px solid ${page.border}`,
          }}
        >
          Details
        </button>
      </div>
    </div>
  );
}
