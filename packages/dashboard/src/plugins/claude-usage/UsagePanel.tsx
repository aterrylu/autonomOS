import { useRef } from "react";
import { THEMES, useStore } from "../../store";
import type { DisplayMode, RateLimitData, RateLimitWindow } from "./types";
import { useClickOutside } from "./useClickOutside";
import { timeUntilReset, utilizationColor } from "./utils";

function formatPlan(sub?: string): string {
  if (!sub) return "Unknown";
  return `Claude ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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

function WindowDetail({
  label,
  description,
  window,
  statusFg,
}: {
  label: string;
  description: string;
  window: RateLimitWindow;
  statusFg: string;
}) {
  const pct = Math.round(window.utilization);
  const remaining = Math.max(0, 100 - pct);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{label}</span>
        <span style={{ color: utilizationColor(pct), fontWeight: 600 }}>
          {pct}% used
        </span>
      </div>
      <ProgressBar pct={pct} />
      <div
        className="flex items-center justify-between mt-1"
        style={{ color: statusFg }}
      >
        <span>{description}</span>
        <span>{remaining}% remaining</span>
      </div>
      {window.resetsAt && (
        <div className="mt-0.5" style={{ color: statusFg }}>
          Resets in {timeUntilReset(window.resetsAt)}
          <span className="ml-1" style={{ opacity: 0.6 }}>
            ({new Date(window.resetsAt).toLocaleTimeString()})
          </span>
        </div>
      )}
    </div>
  );
}

interface UsagePanelProps {
  data: RateLimitData;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  onClose: () => void;
  toggleRef?: React.RefObject<HTMLElement | null>;
}

export function UsagePanel({
  data,
  displayMode,
  onDisplayModeChange,
  onClose,
  toggleRef,
}: UsagePanelProps) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose, toggleRef);

  const acct = data.account;

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-0 mb-1 min-w-[320px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
      }}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-sm">Claude Rate Limits</span>
        {acct?.subscriptionType && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "#23863622", color: "#238636" }}
          >
            {formatPlan(acct.subscriptionType)}
          </span>
        )}
      </div>

      {acct?.email && (
        <div className="mb-3" style={{ color: page.statusFg }}>
          {acct.email}
          {acct.organization && ` · ${acct.organization}`}
        </div>
      )}

      {/* Error state */}
      {data.error && (
        <div
          className="mb-3 rounded px-2 py-1.5"
          style={{ background: "#ea6c7315", color: "#ea6c73" }}
        >
          {data.error}
        </div>
      )}

      {/* Primary windows */}
      {data.fiveHour && (
        <WindowDetail
          label="5-Hour Session"
          description="Rolling window"
          window={data.fiveHour}
          statusFg={page.statusFg}
        />
      )}

      {data.sevenDay && (
        <WindowDetail
          label="7-Day Weekly"
          description="All models"
          window={data.sevenDay}
          statusFg={page.statusFg}
        />
      )}

      {/* Model-specific windows */}
      {(data.sevenDayOpus || data.sevenDaySonnet) && (
        <div
          className="mt-1 pt-2 mb-2"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <div className="mb-2 font-medium" style={{ color: page.statusFg }}>
            Per-Model Weekly
          </div>
          {data.sevenDayOpus && (
            <WindowDetail
              label="Opus"
              description="7-day window"
              window={data.sevenDayOpus}
              statusFg={page.statusFg}
            />
          )}
          {data.sevenDaySonnet && (
            <WindowDetail
              label="Sonnet"
              description="7-day window"
              window={data.sevenDaySonnet}
              statusFg={page.statusFg}
            />
          )}
        </div>
      )}

      {/* Extra usage */}
      {data.extraUsage && (
        <div
          className="mt-1 pt-2 mb-2"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium">Extra Usage</span>
            <span style={{ color: page.statusFg }}>
              {formatDollars(data.extraUsage.usedCredits)} /{" "}
              {formatDollars(data.extraUsage.monthlyLimit)}
            </span>
          </div>
        </div>
      )}

      {/* Display Options */}
      <div
        className="mt-3 pt-2 flex items-center justify-between"
        style={{ borderTop: `1px solid ${page.border}` }}
      >
        <span style={{ color: page.statusFg }}>Status bar display</span>
        <div className="flex gap-1">
          {(["text", "bar"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="rounded px-2 py-0.5 cursor-pointer"
              style={{
                background: displayMode === mode ? page.border : "transparent",
                color: displayMode === mode ? page.fg : page.statusFg,
              }}
              onClick={() => onDisplayModeChange(mode)}
            >
              {mode === "text" ? "%" : "bar"}
            </button>
          ))}
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-2" style={{ color: page.statusFg }}>
        Updated {timeAgo(data.fetchedAt)}
      </div>
    </div>
  );
}
