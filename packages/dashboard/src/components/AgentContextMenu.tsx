/**
 * Right-click context menu for agent rows (ADR-093).
 *
 * ONE component serves two surfaces with different data models via a normalized
 * `AgentMenuTarget`: the sidebar tree's running `SessionRow`s and the Projects
 * panel's exited rows (whose session-summary model carries no agent id — the
 * caller resolves it from `exitedSessions` before opening the menu).
 *
 * Interaction invariants (each load-bearing, each pinned by a test):
 *  - Dismissal rides the ADR-065 escape stack (`pushEscapeCloser` on open) —
 *    NO ad-hoc document Escape listener (bubble-phase is dead under terminal focus).
 *  - The contextmenu trigger is scoped to the ROW element by the caller; this
 *    component never attaches a document-level `contextmenu` handler (xterm owns
 *    right-click inside terminal panes, ADR-072).
 *  - Click-away is a menu-scoped capture-phase `pointerdown` listener, added on
 *    open and removed on close — it lives with the menu, not the document.
 *  - Items NEVER wrap (`white-space: nowrap` + a menu `min-width`) — a context
 *    menu item wrapping to two lines is a layout-invariant violation. Tested
 *    against the longest label.
 *  - Delete is guarded by an in-place inline confirm (no modal, no undo-toast):
 *    "Delete…" swaps to "Delete permanently? · Cancel / Delete", so the
 *    permanence warning lands at decision time and a stray click can't destroy a
 *    record.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusTerminal } from "../hooks/useTerminal";
import { pushEscapeCloser } from "../shortcuts/escapeStack";
import { type THEMES, useStore } from "../store";
import { isLightBg } from "./recency";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

/** Normalized menu subject — built from a `SessionInfo` (running) or a resolved
 *  exited record (Projects). `id` is the agent-record id; it is absent only for
 *  a purely external exited session with no autonomOS record (Resume-only). */
export interface AgentMenuTarget {
  /** Agent record id — required for kill/restart/set-manager/delete. */
  id?: string;
  name: string;
  status: "running" | "exited";
  /** Current manager name, for the set-manager submenu's checkmark. */
  manager?: string;
  /** CC/provider session id — the resume key for exited agents. */
  resumeKey?: string;
  workingDirectory?: string;
  isAutonomosAgent?: boolean;
}

export interface AgentContextMenuProps {
  target: AgentMenuTarget;
  /** Viewport coordinates of the right-click, where the menu opens. */
  x: number;
  y: number;
  page: PageTheme;
  onClose: () => void;
}

type Group = "process" | "record" | "danger";
interface Item {
  key: string;
  label: string;
  icon: string;
  group: Group;
  onSelect: () => void;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  primary?: boolean;
  submenu?: boolean;
}

const MENU_MIN_WIDTH = 194;

interface PopColors {
  bg: string;
  border: string;
  hover: string;
  danger: string;
  dangerTint: string;
  dangerRing: string;
}
function popoverColors(isLight: boolean): PopColors {
  return {
    bg: isLight ? "#ffffff" : "#141517",
    border: isLight ? "#e1e4e8" : "#2a2c30",
    hover: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.07)",
    danger: isLight ? "#c0392b" : "#e5705f",
    dangerTint: isLight ? "rgba(192,57,43,0.06)" : "rgba(229,112,95,0.05)",
    dangerRing: isLight ? "rgba(192,57,43,0.20)" : "rgba(229,112,95,0.20)",
  };
}

function rowStyle(
  it: Pick<Item, "disabled" | "destructive" | "primary">,
  page: PageTheme,
  c: PopColors,
  hovered: boolean,
): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "nowrap",
    padding: "4px 8px",
    borderRadius: 5,
    fontSize: 11.5,
    lineHeight: 1.4,
    color: it.destructive ? c.danger : page.fg,
    opacity: it.disabled ? 0.36 : 1,
    fontWeight: it.primary ? 650 : 400,
    background: hovered && !it.disabled ? c.hover : "transparent",
    cursor: it.disabled ? "default" : "pointer",
    width: "100%",
    textAlign: "left",
    border: "none",
    outline: "none",
  };
}

/** Hoisted to module scope: a menu item defined inside the parent would be a new
 *  component type every render, remounting all items and dropping keyboard focus. */
