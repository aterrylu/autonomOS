import { describe, expect, it } from "bun:test";
import { ClaudeCodeParser } from "../claude-code";

const parser = new ClaudeCodeParser();

describe("ClaudeCodeParser", () => {
  it("parses user text messages", () => {
    const entries = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:00Z",
        message: { role: "user", content: "hello world" },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("user_prompt");
    if (items[0].type === "user_prompt") {
      expect(items[0].content).toBe("hello world");
    }
  });

  it("parses assistant text blocks", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is my response." }],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("text");
    if (items[0].type === "text") {
      expect(items[0].content).toBe("Here is my response.");
    }
  });

  it("parses thinking blocks", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("thinking");
  });

  it("pairs tool_use with tool_result across messages", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Bash",
              input: { command: "git status" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "On branch main\nnothing to commit",
              is_error: false,
            },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_call");
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Bash");
      expect(items[0].input).toEqual({ command: "git status" });
      expect(items[0].result).toBe("On branch main\nnothing to commit");
      expect(items[0].status).toBe("complete");
      expect(items[0].isError).toBe(false);
    }
  });

  it("handles tool errors", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_456",
              name: "Bash",
              input: { command: "cat /nonexistent" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_456",
              content: "cat: /nonexistent: No such file or directory",
              is_error: true,
            },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].status).toBe("error");
      expect(items[0].isError).toBe(true);
    }
  });

  it("marks unresolved tool calls as pending", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_789",
              name: "Read",
              input: { file_path: "/tmp/test.txt" },
            },
          ],
        },
      },
      // No tool_result — session was interrupted
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].status).toBe("pending");
    }
  });

  it("strips system-reminder tags from user content", () => {
    const entries = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "user",
          content:
            "hello <system-reminder>some injected content</system-reminder> world",
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    if (items[0].type === "user_prompt") {
      expect(items[0].content).toBe("hello  world");
    }
  });

  it("skips empty text and thinking blocks", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "thinking", thinking: "  " },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(0);
  });

  it("skips progress and file-history-snapshot entries", () => {
    const entries = [
      { type: "progress", uuid: "p1", timestamp: "2026-03-09T00:00:00Z" },
      { type: "file-history-snapshot" },
      { type: "last-prompt" },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(0);
  });

  it("groups items into turns", () => {
    const entries = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:00Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "response" },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    const turns = parser.groupIntoTurns(items);

    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].items).toHaveLength(1);
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].items).toHaveLength(2); // thinking + text
  });

  it("handles tool_result with array content", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_arr",
              name: "Read",
              input: { file_path: "/tmp/test.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_arr",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].result).toBe("line 1\nline 2");
    }
  });

  it("handles mixed user message with text and tool_result", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-03-09T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_mix",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-09T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_mix",
              content: "file1.ts file2.ts",
            },
            { type: "text", text: "now do something else" },
          ],
        },
      },
    ];

    const items = parser.parse(entries);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("tool_call");
    expect(items[1].type).toBe("user_prompt");
    if (items[1].type === "user_prompt") {
      expect(items[1].content).toBe("now do something else");
    }
  });
});
