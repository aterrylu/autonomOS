import { useEffect, useRef, useState } from "react";
import { focusTerminal } from "../hooks/useTerminal";
import { pushEscapeCloser } from "../shortcuts/escapeStack";
import { THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";

/** Inject the proactive glow keyframes once */
const GLOW_STYLE_ID = "notification-glow-keyframes";
if (
  typeof document !== "undefined" &&
  !document.getElementById(GLOW_STYLE_ID)
) {
  const el = document.createElement("style");
  el.id = GLOW_STYLE_ID;
  el.textContent = `
    @keyframes notification-glow {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(el);
}

export interface PanelNotification {
  event: string;
  message?: string;
  timestamp: number;
  read: boolean;
  proactive?: boolean;
  sessionId: string;
  sessionName: string;
}

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const PAGE_SIZE = 25;

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const switchPane = useStore((s) => s.switchPane);
  const sessions = useStore((s) => s.sessions);
  const page = THEMES[theme].page;
  const ref = useRef<HTMLDivElement>(null);

  const [notifications, setNotifications] = useState<PanelNotification[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingRead, setMarkingRead] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    fetch("/api/hooks/notifications")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setNotifications(data.notifications ?? []);
        setTotalUnread(data.totalUnread ?? 0);
      })
      .catch((err) => {
        setError("Failed to load notifications");
        console.warn("[NotificationPanel] fetch error:", err);
      })
      .finally(() => setLoading(false));
  }, []);

  // Latest-closer ref: the bell passes an inline arrow, and re-registering on
  // identity churn (it re-renders on every notification) would move this panel
  // to the top of the escape stack — see useClickOutside for the full note.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape rides the registry's ui.dismiss entry via the escape stack
  // (ADR-065); the old document keydown listener was bubble-phase and thus
  // dead whenever a terminal had focus.
  useEffect(() => pushEscapeCloser(() => closeRef.current()), []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeRef.current();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, []);

  async function handleMarkAllRead() {
    if (markingRead) return;
    setMarkingRead(true);
    const unreadSessionIds = [
      ...new Set(notifications.filter((n) => !n.read).map((n) => n.sessionId)),
    ];
    const results = await Promise.allSettled(
      unreadSessionIds.map(async (id) => {
        const res = await fetch(`/api/hooks/${id}/read`, { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return id;
      }),
    );
    const succeeded = new Set(
      results
        .filter(
          (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
        )
        .map((r) => r.value),
    );
    setNotifications((prev) =>
      prev.map((n) => (succeeded.has(n.sessionId) ? { ...n, read: true } : n)),
    );
    setTotalUnread((prev) =>
      Math.max(
        0,
        prev -
          notifications.filter((n) => !n.read && succeeded.has(n.sessionId))
            .length,
      ),
    );
    useStore.getState().fetchNotifications();
    setMarkingRead(false);
  }

  function handleClickNotification(n: PanelNotification) {
    const session = sessions.find((s) => s.id === n.sessionId);
    if (session) {
      switchPane({ type: "session", id: session.id });
      focusTerminal(session.id);
    }
    onClose();
  }

  const shown = notifications.slice(0, visible);
  const hasMore = notifications.length > visible;

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-1 w-[380px] rounded-md shadow-2xl overflow-hidden"
      style={{
        maxHeight: "60vh",
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase tracking-wide"
          style={{ color: page.statusFg }}
        >
          Notifications
          {totalUnread > 0 && (
            <span
              className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full normal-case tracking-normal"
              style={{ background: "#ea6c73", color: "#fff" }}
            >
              {totalUnread} unread
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {totalUnread > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={markingRead}
              className="text-[10px] cursor-pointer hover:opacity-80 disabled:opacity-50"
              style={{ color: "#16825d" }}
            >
              Mark all read
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer hover:opacity-80"
            style={{ color: page.statusFg }}
          >
            <Codicon name="close" size={12} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div
            className="px-3 py-8 text-center text-xs"
            style={{ color: "#ea6c73" }}
          >
            {error}
          </div>
        )}

        {!error && loading && (
          <div
            className="px-3 py-8 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            Loading...
          </div>
        )}

        {!error && !loading && notifications.length === 0 && (
          <div
            className="px-3 py-8 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No notifications yet. Agents will appear here when they send
            messages via --brief.
          </div>
        )}

        {shown.map((n, i) => (
          <NotificationRow
            // biome-ignore lint/suspicious/noArrayIndexKey: notifications lack unique IDs
            key={`${n.sessionId}-${n.timestamp}-${i}`}
            notification={n}
            page={page}
            onClick={() => handleClickNotification(n)}
          />
        ))}

        {hasMore && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="w-full py-2 text-[10px] cursor-pointer hover:opacity-80"
            style={{ color: "#16825d", borderTop: `1px solid ${page.border}` }}
          >
            Load more ({notifications.length - visible} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

function NotificationRow({
  notification: n,
  page,
  onClick,
}: {
  notification: PanelNotification;
  page: { bg: string; fg: string; border: string; statusFg: string };
  onClick: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="relative"
      style={n.proactive ? { padding: "1px" } : undefined}
    >
      {/* Proactive glow border */}
      {n.proactive && (
        <div
          className="absolute inset-0 rounded overflow-hidden pointer-events-none"
          style={{ zIndex: 0 }}
        >
          <div
            style={{
              position: "absolute",
              inset: "-50%",
              background:
                "conic-gradient(transparent 0%, #402fb5 15%, transparent 30%, transparent 50%, #cf30aa 65%, transparent 80%)",
              animation: "notification-glow 3s linear infinite",
              filter: "blur(3px)",
            }}
          />
        </div>
      )}

      <button
        type="button"
        className="relative w-full text-left px-3 py-2 cursor-pointer transition-colors"
        style={{
          background: n.proactive ? "#0d0b1a" : page.bg,
          borderBottom: `1px solid ${page.border}`,
          borderRadius: n.proactive ? "4px" : undefined,
          zIndex: 1,
        }}
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          {n.proactive && (
            <span
              className="text-[9px] px-1 py-px rounded font-medium uppercase tracking-wider"
              style={{
                background: "#402fb530",
                color: "#a099d8",
                border: "1px solid #402fb540",
              }}
            >
              proactive
            </span>
          )}
          {n.event === "SystemWarning" && (
            <span
              className="text-[9px] px-1 py-px rounded font-medium uppercase tracking-wider"
              style={{
                background: "#d1991930",
                color: "#d19919",
                border: "1px solid #d1991940",
              }}
            >
              warning
            </span>
          )}
          <span
            className="text-[11px] font-medium truncate"
            style={{ color: n.read ? page.statusFg : page.fg }}
          >
            {n.sessionName}
          </span>
          <span
            className="text-[10px] ml-auto shrink-0"
            style={{ color: page.statusFg }}
          >
            {relativeTime(n.timestamp)}
          </span>
          {!n.read && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: "#ea6c73" }}
            />
          )}
        </div>

        {n.message && (
          // biome-ignore lint/a11y/noStaticElementInteractions: expand toggle
          // biome-ignore lint/a11y/useKeyWithClickEvents: expand toggle
          <div
            className={`text-[11px] leading-relaxed ${expanded ? "" : "line-clamp-2"}`}
            style={{ color: n.read ? page.statusFg : page.fg, opacity: 0.85 }}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {n.message}
          </div>
        )}
      </button>
    </div>
  );
}
