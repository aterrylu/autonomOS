import { useState } from "react";
import { THEMES, useStore } from "../../store";
import { UsagePanel } from "./UsagePanel";
import { useUsageData } from "./useUsageData";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatModel(model: string): string {
  // "claude-opus-4-6" → "opus", "claude-sonnet-4-6" → "sonnet"
  const parts = model.replace("claude-", "").split("-");
  return parts[0];
}

export function UsageStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error } = useUsageData();
  const [panelOpen, setPanelOpen] = useState(false);

  if (error) {
    return (
      <span style={{ color: page.statusFg }} title={`Usage error: ${error}`}>
        usage: –
      </span>
    );
  }

  if (!data) {
    return <span style={{ color: page.statusFg }}>usage: loading…</span>;
  }

  // Build compact summary: "opus: 1.2M / sonnet: 340K"
  const modelSummaries = Object.entries(data.models)
    .sort(([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .slice(0, 3)
    .map(([model, usage]) => {
      const total = usage.inputTokens + usage.outputTokens;
      return `${formatModel(model)}: ${formatTokens(total)}`;
    });

  const rateLimitColor =
    data.rateLimit?.status === "rejected"
      ? "#ea6c73"
      : data.rateLimit?.status === "allowed_warning"
        ? "#e6b450"
        : undefined;

  return (
    <div className="relative">
      <button
        type="button"
        className="cursor-pointer hover:opacity-80"
        style={{ color: rateLimitColor ?? page.statusFg }}
        onClick={() => setPanelOpen(!panelOpen)}
        title="Click for usage details"
      >
        {modelSummaries.join(" · ")}
        {data.rateLimit && data.rateLimit.status !== "allowed" && (
          <span>
            {" "}
            ⚠ {data.rateLimit.status.replace("_", " ")}
          </span>
        )}
      </button>
      {panelOpen && (
        <UsagePanel data={data} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
