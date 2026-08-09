import { useRef } from "react";
import { THEMES, useStore } from "../../store";
import { useClickOutside } from "../claude-usage/useClickOutside";
import {
  type CodexNamedLimit,
  type CodexUsageData,
  type CodexUsageWindow,
  isCodexCredentialError,
} from "./types";
import {
  timeAgo,
  timeUntilReset,
  utilizationColor,
  windowLabel,
  windowTitle,
} from "./utils";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

function formatPlan(plan?: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function ProgressBar({ pct }: { pct: number }) {
  const color = utilizationColor(pct);
  return (
    <div
      className="h-3 w-full rounded overflow-hidden"
      style={{ background: `${color}22` }}
    >
      <div
        className="h-full rounded transition-all"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </div>
  );
}

/** Present windows shortest→longest, so the panel always reads short-limit-first
 *  regardless of which field (primary/secondary) the source put each window in. */
function orderedWindows(
  ...windows: (CodexUsageWindow | null)[]
): CodexUsageWindow[] {
  return windows
    .filter((w): w is CodexUsageWindow => w != null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
}

/** One window row. Its title (Session/Weekly/Monthly) and span badge (5h/7d/30d)
 *  are BOTH derived from the window's own length — never from which field
 *  carried it — so the label can't contradict the span (e.g. "Weekly · 30d"). */
function WindowDetail({
  window,
  statusFg,
}: {
  window: CodexUsageWindow;
  statusFg: string;
}) {
  const pct = Math.round(window.usedPercent);
  const remaining = Math.max(0, 100 - pct);
  const span = windowLabel(window.windowMinutes);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">
          {windowTitle(window.windowMinutes)}
          {span && (
            <span className="ml-1" style={{ color: statusFg, fontWeight: 400 }}>
              · {span}
            </span>
          )}
        </span>
        <span style={{ color: utilizationColor(pct), fontWeight: 600 }}>
          {pct}% used
        </span>
      </div>
      <ProgressBar pct={pct} />
      <div
        className="flex items-center justify-between mt-1"
        style={{ color: statusFg }}
      >
        <span>{remaining}% remaining</span>
        {window.resetsAt && (
          <span>Resets in {timeUntilReset(window.resetsAt)}</span>
        )}
      </div>
    </div>
  );
}

/** A per-model / per-feature limit (Codex `additional_rate_limits`). Renders
 *  whichever of its windows are present, shortest first. */
function NamedLimit({
  limit,
  page,
}: {
  limit: CodexNamedLimit;
  page: PageTheme;
}) {
  return (
    <div
      className="mt-1 pt-2"
      style={{ borderTop: `1px solid ${page.border}` }}
    >
      <div className="mb-2 font-medium" style={{ color: page.statusFg }}>
        {limit.name}
      </div>
      {orderedWindows(limit.secondary, limit.primary).map((w) => (
        <WindowDetail
          key={w.windowMinutes}
          window={w}
          statusFg={page.statusFg}
        />
      ))}
    </div>
  );
}

/** Source line: real-time vs last-known-from-disk, with the snapshot's age. */
function SourceLine({ data }: { data: CodexUsageData }) {
  const live = data.source === "live";
  const glyph = live ? "●" : "◐";
  const color = live ? "#3fb950" : "#e6b450";
  const text = live
    ? "Live — from Codex usage API"
    : `Last-known — from rollout${data.snapshotAt ? ` · ${timeAgo(data.snapshotAt)}` : ""}`;
  return (
    <div className="flex items-center gap-1" style={{ color }}>
      <span aria-hidden>{glyph}</span>
      <span>{text}</span>
    </div>
  );
}

interface CodexUsagePanelProps {
  data: CodexUsageData;
  onClose: () => void;
  toggleRef?: React.RefObject<HTMLElement | null>;
}

export function CodexUsagePanel({
  data,
  onClose,
  toggleRef,
}: CodexUsagePanelProps) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose, toggleRef);

  const plan = formatPlan(data.planType ?? data.account.planType);

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-0 mb-1 min-w-[320px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
        zIndex: 50,
      }}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-sm">Codex Rate Limits</span>
        {plan && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "#23863622", color: "#238636" }}
          >
            {plan}
          </span>
        )}
      </div>

      {data.account.email && (
        <div className="mb-2" style={{ color: page.statusFg }}>
          {data.account.email}
        </div>
      )}

      <div className="mb-3">
        <SourceLine data={data} />
      </div>

      {/* Error/stale banner — `data.error` now also rides WITH numbers on
          every marked fallback (expired token / rate limit / outage serving
          the last-known snapshot). Red only for credential failures; a
          transient marker renders amber, matching the status bar's split. */}
      {data.error && (
        <div
          className="mb-3 rounded px-2 py-1.5"
          style={
            isCodexCredentialError(data.errorKind)
              ? { background: "#ea6c7315", color: "#ea6c73" }
              : { background: "#e6b45015", color: "#e6b450" }
          }
        >
          {data.error}
        </div>
      )}

      {/* Standard windows — shortest first, titled by their own length */}
      {orderedWindows(data.secondary, data.primary).map((w) => (
        <WindowDetail
          key={w.windowMinutes}
          window={w}
          statusFg={page.statusFg}
        />
      ))}

      {/* Per-model / per-feature limits (extensible) */}
      {data.additionalLimits.map((limit) => (
        <NamedLimit key={limit.id ?? limit.name} limit={limit} page={page} />
      ))}

      {/* Credits */}
      {data.credits?.hasCredits && (
        <div
          className="mt-1 pt-2 mb-2 flex items-center justify-between"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <span className="font-medium">Credits</span>
          <span style={{ color: page.statusFg }}>
            {data.credits.unlimited
              ? "Unlimited"
              : data.credits.balance != null
                ? `${data.credits.balance} left`
                : "Available"}
          </span>
        </div>
      )}

      {/* Read-only credential note — no key entry; the token is auto-read. */}
      <div
        className="mt-3 pt-2 flex items-start gap-1"
        style={{ borderTop: `1px solid ${page.border}`, color: page.statusFg }}
      >
        <span aria-hidden>ⓘ</span>
        <span className="flex-1">
          Reads your Codex login (~/.codex) read-only — never refreshes or
          writes it. Log in with <code>codex</code> to track usage.
        </span>
      </div>

      {/* Metadata */}
      <div className="mt-2" style={{ color: page.statusFg }}>
        Updated {timeAgo(data.fetchedAt)}
      </div>
    </div>
  );
}
