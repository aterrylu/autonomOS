import { useRef, useState } from "react";
import { ProviderIcon } from "../../components/ui/provider-icon";
import { THEMES, useStore } from "../../store";
import { CodexUsagePanel } from "./CodexUsagePanel";
import { type CodexUsageWindow, isCodexCredentialError } from "./types";
import { useCodexUsageData } from "./useCodexUsageData";
import { utilizationColor, windowLabel } from "./utils";

/**
 * A thin vertical rule that separates the Codex item from the Claude usage item
 * to its left. Both providers show similar "<span> <pct>%" numbers, so without a
 * separator they read as one run — this is the standard status-bar group divider
 * (cf. macOS menu bar / VS Code). Decorative + theme-colored.
 */
function Divider({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{ width: 1, height: 12, background: color, opacity: 0.85 }}
    />
  );
}

/** Inline "<label> <pct>%" for one window, colored by utilization. */
function WindowLabel({ window }: { window: CodexUsageWindow }) {
  const pct = Math.round(window.usedPercent);
  const label = windowLabel(window.windowMinutes) || "usage";
  return (
    <span title={`${label}: ${pct}% used`}>
      <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>{" "}
      <span style={{ color: utilizationColor(pct) }}>{pct}%</span>
    </span>
  );
}

/**
 * Codex usage summary in the status bar. Sits beside the Claude usage item and
 * mirrors its behavior, with one deliberate difference: when there's no Codex
 * signal (no login, no rollout → `needsData`) or the data is still loading, it
 * renders NOTHING — non-Codex users never see a Codex nag. It only appears once
 * there's something real to show.
 */
export function CodexUsageStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error } = useCodexUsageData();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Loading, unreachable, or no Codex signal → render nothing (no flash/nag).
  if (!data || error || data.needsData) return null;

  // An error with no fallback data to show: a compact, clickable indicator.
  if (data.error) {
    const credential = isCodexCredentialError(data.errorKind);
    return (
      <div className="relative flex items-center gap-2">
        <Divider color={page.statusFg} />
        <button
          ref={toggleRef}
          type="button"
          className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
          style={{ color: credential ? "#ea6c73" : "#e6b450" }}
          onClick={() => setOpen(!open)}
          title={data.error}
        >
          <ProviderIcon provider="codex" size={14} />
          {credential ? "err" : "delayed"}
        </button>
        {open && (
          <CodexUsagePanel
            data={data}
            onClose={() => setOpen(false)}
            toggleRef={toggleRef}
          />
        )}
      </div>
    );
  }

  const windows = [data.secondary, data.primary]
    .filter((w): w is CodexUsageWindow => w != null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  // Have a credential but no windows yet (e.g. never ran a turn) → stay hidden.
  if (windows.length === 0) return null;

  return (
    <div className="relative flex items-center gap-2">
      <Divider color={page.statusFg} />
      <button
        ref={toggleRef}
        type="button"
        className="inline-flex items-center gap-2 cursor-pointer hover:opacity-80"
        style={{ color: page.fg }}
        onClick={() => setOpen(!open)}
        title="Click for Codex rate limit details"
      >
        <ProviderIcon provider="codex" size={14} />
        {windows.map((w) => (
          <WindowLabel key={w.windowMinutes} window={w} />
        ))}
      </button>
      {open && (
        <CodexUsagePanel
          data={data}
          onClose={() => setOpen(false)}
          toggleRef={toggleRef}
        />
      )}
    </div>
  );
}
