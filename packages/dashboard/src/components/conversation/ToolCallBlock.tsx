import type { ToolCallItem } from "@autonomos/core";
import { useState } from "react";
import { THEMES, useStore } from "../../store";

interface ToolCallBlockProps {
  item: ToolCallItem;
}

/** Format tool input into a readable summary line */
function summarizeInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return String(input.command || "");
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || "");
    case "Glob":
    case "Grep":
      return String(input.pattern || "");
    case "Agent":
      return String(input.description || input.prompt || "").slice(0, 60);
    default:
      return Object.values(input).map(String).join(" ").slice(0, 60);
  }
}

/** Map tool names to short labels */
function toolIcon(name: string): string {
  const icons: Record<string, string> = {
    Bash: "$",
    Read: "R",
    Write: "W",
    Edit: "E",
    Glob: "G",
    Grep: "?",
    Agent: "A",
    WebSearch: "S",
    WebFetch: "F",
  };
  return icons[name] || "T";
}

export function ToolCallBlock({ item }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const isError = item.isError || item.status === "error";
  const isPending = item.status === "pending";

  const statusDot = isError ? "#ea6c73" : isPending ? page.statusFg : "#91b362";

  return (
    <div
      className="rounded-lg text-xs overflow-hidden"
      style={{
        background: theme === "daylight" ? "#f5f5f3" : `${page.border}44`,
        border: `1px solid ${page.border}`,
      }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2 cursor-pointer select-none bg-transparent border-none text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status dot */}
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ background: statusDot }}
        />

        {/* Tool icon badge */}
        <span
          className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-mono font-bold shrink-0"
          style={{
            background: page.border,
            color: page.fg,
          }}
        >
          {toolIcon(item.toolName)}
        </span>

        {/* Tool name */}
        <span className="font-medium shrink-0" style={{ color: page.fg }}>
          {item.toolName}
        </span>

        {/* Summary */}
        <span
          className="truncate flex-1 font-mono"
          style={{ color: page.statusFg }}
        >
          {summarizeInput(item.toolName, item.input)}
        </span>

        {/* Expand indicator */}
        <span style={{ color: page.statusFg }}>{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div
          className="px-3 py-3 space-y-3"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          {/* Input */}
          <div>
            <div
              className="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: page.statusFg }}
            >
              Input
            </div>
            <pre
              className="whitespace-pre-wrap break-all text-xs font-mono rounded-md p-2.5"
              style={{
                color: page.fg,
                background:
                  theme === "daylight" ? "#e8e8e6" : `${page.border}88`,
              }}
            >
              {JSON.stringify(item.input, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {item.result && (
            <div>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: isError ? "#ea6c73" : page.statusFg }}
              >
                {isError ? "Error" : "Result"}
              </div>
              <pre
                className="whitespace-pre-wrap break-all text-xs font-mono max-h-60 overflow-y-auto rounded-md p-2.5"
                style={{
                  color: isError ? "#ea6c73" : page.fg,
                  background:
                    theme === "daylight" ? "#e8e8e6" : `${page.border}88`,
                }}
              >
                {item.result.length > 3000
                  ? `${item.result.slice(0, 3000)}\n\n— truncated (${item.result.length.toLocaleString()} chars) —`
                  : item.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
