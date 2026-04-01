import { useMemo, useState } from "react";
import { useStore } from "../store";
import { Codicon } from "./Codicon";
import { NotificationPanel } from "./NotificationPanel";

export function NotificationBell() {
  const notificationCounts = useStore((s) => s.notificationCounts);
  const [open, setOpen] = useState(false);

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
        style={{ color: "#fff" }}
        title="Notifications"
      >
        <Codicon name={totalUnread > 0 ? "bell-dot" : "bell"} size={14} />
      </button>
      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </div>
  );
}
