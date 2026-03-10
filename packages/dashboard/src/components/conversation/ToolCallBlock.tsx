import type { ToolCallItem } from "@autonomos/core";
import { useState } from "react";
import { THEMES, useStore } from "../../store";
import { DiffView } from "./DiffView";

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
      return String(input.description || input.prompt || "").slice(0, 80);
    default:
      return Object.values(input).map(String).join(" ").slice(0, 80);
  }
}

export function ToolCallBlock({ item }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const isError = item.isError || item.status === "error";
  const isPending = item.status === "pending";
  const isEdit = item.toolName === "Edit";

  const statusColor = isError
    ? "#ea6c73"
    : isPending
      ? page.statusFg
      : "#91b362";

  const bubbleBg =
    theme === "daylight" ? "#f0f0ee" : `${page.border}cc`;
  const codeBg =
    theme === "daylight" ? "#e8e8e6" : `${page.border}88`;

  return (
    <div
      className="rounded-2xl rounded-bl-sm overflow-hidden text-xs"
      style={{ background: bubbleBg }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3.5 py-2 cursor-pointer select-none bg-transparent border-none text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status dot */}
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ background: statusColor }}
        />

        {/* Tool name */}
        <span
          className="text-xs font-semibold shrink-0"
          style={{ color: page.fg }}
        >
          {item.toolName}
        </span>

        {/* Summary */}
        <span
          className="truncate flex-1 font-mono text-[11px]"
          style={{ color: page.statusFg }}
        >
          {summarizeInput(item.toolName, item.input)}
        </span>

        {/* Expand indicator */}
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div
          className="px-3.5 py-2.5 space-y-2"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          {/* Edit tool: show as a diff view */}
          {isEdit ? (
            <EditDiffView input={item.input} codeBg={codeBg} />
          ) : (
            <div>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: page.statusFg }}
              >
                Input
              </div>
              <pre
                className="whitespace-pre-wrap break-all font-mono text-[11px] rounded-lg p-2.5"
                style={{ color: page.fg, background: codeBg }}
              >
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {item.result && (
            <div>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: isError ? "#ea6c73" : page.statusFg }}
              >
                {isError ? "Error" : "Result"}
              </div>
              <pre
                className="whitespace-pre-wrap break-all font-mono text-[11px] max-h-60 overflow-y-auto rounded-lg p-2.5"
                style={{
                  color: isError ? "#ea6c73" : page.fg,
                  background: codeBg,
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

/** Renders Edit tool input as a visual diff */
function EditDiffView({
  input,
  codeBg,
}: {
  input: Record<string, unknown>;
  codeBg: string;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const filePath = String(input.file_path || "");
  const oldString = String(input.old_string || "");
  const newString = String(input.new_string || "");

  return (
    <div>
      {filePath && (
        <div
          className="text-[11px] font-mono mb-1.5"
          style={{ color: page.statusFg }}
        >
          {filePath}
        </div>
      )}
      <DiffView oldText={oldString} newText={newString} codeBg={codeBg} />
    </div>
  );
}
