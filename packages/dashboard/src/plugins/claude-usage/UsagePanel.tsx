import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../../store";
import type { UsageSummary } from "./types";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace(/-\d+$/, "")
    .replace(/-/g, " ");
}

interface UsagePanelProps {
  data: UsageSummary;
  onClose: () => void;
}

export function UsagePanel({ data, onClose }: UsagePanelProps) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const modelEntries = Object.entries(data.models).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );

  const windowStart = new Date(data.window.start).toLocaleDateString();
  const windowEnd = new Date(data.window.end).toLocaleDateString();

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
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Claude Usage</span>
        <span style={{ color: page.statusFg }}>
          {windowStart} – {windowEnd}
        </span>
      </div>

      <table className="w-full">
        <thead>
          <tr style={{ color: page.statusFg }}>
            <th className="pb-1 text-left font-normal">Model</th>
            <th className="pb-1 text-right font-normal">In</th>
            <th className="pb-1 text-right font-normal">Out</th>
            <th className="pb-1 text-right font-normal">Cache R</th>
            <th className="pb-1 text-right font-normal">Cache W</th>
            <th className="pb-1 text-right font-normal">Reqs</th>
          </tr>
        </thead>
        <tbody>
          {modelEntries.map(([model, usage]) => (
            <tr key={model}>
              <td className="py-0.5">{formatModel(model)}</td>
              <td className="py-0.5 text-right">{formatTokens(usage.inputTokens)}</td>
              <td className="py-0.5 text-right">{formatTokens(usage.outputTokens)}</td>
              <td className="py-0.5 text-right">{formatTokens(usage.cacheReadTokens)}</td>
              <td className="py-0.5 text-right">{formatTokens(usage.cacheWriteTokens)}</td>
              <td className="py-0.5 text-right">{usage.requestCount}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr
            style={{ borderTop: `1px solid ${page.border}` }}
          >
            <td className="pt-1 font-medium">Total</td>
            <td className="pt-1 text-right font-medium">
              {formatTokens(data.totalInputTokens)}
            </td>
            <td className="pt-1 text-right font-medium">
              {formatTokens(data.totalOutputTokens)}
            </td>
            <td className="pt-1 text-right" />
            <td className="pt-1 text-right" />
            <td className="pt-1 text-right font-medium">{data.totalRequests}</td>
          </tr>
        </tfoot>
      </table>

      {data.rateLimit && (
        <div
          className="mt-2 rounded px-2 py-1"
          style={{
            background:
              data.rateLimit.status === "rejected"
                ? "#da36361a"
                : data.rateLimit.status === "allowed_warning"
                  ? "#e3b3411a"
                  : "transparent",
            color:
              data.rateLimit.status === "rejected"
                ? "#ea6c73"
                : data.rateLimit.status === "allowed_warning"
                  ? "#e6b450"
                  : page.statusFg,
          }}
        >
          Rate limit: {data.rateLimit.status.replace("_", " ")}
          {data.rateLimit.utilization != null &&
            ` · ${data.rateLimit.utilization.toFixed(0)}%`}
          {data.rateLimit.resetsAt && (
            <span>
              {" "}
              · resets{" "}
              {new Date(data.rateLimit.resetsAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
