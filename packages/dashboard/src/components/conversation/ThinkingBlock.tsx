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

  const bubbleBg =
    theme === "daylight" ? "#f0f0ee" : `${page.border}cc`;

  return (
    <div
      className="rounded-2xl rounded-bl-sm overflow-hidden"
      style={{ background: bubbleBg }}
    >
      <button
        type="button"
        className="flex items-center gap-2 px-3.5 py-2 text-xs cursor-pointer select-none bg-transparent border-none"
        onClick={() => setExpanded(!expanded)}
        style={{ color: page.statusFg }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ background: page.statusFg, opacity: 0.5 }}
        />
        <span className="italic">Thinking{expanded ? "" : "..."}</span>
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div
          className="px-3.5 py-2.5"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <pre
            className="whitespace-pre-wrap text-[11px] leading-relaxed font-mono max-h-80 overflow-y-auto rounded-lg p-2.5"
            style={{
              color: page.statusFg,
              background:
                theme === "daylight" ? "#e8e8e6" : `${page.border}88`,
            }}
          >
            {item.content}
          </pre>
        </div>
      )}
    </div>
  );
}
