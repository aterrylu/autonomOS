/**
 * RenderItem — the provider-agnostic contract between parsers and renderers.
 *
 * Parsers (e.g., ClaudeCodeParser) produce RenderItem[].
 * Renderers (e.g., AssistantUIRenderer, ShadcnRenderer) consume them.
 * Adding a new provider means adding a new parser, not changing the UI.
 */

/** A block of assistant text (markdown) */
export interface TextItem {
  type: "text";
  content: string;
  /** Unique ID for keying in React */
  id: string;
  isSidechain?: boolean;
}

/** A thinking/reasoning block from extended thinking */
export interface ThinkingItem {
  type: "thinking";
  content: string;
  id: string;
  isSidechain?: boolean;
}

/** A tool invocation paired with its result */
export interface ToolCallItem {
  type: "tool_call";
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  result?: string;
  isError: boolean;
  status: "pending" | "complete" | "error";
  id: string;
  isSidechain?: boolean;
}

/** A user message */
export interface UserPromptItem {
  type: "user_prompt";
  content: string;
  id: string;
  isSidechain?: boolean;
}

/** A system event (init, compact, status, etc.) */
export interface SystemItem {
  type: "system";
  subtype: string;
  content?: string;
  id: string;
  isSidechain?: boolean;
}

export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem
  | SystemItem;

/**
 * A turn groups consecutive RenderItems from the same role.
 * Assistant turns contain text, thinking, and tool_call items.
 * User turns contain user_prompt items.
 */
export interface Turn {
  role: "user" | "assistant" | "system";
  items: RenderItem[];
  timestamp?: string;
  /** True when this turn is from a sub-agent (isSidechain JSONL entries) */
  isSidechain?: boolean;
}
