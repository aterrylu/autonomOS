import type { ThinkingItem } from "@autonomos/core";
import { useState } from "react";
import { THEMES, useStore } from "../../store";

interface ThinkingBlockProps {
  item: ThinkingItem;
}

export function ThinkingBlock({ item }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  return (
    <div className="my-0.5">
      <button
        type="button"
        className="flex items-center gap-2 text-xs cursor-pointer select-none bg-transparent border-none p-0"
        onClick={() => setExpanded(!expanded)}
        style={{ color: page.statusFg }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: page.statusFg }}
        />
        <span className="italic">Thinking{expanded ? "" : "..."}</span>
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <pre
          className="mt-2 whitespace-pre-wrap text-xs leading-relaxed rounded-lg p-3 max-h-80 overflow-y-auto"
          style={{
            color: page.statusFg,
            background: theme === "daylight" ? "#f5f5f3" : `${page.border}44`,
          }}
        >
          {item.content}
        </pre>
      )}
    </div>
  );
}
