import { useMemo, useState } from "react";
import { useLockNoticeShown } from "../plugins/new-device-lock/NewDeviceLockNotice";
import { THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";
import { NotificationPanel } from "./NotificationPanel";

export function NotificationBell() {
  const notificationCounts = useStore((s) => s.notificationCounts);
  const [open, setOpen] = useState(false);
  const theme = useStore((s) => s.theme);
  // A new-device lock is pinned in the panel: it lights the dot too.
  const locked = useLockNoticeShown();

  const totalUnread = useMemo(
    () => Object.values(notificationCounts).reduce((sum, n) => sum + n, 0),
    [notificationCounts],
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 cursor-pointer hover:opacity-80"
        // The status bar's own foreground, per theme: a fixed white vanished on
        // Daylight's light bar (#513).
        style={{ color: THEMES[theme].page.statusFg }}
        title="Notifications"
      >
        <Codicon
          name={totalUnread > 0 || locked ? "bell-dot" : "bell"}
          size={14}
        />
      </button>
      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </div>
  );
}
