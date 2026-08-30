/**
 * Hand-Off delivery overlay — a minimal, free-floating, draggable panel that
 * surfaces the messages queued for human hand-delivery to a manual-queue agent
 * (Gemini). Same interaction family as the auto-Enter control: it reuses
 * `useDraggableOverlay` (grip drag + keyboard nudge, per-terminal persisted
 * position, clamp + re-clamp on resize) and defaults to the pane's top-right,
 * stacked directly beneath the usage-queue overlay so the two never collide.
 *
 * AUTO-HIDE: it renders NOTHING until the queue is non-empty — the sidebar badge
 * is the surfacer. The queue is (re)fetched in an effect KEYED ON THE COUNT (not
 * a []-deps effect), so it re-fires on the real 0→N auto-show transition, not
 * only at first mount — the #340 conditional-mount trap.
 */

import type { HandoffQueueItem } from "@autonomos/core";
import { useEffect, useState } from "react";
import { agentsApi } from "../api/agents";
import { MARGIN, useDraggableOverlay } from "../hooks/useDraggableOverlay";
import { useStore } from "../store";

const YELLOW = "#e6b450"; // the accent (matches the usage overlay + envPreset pill)
const RED = "#ea6c73";
const HANDLE_WIDTH = 22;
// Wider than the first cut so each row can show a 2–3 line message preview and
// the actions are compact icon-buttons rather than text (Terry's density note).
const WIDTH = 340;
/** How many lines of the message preview to show before clamping. */
const PREVIEW_LINES = 3;
/** Stack beneath the usage-queue overlay (defaults to top:MARGIN, height ~34) +
 *  a gap, so at defaults the two overlays read as a clean vertical pair. */
const STACK_OFFSET = 46;

/** Two columns of dots — the conventional "drag me" grip (matches the usage
 *  overlay's affordance). */
function GripIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="16"
      viewBox="0 0 12 16"
      fill="currentColor"
      style={{ flexShrink: 0 }}
    >
      {[3, 8, 13].map((cy) =>
        [3, 9].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" />
        )),
      )}
    </svg>
  );
}

/** Paper-plane — the compact "deliver" affordance. */
function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  );
}

