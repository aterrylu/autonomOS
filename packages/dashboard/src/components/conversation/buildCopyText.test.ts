import type { Turn } from "@autonomos/core";
import { describe, expect, it } from "vitest";
import {
  buildClipboardText,
  buildRenderUnits,
  findItemById,
  preferSelectionString,
} from "./buildCopyText";

const userTurn: Turn = {
  role: "user",
  items: [
    { type: "user_prompt", id: "u1", content: "first prompt" },
    { type: "user_prompt", id: "u2", content: "second prompt" },
  ],
};

const assistantTurn: Turn = {
  role: "assistant",
  items: [
    { type: "text", id: "t1", content: "hello **world**" },
    {
      type: "tool_call",
      id: "tool1",
      toolName: "Bash",
      toolUseId: "use1",
      input: { command: "echo hi\necho bye" },
      result: "hi\nbye",
      isError: false,
      status: "complete",
    },
    { type: "thinking", id: "think1", content: "pondering" },
  ],
};

const systemTurn: Turn = {
  role: "system",
  items: [
    {
      type: "system",
      id: "sys1",
      subtype: "compact_boundary",
      content: "1234",
    },
  ],
};

const turns: Turn[] = [userTurn, assistantTurn, systemTurn];

describe("buildRenderUnits", () => {
  it("collapses multiple user_prompt items in a turn into one unit", () => {
    const units = buildRenderUnits([userTurn]);
    expect(units).toEqual([
      { id: "u1", text: "> first prompt\nsecond prompt" },
    ]);
  });

  it("emits one unit per assistant item (text/tool/thinking)", () => {
    const units = buildRenderUnits([assistantTurn]);
    expect(units.map((u) => u.id)).toEqual(["t1", "tool1", "think1"]);
  });

  it("renders Bash tool input as raw command, not JSON", () => {
    const units = buildRenderUnits([assistantTurn]);
    const toolUnit = units.find((u) => u.id === "tool1");
    expect(toolUnit?.text).toBe("[Bash]\n$ echo hi\necho bye\nhi\nbye");
  });

  it("renders compact_boundary system items with token count", () => {
    const units = buildRenderUnits([systemTurn]);
    expect(units).toEqual([
      { id: "sys1", text: "— context compacted (1,234 tokens) —" },
    ]);
  });

  it("skips empty text items", () => {
    const t: Turn = {
      role: "assistant",
      items: [{ type: "text", id: "empty", content: "   \n" }],
    };
    expect(buildRenderUnits([t])).toEqual([]);
  });

  it("renders Edit input as a unified diff", () => {
    const t: Turn = {
      role: "assistant",
      items: [
        {
          type: "tool_call",
          id: "e1",
          toolName: "Edit",
          toolUseId: "use",
          input: { file_path: "/a.ts", old_string: "foo", new_string: "bar" },
          isError: false,
          status: "complete",
        },
      ],
    };
    expect(buildRenderUnits([t])[0].text).toBe(
      "[Edit]\n/a.ts\n--- old\nfoo\n+++ new\nbar",
    );
  });

  it("marks failed tool calls with [FAILED]", () => {
    const t: Turn = {
      role: "assistant",
      items: [
        {
          type: "tool_call",
          id: "f1",
          toolName: "Bash",
          toolUseId: "use",
          input: { command: "false" },
          result: "exit 1",
          isError: true,
          status: "error",
        },
      ],
    };
    expect(buildRenderUnits([t])[0].text).toBe(
      "[Bash [FAILED]]\n$ false\nexit 1",
    );
  });
});

describe("buildClipboardText", () => {
  it("returns null for same-id selection on a text item (fall back to selection.toString)", () => {
    expect(buildClipboardText(turns, "t1", "t1")).toBeNull();
  });

  it("returns null for same-id selection on a user_prompt item", () => {
    expect(buildClipboardText(turns, "u1", "u1")).toBeNull();
  });

  it("returns null for same-id selection on a thinking item", () => {
    expect(buildClipboardText(turns, "think1", "think1")).toBeNull();
  });

  it("returns null for same-id selection on a tool_call item (fall back to native copy preserves the literal highlight)", () => {
    expect(buildClipboardText(turns, "tool1", "tool1")).toBeNull();
  });

  it("returns null for same-id selection on a system item (fall back to native copy)", () => {
    expect(buildClipboardText(turns, "sys1", "sys1")).toBeNull();
  });

  it("joins multiple units with blank lines for a multi-unit selection", () => {
    const out = buildClipboardText(turns, "u1", "tool1");
    expect(out).toBe(
      [
        "> first prompt\nsecond prompt",
        "hello **world**",
        "[Bash]\n$ echo hi\necho bye\nhi\nbye",
      ].join("\n\n"),
    );
  });

  it("handles reversed selection direction", () => {
    const forward = buildClipboardText(turns, "u1", "tool1");
    const reverse = buildClipboardText(turns, "tool1", "u1");
    expect(reverse).toBe(forward);
  });

  it("returns null when an id can't be resolved", () => {
    expect(buildClipboardText(turns, "missing", "tool1")).toBeNull();
  });
});

describe("findItemById / preferSelectionString", () => {
  it("finds items across turns by id", () => {
    expect(findItemById(turns, "tool1")?.type).toBe("tool_call");
    expect(findItemById(turns, "sys1")?.type).toBe("system");
    expect(findItemById(turns, "nope")).toBeUndefined();
  });

  it("prefers selection.toString() for text-like items only", () => {
    expect(preferSelectionString(findItemById(turns, "t1"))).toBe(true);
    expect(preferSelectionString(findItemById(turns, "u1"))).toBe(true);
    expect(preferSelectionString(findItemById(turns, "think1"))).toBe(true);
    expect(preferSelectionString(findItemById(turns, "tool1"))).toBe(false);
    expect(preferSelectionString(findItemById(turns, "sys1"))).toBe(false);
  });
});