function MenuItemButton({
  it,
  page,
  c,
}: {
  it: Item;
  page: PageTheme;
  c: PopColors;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={it.disabled ? "true" : undefined}
      tabIndex={-1}
      title={it.disabled ? it.disabledReason : undefined}
      style={rowStyle(it, page, c, hover)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => {
        if (!it.disabled) it.onSelect();
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          flex: "0 0 14px",
          textAlign: "center",
          opacity: 0.85,
        }}
      >
        {it.icon}
      </span>
      <span style={{ flex: "1 1 auto", whiteSpace: "nowrap" }}>{it.label}</span>
      {it.submenu && (
        <span aria-hidden="true" style={{ color: page.statusFg }}>
          ▸
        </span>
      )}
    </button>
  );
}

export function AgentContextMenu({
  target,
  x,
  y,
  page,
  onClose,
}: AgentContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"main" | "managers">("main");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const switchPane = useStore((s) => s.switchPane);
  const killSession = useStore((s) => s.killSession);
  const restartSession = useStore((s) => s.restartSession);
  const resumeSession = useStore((s) => s.resumeSession);
  const removeSession = useStore((s) => s.removeSession);
  const setManager = useStore((s) => s.setManager);
  const sessions = useStore((s) => s.sessions);

  const isLight = isLightBg(page.bg);
  const c = popoverColors(isLight);

  // Escape-to-close via the shared LIFO stack. Registered only while mounted
  // (the parent mounts this component only when the menu is open), so the
  // cleanup returned by pushEscapeCloser fires exactly on close/unmount.
  useEffect(() => pushEscapeCloser(onClose), [onClose]);

  // Click-away: a capture-phase pointerdown outside the menu closes it. Scoped
  // to this menu's lifetime — not a standing document listener.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // Clamp into the viewport: flip left/up when the menu would overflow the
  // right/bottom edge. Measured post-layout so it uses the real rendered size.
  // `view`/`confirmingDelete` are intentional re-run triggers, not read values:
  // switching to the manager list or the confirm prompt changes the menu's size,
  // so it must re-measure and re-clamp.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure after the menu's content/size changes
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + width > window.innerWidth - pad)
      left = Math.max(pad, window.innerWidth - width - pad);
    if (top + height > window.innerHeight - pad)
      top = Math.max(pad, window.innerHeight - height - pad);
    setPos({ left, top });
  }, [x, y, view, confirmingDelete, deleteError]);

  // Move DOM focus to the first enabled item on open / view change, so the menu
  // is immediately keyboard-navigable and arrow keys have an anchor. Same intent:
  // `view`/`confirmingDelete` are re-run triggers so focus follows a view switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-focus the first item after a view/confirm change
  useLayoutEffect(() => {
    const first = menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    first?.focus();
  }, [view, confirmingDelete]);

  // Roving focus: ↑/↓ cycle enabled items; Escape handled by the stack but also
  // caught here so it never leaks to the row/terminal beneath.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  }

  // ── Build the item list for this target/status ──────────────────────────
  const canAct = !!target.id; // agent-record actions need an id
  const items: Item[] = [];
  if (target.status === "running") {
    items.push(
      {
        key: "open",
        label: "Open",
        icon: "⌖",
        group: "process",
        disabled: !canAct,
        disabledReason: "No autonomOS record for this session",
        onSelect: () => {
          if (target.id) {
            switchPane({ type: "session", id: target.id });
            focusTerminal(target.id);
          }
          onClose();
        },
      },
      {
        key: "restart",
        label: "Restart",
        icon: "↻",
        group: "process",
        disabled: !canAct,
        disabledReason: "No autonomOS record for this session",
        onSelect: () => {
          if (target.id) restartSession(target.id);
          onClose();
        },
      },
      {
        key: "kill",
        label: "Kill",
        icon: "■",
        group: "process",
        disabled: !canAct,
        disabledReason: "No autonomOS record for this session",
        onSelect: () => {
          if (target.id) killSession(target.id);
          onClose();
        },
      },
    );
  } else {
    items.push({
      key: "resume",
      label: "Resume",
      icon: "▷",
      group: "process",
      primary: true,
      disabled: !target.resumeKey || !target.workingDirectory,
      onSelect: () => {
        if (target.resumeKey && target.workingDirectory) {
          resumeSession(
            target.resumeKey,
            target.workingDirectory,
            target.name,
            { isAutonomosAgent: target.isAutonomosAgent },
          ).catch(() => {});
        }
        onClose();
      },
    });
  }

  // Set manager + Delete — only when there is an agent record to act on.
  if (canAct) {
    items.push({
      key: "manager",
      label: "Set manager",
      icon: "⤳",
      group: "record",
      submenu: true,
      onSelect: () => setView("managers"),
    });
    items.push({
      key: "delete",
      label: "Delete…",
      icon: "🗑",
      group: "danger",
      destructive: true,
      onSelect: () => setConfirmingDelete(true),
    });
  }

  const shell: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    zIndex: 1000,
    minWidth: MENU_MIN_WIDTH,
    padding: 4,
    borderRadius: 7,
    background: c.bg,
    border: `1px solid ${c.border}`,
    boxShadow: isLight
      ? "0 8px 24px rgba(0,0,0,0.14)"
      : "0 8px 24px rgba(0,0,0,0.5)",
  };
  const divider = (
    <div style={{ height: 1, margin: "4px 6px", background: c.border }} />
  );

  // ── Manager drill-in ────────────────────────────────────────────────────
  if (view === "managers") {
    // Exclude the target itself AND its descendants — the server rejects a
    // reparent that would form a cycle (409), which would otherwise be a silent
    // snap-back. Walk the manager graph (manager === name) down from the target.
    const descendants = new Set<string>();
    const queue = [target.name];
    while (queue.length > 0) {
      const parent = queue.shift();
      if (parent === undefined) continue;
      for (const s of sessions) {
        if (s.manager === parent && !descendants.has(s.name)) {
          descendants.add(s.name);
          queue.push(s.name);
        }
      }
    }
    const candidates = sessions.filter(
      (s) => s.name !== target.name && !descendants.has(s.name),
    );
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Set manager for ${target.name}`}
        style={shell}
        onKeyDown={onKeyDown}
      >
        <MenuItemButton
          page={page}
          c={c}
          it={{
            key: "back",
            label: "Manager",
            icon: "‹",
            group: "record",
            onSelect: () => setView("main"),
          }}
        />
        {divider}
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          <MenuItemButton
            page={page}
            c={c}
            it={{
              key: "clear",
              label: "Clear manager",
              icon: "∅",
              group: "record",
              disabled: !target.manager,
              disabledReason: "No manager set",
              onSelect: () => {
                if (target.id) setManager(target.id, null);
                onClose();
              },
            }}
          />
          {candidates.map((s) => (
            <MenuItemButton
              key={s.id}
              page={page}
              c={c}
              it={{
                key: s.id,
                label: `${target.manager === s.name ? "✓ " : ""}${s.name}`,
                icon: "○",
                group: "record",
                onSelect: () => {
                  if (target.id) setManager(target.id, s.name);
                  onClose();
                },
              }}
            />
          ))}
          {candidates.length === 0 && (
            <div
              style={{ padding: "6px 9px", fontSize: 11, color: page.statusFg }}
            >
              No other agents
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main view ───────────────────────────────────────────────────────────
  const process = items.filter((i) => i.group === "process");
  const record = items.filter((i) => i.group === "record");
  const danger = items.filter((i) => i.group === "danger");

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${target.name}`}
      style={shell}
      onKeyDown={onKeyDown}
    >
      {process.map((it) => (
        <MenuItemButton key={it.key} it={it} page={page} c={c} />
      ))}
      {record.length > 0 && divider}
      {record.map((it) => (
        <MenuItemButton key={it.key} it={it} page={page} c={c} />
      ))}
      {danger.length > 0 && (
        <div
          style={{
            margin: "4px 3px 0",
            padding: "3px 0",
            borderRadius: 5,
            background: c.dangerTint,
            border: `1px solid ${c.dangerRing}`,
          }}
        >
          {confirmingDelete ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                fontSize: 11.5,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ flex: "1 1 auto", color: c.danger }}>
                {deleteError
                  ? `Delete failed: ${deleteError}`
                  : "Delete permanently?"}
              </span>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                style={{
                  border: "none",
                  background: "transparent",
                  color: page.statusFg,
                  cursor: "pointer",
                  fontSize: 11,
                }}
                onClick={() => {
                  setConfirmingDelete(false);
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={deleting ? "true" : undefined}
                style={{
                  border: "none",
                  background: "transparent",
                  color: c.danger,
                  cursor: deleting ? "default" : "pointer",
                  opacity: deleting ? 0.5 : 1,
                  fontSize: 11,
                  fontWeight: 650,
                }}
                // Await the delete: removeSession rethrows the typed ApiError, so
                // on failure we keep this confirm open and show the reason rather
                // than closing as if it worked. onClose only on success.
                onClick={async () => {
                  if (!target.id) {
                    onClose();
                    return;
                  }
                  if (deleting) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await removeSession(target.id);
                    onClose();
                  } catch (err) {
                    setDeleteError(
                      err instanceof Error ? err.message : String(err),
                    );
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          ) : (
            danger.map((it) => (
              <MenuItemButton key={it.key} it={it} page={page} c={c} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
