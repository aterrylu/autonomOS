import { useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
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

/** Inline "<label> <pct>%" for one window, colored by utilization. `name`
 * overrides the window-length label, for a named limit that shows its own. */
function WindowLabel({
  window,
  name,
}: {
  window: CodexUsageWindow;
  name?: string;
}) {
  const pct = Math.round(window.usedPercent);
  const label = name ?? (windowLabel(window.windowMinutes) || "usage");
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

  // Loading or no Codex signal → render nothing (no flash/nag). A client-side
  // poll failure (`error`) only hides the item when there's no prior data —
  // with data, the numbers keep rendering and the glyph below marks the
  // failure, same as the Claude bar.
  if (!data || data.needsData) return null;

  const windows = [data.secondary, data.primary]
    .filter((w): w is CodexUsageWindow => w != null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);

  // An error with no fallback data to show: a compact, clickable indicator.
  // With windows present, `data.error` is a marked fallback (e.g. expired
  // token served from the rollout snapshot) — the numbers render below with a
  // warning glyph instead of being replaced by this pill.
  if (data.error && windows.length === 0) {
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

  // Have a credential but no windows yet (e.g. never ran a turn) → stay hidden.
  if (windows.length === 0) return null;

  // The usage-queue caps on the max across primary/secondary AND every named
  // limit — so when a named limit exceeds both headline windows, surface it
  // here too, or the bar and the queue button appear to disagree.
  const headlineMax = Math.max(...windows.map((w) => w.usedPercent));
  const named = data.additionalLimits
    .flatMap((l) =>
      [l.primary, l.secondary]
        .filter((w): w is CodexUsageWindow => w != null)
        .map((w) => ({ window: w, name: l.name })),
    )
    .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
  const showNamed = named && named.window.usedPercent > headlineMax;

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
        {showNamed && <WindowLabel window={named.window} name={named.name} />}
        {(data.error || error) && (
          <span
            title={
              data.error ?? (error ? `Usage refresh failing: ${error}` : "")
            }
            style={{
              color: isCodexCredentialError(data.errorKind)
                ? "#ea6c73"
                : "#e6b450",
              display: "inline-flex",
            }}
          >
            <Codicon name="warning" size={12} />
          </span>
        )}
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
