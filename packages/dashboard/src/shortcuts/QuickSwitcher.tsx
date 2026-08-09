import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentStatus,
  AgentStatusIcon,
} from "../components/ui/agent-status-icon";
import { ProviderAgentIcon } from "../components/ui/provider-icon";
import { THEMES, useStore } from "../store";
import { focusAgentById } from "./actions";
import { pushEscapeCloser } from "./escapeStack";
import { rankAgents } from "./fuzzyAgent";

const MAX_RESULTS = 12;

/**
 * The ⌘K agent quick-switcher (see the quick-switcher ADR in DECISIONS.md):
 * type a few letters of an agent's name, Enter to switch. The registry's
 * third overlay client — reuses the escape stack for dismissal and the
 * HelpDialog focus-restore pattern. Candidates are ALL live sessions
 * (including agents hidden by a collapsed hierarchy group — search is the
 * escape hatch that reaches them); ranking prefers the sidebar's rendered
 * order for ties and the empty query.
 */
export function QuickSwitcher() {
  const open = useStore((s) => s.quickSwitchOpen);
  if (!open) return null;
  return <SwitcherDialog />;
}

function SwitcherDialog() {
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const rowOrder = useStore((s) => s.sidebarRowOrder);
  const agentStatuses = useStore((s) => s.agentStatuses);
  const agentIconStyle = useStore((s) => s.agentIconStyle);
  const page = THEMES[theme].page;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Selection tracks the agent ID, not a list index: the session list repolls
  // every few seconds and fresh arrivals reorder it — an index could silently
  // come to point at a DIFFERENT agent between the arrow-press and Enter.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // True once an agent was chosen: the unmount cleanup must NOT restore focus
  // to the previously-focused element — focusTerminal is about to claim it
  // for the chosen agent's terminal.
  const choseRef = useRef(false);

  // Escape rides the registry's ui.dismiss via the stack, like every overlay.
  useEffect(
    () => pushEscapeCloser(() => useStore.getState().closeQuickSwitch()),
    [],
  );

  // Focus the input on open; restore focus on close unless an agent was
  // chosen (then the target terminal owns focus).
  useEffect(() => {
    const prev = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (choseRef.current) return;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);

  const ranked = useMemo(
    () =>
      rankAgents(
        query.trim(),
        sessions.map((s) => ({ id: s.id, name: s.name })),
        rowOrder,
      ),
    [query, sessions, rowOrder],
  );
  const matches = ranked.slice(0, MAX_RESULTS);

  // Derive the highlighted index from the selected ID; fall back to the top
  // result whenever the selection is gone (filtered out, agent exited).
  const selectedIndex = Math.max(
    0,
    matches.findIndex((m) => m.id === selectedId),
  );

  // Keep the highlighted row visible when arrowing past the fold.
  // (Optional call: jsdom implements Element without scrollIntoView.)
  useEffect(() => {
    listRef.current?.children[selectedIndex]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [selectedIndex]);

  function choose(id: string | undefined) {
    if (id === undefined) return;
    choseRef.current = true;
    useStore.getState().closeQuickSwitch();
    focusAgentById(id);
  }

  function moveSelection(delta: 1 | -1) {
    if (matches.length === 0) return;
    const next = Math.max(
      0,
      Math.min(selectedIndex + delta, matches.length - 1),
    );
    setSelectedId(matches[next]?.id ?? null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[selectedIndex]?.id);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; keyboard close is the registry's ui.dismiss (Escape)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is the registry's ui.dismiss (Escape)
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget)
          useStore.getState().closeQuickSwitch();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch to agent"
        className="w-[480px] max-w-[90vw] rounded-lg shadow-xl overflow-hidden"
        style={{
          background: page.bg,
          color: page.fg,
          border: `1px solid ${page.border}`,
        }}
      >
        <input
          ref={inputRef}
          data-testid="quick-switcher-input"
          role="combobox"
          aria-label="Switch to agent"
          aria-expanded={matches.length > 0}
          aria-controls="quick-switcher-list"
          aria-activedescendant={
            matches[selectedIndex]
              ? `qs-option-${matches[selectedIndex].id}`
              : undefined
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedId(null); // back to the top result
          }}
          onKeyDown={onKeyDown}
          placeholder="Switch to agent…"
          className="w-full px-4 py-3 text-sm outline-none"
          style={{
            background: page.bg,
            color: page.fg,
            border: "none",
            borderBottom: `1px solid ${page.border}`,
          }}
        />
        {/* ARIA combobox pattern: focus stays on the input, which points at
            the active option via aria-activedescendant. role="option" sits on
            the buttons themselves (focusable, tabIndex -1) and the container
            is a neutral div — satisfying both the pattern and the a11y lints. */}
        <div
          ref={listRef}
          id="quick-switcher-list"
          role="listbox"
          aria-label="Matching agents"
          className="max-h-[40vh] overflow-y-auto py-1"
        >
          {matches.length === 0 && (
            <div
              aria-live="polite"
              className="px-4 py-3 text-xs text-center"
              style={{ color: page.statusFg }}
            >
              No matching agents
            </div>
          )}
          {matches.map((m, i) => (
            <button
              key={m.id}
              id={`qs-option-${m.id}`}
              role="option"
              aria-selected={i === selectedIndex}
              type="button"
              data-testid="quick-switcher-item"
              tabIndex={-1}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs cursor-pointer"
              style={{
                background: i === selectedIndex ? page.border : "transparent",
                color: page.fg,
                border: "none",
              }}
              onMouseEnter={() => setSelectedId(m.id)}
              onClick={() => choose(m.id)}
            >
              {agentIconStyle === "provider" ? (
                <ProviderAgentIcon
                  provider={sessions.find((s) => s.id === m.id)?.provider}
                  status={
                    (agentStatuses[m.id]?.status as AgentStatus) ?? "unknown"
                  }
                  size={14}
                />
              ) : (
                <AgentStatusIcon
                  status={
                    (agentStatuses[m.id]?.status as AgentStatus) ?? "unknown"
                  }
                  size={12}
                />
              )}
              <span className="flex-1 truncate">{m.name}</span>
            </button>
          ))}
          {ranked.length > MAX_RESULTS && (
            <div
              className="px-4 py-1.5 text-[10px] text-center"
              style={{ color: page.statusFg }}
              aria-live="polite"
            >
              {matches.length} of {ranked.length} — keep typing to narrow
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
