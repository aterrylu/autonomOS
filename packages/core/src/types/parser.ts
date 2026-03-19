import type { RenderItem, Turn } from "./render";

/**
 * SessionParser — provider-specific adapter that converts
 * raw session data into provider-agnostic RenderItems.
 *
 * Each agent CLI (Claude Code, Gemini CLI, etc.) writes its own
 * session format. Parsers normalize these into RenderItem[].
 */
export interface SessionParser {
  readonly provider: string;

  /** Parse raw session entries into render items */
  parse(entries: unknown[]): RenderItem[];

  /** Group render items into conversation turns */
  groupIntoTurns(items: RenderItem[]): Turn[];
}
