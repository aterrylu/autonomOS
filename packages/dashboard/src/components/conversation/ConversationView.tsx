import type { RenderItem, Turn } from "@autonomos/core";
import {
  type ThreadMessageLike,
  AuiProvider,
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { THEMES, useStore } from "../../store";

interface ConversationData {
  sessionId: string;
  turns: Turn[];
  itemCount: number;
  entryCount: number;
}

/** Convert our Turn[] into ThreadMessageLike[] for assistant-ui */
function turnsToMessages(turns: Turn[]): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];

  for (const turn of turns) {
    if (turn.role === "user") {
      const text = turn.items
        .filter((i): i is RenderItem & { type: "user_prompt" | "text" } =>
          i.type === "user_prompt" || i.type === "text",
        )
        .map((i) => i.content)
        .join("\n");

      if (text) {
        messages.push({
          role: "user",
          content: [{ type: "text", text }],
        });
      }
    } else if (turn.role === "assistant") {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown }
      > = [];

      for (const item of turn.items) {
        if (item.type === "text" && item.content) {
          parts.push({ type: "text", text: item.content });
        } else if (item.type === "tool_call") {
          parts.push({
            type: "tool-call",
            toolCallId: item.id,
            toolName: item.toolName,
            args: item.input,
            result: item.result
              ? { result: item.result, isError: item.isError }
              : undefined,
          });
        }
      }

      if (parts.length > 0) {
        messages.push({
          role: "assistant",
          content: parts as ThreadMessageLike["content"],
        });
      }
    }
  }

  return messages;
}

function ConversationRuntime({
  messages,
}: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({
    isRunning: false,
    messages,
    convertMessage: (msg) => msg,
    onNew: async () => {
      // Read-only transcript — no new messages
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

export function ConversationView() {
  const [data, setData] = useState<ConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  const activeSession = sessions.find((s) => s.id === sessionId);
  const claudeSessionId = activeSession?.claudeSessionId;

  useEffect(() => {
    if (!claudeSessionId) {
      setLoading(false);
      setError(
        "No Claude session ID — conversation view requires a resumed session",
      );
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/conversation/${claudeSessionId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((d: ConversationData) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [claudeSessionId]);

  if (loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        Loading conversation...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        {error}
      </div>
    );
  }

  if (!data || data.turns.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        No conversation data
      </div>
    );
  }

  const messages = turnsToMessages(data.turns);

  return (
    <div className="flex-1 overflow-hidden">
      <ConversationRuntime messages={messages} />
    </div>
  );
}
