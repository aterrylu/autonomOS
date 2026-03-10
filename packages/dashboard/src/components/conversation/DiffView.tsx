import { THEMES, useStore } from "../../store";

interface DiffViewProps {
  /** Old text (removals) */
  oldText: string;
  /** New text (additions) */
  newText: string;
  /** Background color for the code area */
  codeBg: string;
}

interface DiffLineProps {
  text: string;
  type: "add" | "remove" | "context";
}

const COLORS = {
  add: { fg: "#91b362", bg: "#91b36218", marker: "+" },
  remove: { fg: "#ea6c73", bg: "#ea6c7318", marker: "-" },
  context: { fg: "", bg: "transparent", marker: " " },
} as const;

const COLORS_LIGHT = {
  add: { fg: "#22863a", bg: "#dcffe4", marker: "+" },
  remove: { fg: "#d73a49", bg: "#ffeef0", marker: "-" },
  context: { fg: "", bg: "transparent", marker: " " },
} as const;

/**
 * Renders a side-by-side or unified diff from old_string → new_string.
 * Used by Edit tool calls and ```diff markdown blocks.
 */
export function DiffView({ oldText, newText, codeBg }: DiffViewProps) {
  const theme = useStore((s) => s.theme);
  const colors = theme === "daylight" ? COLORS_LIGHT : COLORS;
  const page = THEMES[theme].page;

  const lines = computeUnifiedDiff(oldText, newText);

  return (
    <div
      className="rounded-lg overflow-hidden font-mono text-[11px] leading-[1.6]"
      style={{ background: codeBg }}
    >
      {lines.map((line, i) => {
        const c = colors[line.type];
        return (
          <div
            key={i}
            className="flex"
            style={{ background: c.bg }}
          >
            <span
              className="select-none shrink-0 w-5 text-center"
              style={{
                color: c.fg || page.statusFg,
                opacity: line.type === "context" ? 0.5 : 1,
              }}
            >
              {c.marker}
            </span>
            <span
              className="flex-1 px-2 whitespace-pre-wrap break-all"
              style={{
                color: c.fg || page.fg,
              }}
            >
              {line.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders pre-formatted diff text (from ```diff blocks).
 * Each line starting with + / - / @@ gets colored.
 */
export function DiffBlock({ content }: { content: string }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const colors = theme === "daylight" ? COLORS_LIGHT : COLORS;
  const codeBg = theme === "daylight" ? "#e8e8e6" : `${page.border}88`;

  const rawLines = content.split("\n");

  return (
    <div
      className="rounded-lg overflow-hidden font-mono text-[11px] leading-[1.6]"
      style={{ background: codeBg }}
    >
      {rawLines.map((text, i) => {
        let type: "add" | "remove" | "context" = "context";
        if (text.startsWith("+")) type = "add";
        else if (text.startsWith("-")) type = "remove";

        const c = colors[type];
        const isHeader = text.startsWith("@@");

        return (
          <div
            key={i}
            className="flex"
            style={{ background: isHeader ? "transparent" : c.bg }}
          >
            <span
              className="flex-1 px-3 whitespace-pre-wrap break-all"
              style={{
                color: isHeader
                  ? page.statusFg
                  : c.fg || page.fg,
                fontStyle: isHeader ? "italic" : "normal",
              }}
            >
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Simple line-level diff: outputs removal lines then addition lines with shared context */
function computeUnifiedDiff(
  oldText: string,
  newText: string,
): DiffLineProps[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLineProps[] = [];

  // Find common prefix
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] ===
      newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Context before (max 3 lines)
  const ctxStart = Math.max(0, prefixLen - 3);
  for (let i = ctxStart; i < prefixLen; i++) {
    result.push({ text: oldLines[i], type: "context" });
  }

  // Removed lines
  const oldEnd = oldLines.length - suffixLen;
  for (let i = prefixLen; i < oldEnd; i++) {
    result.push({ text: oldLines[i], type: "remove" });
  }

  // Added lines
  const newEnd = newLines.length - suffixLen;
  for (let i = prefixLen; i < newEnd; i++) {
    result.push({ text: newLines[i], type: "add" });
  }

  // Context after (max 3 lines)
  const suffixStart = oldLines.length - suffixLen;
  const ctxEnd = Math.min(oldLines.length, suffixStart + 3);
  for (let i = suffixStart; i < ctxEnd; i++) {
    result.push({ text: oldLines[i], type: "context" });
  }

  return result;
}