/** × — the compact "discard" affordance. */
function DiscardIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export function HandoffOverlay({ sessionId }: { sessionId: string }) {
  const count = useStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.pendingHandoffCount ?? 0,
  );
  // Hook called unconditionally (Rules of Hooks) — the auto-hide return is below.
  const { overlayRef, positionStyle, dragging, handleProps } =
    useDraggableOverlay(`handoffOverlayPos:${sessionId}`, {
      top: MARGIN + STACK_OFFSET,
      right: MARGIN,
    });

  const [items, setItems] = useState<HandoffQueueItem[]>([]);
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (count === 0) {
      setItems([]);
      setSending(new Set());
      setConfirmClear(false);
      return;
    }
    let cancelled = false;
    agentsApi.queueList(sessionId).then(
      (r) => {
        if (cancelled) return;
        setItems(r.items);
        // Drop "sending" marks for items that have since left the queue (their
        // receipt landed) — keep only ones still present + mid-send.
        setSending(
          (prev) =>
            new Set(
              [...prev].filter((id) => r.items.some((it) => it.id === id)),
            ),
        );
      },
      () => {
        /* transient — the next count delta refetches */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, count]);

  // AUTO-HIDE — nothing renders until the queue is non-empty (the badge surfaces it).
  if (count === 0) return null;

  const send = async (itemId: string) => {
    setError(null);
    setSending((s) => new Set(s).add(itemId));
    try {
      await agentsApi.queueSend(sessionId, itemId);
      // Leave it "delivering…" — it clears when the hook receipt drops the count
      // and the refetch removes it. A 409 (already in flight) rolls the mark back.
    } catch (e) {
      setError(errMsg(e));
      setSending((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
    }
  };

  const discard = async (itemId: string) => {
    setError(null);
    try {
      await agentsApi.queueDiscard(sessionId, itemId);
      setItems((it) => it.filter((x) => x.id !== itemId));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const sendAll = async () => {
    setError(null);
    setBusy(true);
    try {
      await agentsApi.queueSendAll(sessionId);
      setSending(new Set(items.map((it) => it.id)));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const discardAll = async () => {
    setError(null);
    setBusy(true);
    try {
      await agentsApi.queueDiscardAll(sessionId);
      setItems([]);
      setConfirmClear(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const border = "1px solid rgb(var(--border))";

  return (
    <div
      ref={overlayRef}
      data-testid="handoff-overlay"
      className="absolute z-10 flex flex-col overflow-hidden rounded-lg shadow-lg"
      style={{
        ...positionStyle,
        width: WIDTH,
        background: "rgb(var(--card))",
        border,
        color: "rgb(var(--foreground))",
      }}
    >
      {/* Header — grip + title + count. */}
      <div
        className="flex items-center gap-2 px-2 py-1.5"
        style={{ borderBottom: border }}
      >
        <button
          type="button"
          {...handleProps}
          aria-label="Drag to reposition the hand-off queue (arrow keys to nudge)"
          title="Drag to move"
          data-testid="handoff-drag-handle"
          className="flex items-center justify-center"
          style={{
            width: HANDLE_WIDTH,
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            border: "none",
            background: "transparent",
            color: YELLOW,
            opacity: 0.75,
          }}
        >
          <GripIcon />
        </button>
        <span className="text-xs font-semibold">Hand-off</span>
        <span
          className="text-[11px] leading-4"
          style={{
            color: YELLOW,
            border: `1px solid ${YELLOW}`,
            background: `${YELLOW}1f`,
            borderRadius: 999,
            padding: "0 6px",
          }}
        >
          {count}
        </span>
      </div>

      {/* List of queued messages. */}
      <div
        className="flex flex-col"
        style={{ maxHeight: 260, overflowY: "auto" }}
      >
        {items.map((it) => (
          <div
            key={it.id}
            className="flex flex-col gap-1 px-2.5 py-2"
            style={{ borderBottom: border }}
          >
            {/* Top line: sender + compact icon actions (or the delivering state). */}
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-[11px] font-semibold"
                style={{ color: YELLOW }}
              >
                {it.from}
              </span>
              {sending.has(it.id) ? (
                <span
                  className="shrink-0 text-[11px]"
                  style={{ color: YELLOW }}
                  data-testid="handoff-sending"
                >
                  delivering…
                </span>
              ) : (
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => discard(it.id)}
                    aria-label="Discard"
                    title="Discard"
                    className="flex items-center justify-center rounded"
                    style={{
                      width: 22,
                      height: 22,
                      color: RED,
                      border: `1px solid ${RED}40`,
                      background: "transparent",
                    }}
                  >
                    <DiscardIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => send(it.id)}
                    aria-label="Send"
                    title="Send"
                    className="flex items-center justify-center rounded"
                    style={{
                      width: 22,
                      height: 22,
                      color: "#17110a",
                      background: YELLOW,
                      border: `1px solid ${YELLOW}`,
                    }}
                  >
                    <SendIcon />
                  </button>
                </div>
              )}
            </div>
            {/* The message — a multi-line preview, clamped (Terry: show more content). */}
            <div
              className="text-xs"
              style={{
                color: "rgb(var(--muted-foreground))",
                display: "-webkit-box",
                WebkitLineClamp: PREVIEW_LINES,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                lineHeight: 1.4,
              }}
            >
              {it.message}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="px-2.5 py-1.5 text-[11px]" style={{ color: RED }}>
          {error}
        </div>
      )}

      {/* Footer — Send all (no confirm) · Discard all (inline confirm). */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5"
        style={{ borderTop: border }}
      >
        <span className="flex-1" />
        {confirmClear ? (
          <>
            <span className="text-[11px]" style={{ color: RED }}>
              Discard all?
            </span>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="text-[11px]"
              style={{
                background: "none",
                border: "none",
                color: "rgb(var(--muted-foreground))",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={discardAll}
              disabled={busy}
              className="text-[11px] font-semibold"
              style={{
                background: "none",
                border: "none",
                color: RED,
                cursor: "pointer",
              }}
            >
              Discard all
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="text-[11px]"
              style={{
                background: "none",
                border: "none",
                color: "rgb(var(--muted-foreground))",
                cursor: "pointer",
              }}
            >
              Discard all
            </button>
            <button
              type="button"
              onClick={sendAll}
              disabled={busy}
              className="text-[11px] font-semibold"
              style={{
                background: "none",
                border: "none",
                color: YELLOW,
                cursor: "pointer",
              }}
            >
              Send all →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
