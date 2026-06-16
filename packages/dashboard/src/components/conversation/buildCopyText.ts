import type {
  RenderItem,
  SystemItem,
  ToolCallItem,
  Turn,
  UserPromptItem,
} from "@autonomos/core";

/**
 * A render unit is the smallest chunk of the conversation that maps 1:1 to
 * a tagged DOM element via `data-item-id`. Assistant items map to one unit
 * each; a user turn collapses all its user_prompt items into a single unit
 * because UserTurn renders them as one joined block.
 */
export interface RenderUnit {
  id: string;
  text: string;
}

export function buildRenderUnits(turns: Turn[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      const userItems = turn.items.filter(
        (i): i is UserPromptItem => i.type === "user_prompt",
      );
      if (userItems.length === 0) continue;
      const joined = userItems.map((i) => i.content).join("\n");
      if (!joined.trim()) continue;
      units.push({ id: userItems[0].id, text: `> ${joined}` });
      continue;
    }
    if (turn.role === "system") {
      for (const item of turn.items) {
        if (item.type !== "system") continue;
        if (item.subtype !== "compact_boundary") continue;
        units.push({ id: item.id, text: renderSystemPlaintext(item) });
      }
      continue;
    }
    for (const item of turn.items) {
      if (item.type === "text") {
        if (!item.content.trim()) continue;
        units.push({ id: item.id, text: item.content });
      } else if (item.type === "thinking") {
        units.push({ id: item.id, text: `[thinking]\n${item.content}` });
      } else if (item.type === "tool_call") {
        units.push({ id: item.id, text: renderToolCallPlaintext(item) });
      }
    }
  }
  return units;
}

function renderSystemPlaintext(item: SystemItem): string {
  const tokens = item.content
    ? ` (${Number(item.content).toLocaleString()} tokens)`
    : "";
  return `— context compacted${tokens} —`;
}

function renderToolCallPlaintext(item: ToolCallItem): string {
  const statusSuffix =
    item.isError || item.status === "error"
      ? " [FAILED]"
      : item.status === "pending"
        ? " [PENDING]"
        : "";
  const head = `[${item.toolName}${statusSuffix}]`;
  const inputStr = renderInputPlaintext(item.toolName, item.input);
  if (item.result) return `${head}\n${inputStr}\n${item.result}`;
  return inputStr ? `${head}\n${inputStr}` : head;
}

function renderInputPlaintext(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return `$ ${String(input.command ?? "")}`;
    case "Read":
    case "Write":
      return String(input.file_path ?? "");
    case "Edit":
      return [
        String(input.file_path ?? ""),
        "--- old",
        String(input.old_string ?? ""),
        "+++ new",
        String(input.new_string ?? ""),
      ].join("\n");
    case "Glob":
    case "Grep":
      return String(input.pattern ?? input.glob ?? "");
    case "Agent":
      return String(input.description ?? "");
    default:
      return JSON.stringify(input, null, 2);
  }
}

/** Walk up the DOM to the nearest ancestor (or self) carrying `data-item-id`. */
export function closestItemEl(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.dataset.itemId) return el;
    }
    n = n.parentNode;
  }
  return null;
}

/**
 * For a single-unit selection we use the user's precise selection
 * (selection.toString()) when the unit is plain text the user can read
 * directly. For tool/system units we always use canonical rendering to keep
 * decorative chrome (status dots, "Input"/"Result" labels, expand chevrons)
 * out of the clipboard.
 */
export function preferSelectionString(item: RenderItem | undefined): boolean {
  if (!item) return false;
  return (
    item.type === "text" ||
    item.type === "user_prompt" ||
    item.type === "thinking"
  );
}

export function findItemById(
  turns: Turn[],
  itemId: string,
): RenderItem | undefined {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.id === itemId) return item;
    }
  }
  return undefined;
}

/**
 * Build the clipboard text for a selection spanning render units identified
 * by start/end `data-item-id`s.
 *
 * - If the selection stays within a single render unit, returns `null` so
 *   the caller falls back to `selection.toString()` — this preserves the
 *   user's precise highlight (e.g. a few lines of a Bash result) instead of
 *   substituting the unit's full canonical render.
 * - For a selection spanning multiple units, returns the canonical render of
 *   every unit in [start, end] in document order, joined by blank lines.
 *
 * Returns `null` (caller should fall back to default copy) when either
 * endpoint can't be resolved.
 */
export function buildClipboardText(
  turns: Turn[],
  startItemId: string,
  endItemId: string,
): string | null {
  const units = buildRenderUnits(turns);
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < units.length; i++) idToIndex.set(units[i].id, i);

  const startIdx = idToIndex.get(startItemId);
  const endIdx = idToIndex.get(endItemId);
  if (startIdx === undefined || endIdx === undefined) return null;

  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

  // Any single-unit selection falls through to native copy so the user's
  // literal highlight is preserved — e.g. a few lines of a Bash result —
  // instead of being replaced by the unit's full canonical render (which
  // would inject synthetic "[Bash]\n$ …" chrome and the untruncated result).
  if (lo === hi) return null;

  return units
    .slice(lo, hi + 1)
    .map((u) => u.text)
    .join("\n\n");
}
