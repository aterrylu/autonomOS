import { useState } from "react";
import { THEMES, useStore } from "../../store";
import type { RateLimitWindow } from "./types";
import { UsagePanel } from "./UsagePanel";
import { useUsageData } from "./useUsageData";

function utilizationColor(pct: number): string {
  if (pct >= 80) return "#ea6c73"; // red
  if (pct >= 60) return "#e6b450"; // yellow
  return "#238636"; // green
}

function timeUntilReset(resetsAt: string): string {
  if (!resetsAt) return "";
  const resetDate = new Date(resetsAt);
  const ms = resetDate.getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    resetDate.getDate() === tomorrow.getDate() &&
    resetDate.getMonth() === tomorrow.getMonth();
  const time = resetDate.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isTomorrow) return `Tomorrow ${time}`;
  return resetDate.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function MiniBar({ pct }: { pct: number }) {
  const color = utilizationColor(pct);
  return (
    <span
      className="inline-block h-2 rounded-sm overflow-hidden align-middle"
      style={{ width: 40, background: `${color}22` }}
    >
      <span
        className="block h-full rounded-sm"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </span>
  );
}

function WindowLabel({
  label,
  window,
  mode,
}: {
  label: string;
  window: RateLimitWindow;
  mode: "text" | "bar";
}) {
  const pct = Math.round(window.utilization);
  const reset = timeUntilReset(window.resetsAt);
  const title = `${label}: ${pct}% used${reset ? ` · resets in ${reset}` : ""}`;

  if (mode === "bar") {
    return (
      <span className="inline-flex items-center gap-1" title={title}>
        <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>
        <MiniBar pct={pct} />
      </span>
    );
  }

  return (
    <span title={title}>
      <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>{" "}
      <span style={{ color: utilizationColor(pct) }}>{pct}%</span>
    </span>
  );
}

export function UsageStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error, displayMode, setDisplayMode } = useUsageData();
  const [panelOpen, setPanelOpen] = useState(false);

  if (error) {
    return (
      <span style={{ color: page.statusFg }} title={`Usage error: ${error}`}>
        limits: –
      </span>
    );
  }

  if (!data) {
    return <span style={{ color: page.statusFg }}>limits: …</span>;
  }

  if (data.error) {
    return (
      <span style={{ color: "#ea6c73" }} title={data.error}>
        limits: err
      </span>
    );
  }

  const hasData = data.fiveHour || data.sevenDay;
  if (!hasData) {
    return (
      <span
        style={{ color: page.statusFg }}
        title="No rate limit data available"
      >
        limits: n/a
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex items-center gap-2 cursor-pointer hover:opacity-80"
        style={{ color: page.fg }}
        onClick={() => setPanelOpen(!panelOpen)}
        title="Click for rate limit details"
      >
        {data.fiveHour && (
          <WindowLabel label="5h" window={data.fiveHour} mode={displayMode} />
        )}
        {data.sevenDay && (
          <WindowLabel label="7d" window={data.sevenDay} mode={displayMode} />
        )}
      </button>
      {panelOpen && (
        <UsagePanel
          data={data}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}
