import type { SessionParser } from "../types/parser";
import type {
  RenderItem,
  TextItem,
  ThinkingItem,
  ToolCallItem,
  Turn,
  UserPromptItem,
} from "../types/render";

/**
 * JSONL entry types from Claude Code session files.
 * Located at ~/.claude/projects/{encoded-path}/{session-uuid}.jsonl
 */

interface ContentBlockText {
  type: "text";
  text: string;
}

interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
  signature?: string;
}

interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

type AssistantContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse;

type UserContentBlock = ContentBlockText | ContentBlockToolResult;

interface AssistantEntry {
  type: "assistant";
  uuid: string;
  timestamp: string;
  isSidechain?: boolean;
  message: {
    role: "assistant";
    content: AssistantContentBlock[];
  };
}

interface UserEntry {
  type: "user";
  uuid: string;
  timestamp: string;
  isSidechain?: boolean;
  /** True on the compacted summary block that follows a compact_boundary */
  isCompactSummary?: boolean;
  message: {
    role: "user";
    content: string | UserContentBlock[];
  };
}

interface CompactMetadata {
  trigger: string;
  preTokens: number;
}

interface SystemEntry {
  type: "system";
  uuid: string;
  timestamp: string;
  subtype?: string;
  compactMetadata?: CompactMetadata;
}

interface ProgressEntry {
  type: "progress";
  uuid: string;
  timestamp: string;
}

type SessionEntry = AssistantEntry | UserEntry | SystemEntry | ProgressEntry;

/** Pending tool call waiting for its result */
interface PendingToolCall {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  id: string;
  isSidechain?: boolean;
}

/**
 * ClaudeCodeParser — parses Claude Code JSONL session files
 * into provider-agnostic RenderItem[].
 *
 * Key challenge: tool_use blocks appear in assistant messages,
 * but tool_result blocks appear in the next user message.
 * They're linked by tool_use_id.
 */
export class ClaudeCodeParser implements SessionParser {
  readonly provider = "claude-code";

  parse(entries: unknown[]): RenderItem[] {
    const items: RenderItem[] = [];
    const pendingTools = new Map<string, PendingToolCall>();

    for (const raw of entries) {
      const entry = raw as SessionEntry;

      if (entry.type === "assistant") {
        this.parseAssistant(entry, items, pendingTools);
      } else if (entry.type === "user") {
        this.parseUser(entry, items, pendingTools);
      } else if (entry.type === "system") {
        this.parseSystem(entry, items);
      }
      // Skip progress, file-history-snapshot, last-prompt, etc.
    }

    // Any remaining pending tools are incomplete (session interrupted)
    for (const pending of pendingTools.values()) {
      items.push({
        type: "tool_call",
        toolName: pending.toolName,
        toolUseId: pending.toolUseId,
        input: pending.input,
        isError: false,
        status: "pending",
        id: pending.id,
      });
    }

    return items;
  }

  groupIntoTurns(items: RenderItem[]): Turn[] {
    const turns: Turn[] = [];
    let current: Turn | null = null;

    for (const item of items) {
      const role =
        item.type === "user_prompt"
          ? "user"
          : item.type === "system"
            ? "system"
            : "assistant";

      const isSidechain =
        (item as { isSidechain?: boolean }).isSidechain ?? false;
      if (
        !current ||
        current.role !== role ||
        current.isSidechain !== isSidechain
      ) {
        current = { role, items: [], isSidechain };
        turns.push(current);
      }
      current.items.push(item);
    }

    return turns;
  }

  private parseAssistant(
    entry: AssistantEntry,
    items: RenderItem[],
    pendingTools: Map<string, PendingToolCall>,
  ): void {
    for (const block of entry.message.content) {
      switch (block.type) {
        case "text": {
          if (block.text.trim()) {
            items.push({
              type: "text",
              content: block.text,
              id: `${entry.uuid}-text-${items.length}`,
              isSidechain: entry.isSidechain,
            } satisfies TextItem);
          }
          break;
        }
        case "thinking": {
          if (block.thinking.trim()) {
            items.push({
              type: "thinking",
              content: block.thinking,
              id: `${entry.uuid}-thinking-${items.length}`,
              isSidechain: entry.isSidechain,
            } satisfies ThinkingItem);
          }
          break;
        }
        case "tool_use": {
          // Don't add to items yet — wait for tool_result to pair
          pendingTools.set(block.id, {
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
            id: `${entry.uuid}-tool-${block.id}`,
            isSidechain: entry.isSidechain,
          });
          break;
        }
      }
    }
  }

  private parseUser(
    entry: UserEntry,
    items: RenderItem[],
    pendingTools: Map<string, PendingToolCall>,
  ): void {
    // The compacted summary block is injected for context only — skip it
    if (entry.isCompactSummary) return;

    const content = entry.message.content;

    // Simple string content = user typed a message
    if (typeof content === "string") {
      // Filter out system-reminder content that gets injected
      const cleaned = this.cleanUserContent(content);
      if (cleaned.trim()) {
        items.push({
          type: "user_prompt",
          content: cleaned,
          id: `${entry.uuid}-user`,
          isSidechain: entry.isSidechain,
        } satisfies UserPromptItem);
      }
      return;
    }

    // Array content — could be tool_results or text blocks
    let hasUserText = false;
    for (const block of content) {
      if (block.type === "tool_result") {
        const pending = pendingTools.get(block.tool_use_id);
        if (pending) {
          pendingTools.delete(block.tool_use_id);
          items.push({
            type: "tool_call",
            toolName: pending.toolName,
            toolUseId: pending.toolUseId,
            input: pending.input,
            result: this.extractToolResultContent(block.content),
            isError: block.is_error ?? false,
            status: block.is_error ? "error" : "complete",
            id: pending.id,
            isSidechain: pending.isSidechain,
          } satisfies ToolCallItem);
        }
      } else if (block.type === "text" && block.text) {
        const cleaned = this.cleanUserContent(block.text);
        if (cleaned.trim() && !hasUserText) {
          hasUserText = true;
          items.push({
            type: "user_prompt",
            content: cleaned,
            id: `${entry.uuid}-user`,
            isSidechain: entry.isSidechain,
          } satisfies UserPromptItem);
        }
      }
    }
  }

  private parseSystem(entry: SystemEntry, items: RenderItem[]): void {
    // Only include meaningful system events
    const meaningful = ["init", "compact_boundary", "api_error"];
    if (entry.subtype && meaningful.includes(entry.subtype)) {
      items.push({
        type: "system",
        subtype: entry.subtype,
        content: entry.compactMetadata
          ? String(entry.compactMetadata.preTokens)
          : undefined,
        id: entry.uuid,
      });
    }
  }

  private extractToolResultContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") return content;
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n");
  }

  /**
   * Strip system-reminder tags and other injected content
   * from user messages. These appear as <system-reminder>...</system-reminder>
   * blocks in user text content.
   */
  private cleanUserContent(text: string): string {
    return text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
      .replace(/^No response requested\.$/m, "")
      .trim();
  }
}
