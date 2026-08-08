import { useCallback, useEffect, useRef, useState } from "react";
import type { CopyToastState } from "../components/CopyToast";
import { THEMES, useStore } from "../store";
import { acquireTerminal, getLiveTerminal } from "../terminal/liveTerminals";
import {
  COPY_TOAST_DISPLAY_MS,
  shouldSuppressCopyToast,
} from "../utils/copyToast";

// Re-exports: the focus registry and key policy moved to the keep-alive
// terminal module (ADR: terminal instance keep-alive), but their public import
// site stays here — Sidebar/NotificationPanel/shortcut actions and the
// key-policy tests all import from this hook module.
export { focusTerminal, handleKeyEvent } from "../terminal/liveTerminals";

/**
 * Borrows the KEEP-ALIVE terminal for `sessionId` while mounted.
 *
 * The xterm instance, its scrollback buffer, and its WebSocket live in
 * `terminal/liveTerminals.ts` and SURVIVE unmount — dockview re-creates panels
 * on every agent switch (ADR-047's accepted teardown), and before the cache
 * that meant disposing the terminal + re-streaming the entire scrollback from
 * the server on every switch. This hook only reparents the cached terminal's
 * host element into this mount's container and points the per-mount callbacks
 * (copy toast) at this mount.
 */
export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
) {
  // Transient "Copied N chars" confirmation for OSC 52 auto-copy. State drives
  // the CopyToast overlay; refs hold the coalescing/auto-dismiss bookkeeping so
  // the handler stays stable across renders.
  const [copyToast, setCopyToast] = useState<CopyToastState | null>(null);
  const copyToastIdRef = useRef(0);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCopyTextRef = useRef<string | null>(null);
  const lastCopyAtRef = useRef(0);

  const handleClipboardCopy = useCallback(
    ({ text, ok }: { text: string; ok: boolean }) => {
      const now = Date.now();
      // Coalesce streaming re-syncs of an unchanged selection into one toast.
      if (
        shouldSuppressCopyToast(
          { text: lastCopyTextRef.current, at: lastCopyAtRef.current },
          { text, ok, at: now },
        )
      ) {
        lastCopyAtRef.current = now;
        return;
      }
      lastCopyTextRef.current = text;
      lastCopyAtRef.current = now;
      copyToastIdRef.current += 1;
      setCopyToast({ id: copyToastIdRef.current, chars: [...text].length, ok });
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = setTimeout(
        () => setCopyToast(null),
        COPY_TOAST_DISPLAY_MS,
      );
    },
    [],
  );

  // Clear the pending dismiss timer on unmount.
  useEffect(
    () => () => {
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    },
    [],
  );

  const theme = useStore((s) => s.theme);
  const setStatus = useStore((s) => s.setStatus);

  // Track whether this session is the active one.
  const activePane = useStore((s) => s.activePane);
  const isActive =
    activePane?.type === "session" && activePane.id === sessionId;

  // Auto-clear unread notifications whenever this session is active and has unreads
  const markRead = useStore((s) => s.markNotificationsRead);
  const unreadCount = useStore((s) => s.notificationCounts[sessionId] ?? 0);
  useEffect(() => {
    if (isActive && unreadCount > 0) {
      markRead(sessionId);
    }
  }, [isActive, unreadCount, sessionId, markRead]);

  // Attach the keep-alive terminal for this session to this mount's container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const entry = acquireTerminal(sessionId);
    if (!entry) {
      const store = useStore.getState();
      if (
        store.activePane?.type === "session" &&
        store.activePane.id === sessionId
      ) {
        setStatus("terminal failed to load");
      }
      container.textContent =
        "Terminal failed to initialize. Reload the dashboard to retry.";
      container.style.cssText =
        "color:#ea6c73;padding:16px;font-size:13px;font-family:monospace";
      return;
    }

    entry.attach(container, { onClipboardCopy: handleClipboardCopy });

    return () => {
      entry.detach();
    };
  }, [sessionId, setStatus, containerRef, handleClipboardCopy]);

  // Focus terminal when it becomes the active session
  useEffect(() => {
    if (isActive) {
      getLiveTerminal(sessionId)?.terminal.focus();
    }
  }, [isActive, sessionId]);

  // Update theme on the live terminal
  useEffect(() => {
    const entry = getLiveTerminal(sessionId);
    if (entry) {
      entry.terminal.options.theme = THEMES[theme].terminal;
    }
  }, [theme, sessionId]);

  return { copyToast };
}
