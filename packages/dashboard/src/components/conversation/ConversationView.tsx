import type { Turn } from "@autonomos/core";
import { useEffect, useRef, useState } from "react";
import { THEMES, useStore } from "../../store";
import { RenderItemView } from "./RenderItemView";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock } from "./ToolCallBlock";

interface ConversationData {
  sessionId: string;
  turns: Turn[];
  itemCount: number;
  entryCount: number;
}

export function ConversationView() {
  const [data, setData] = useState<ConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
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
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({
            top: scrollRef.current.scrollHeight,
          });
        });
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

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        {data.turns.map((turn) => (
          <TurnView
            key={turn.items[0]?.id ?? crypto.randomUUID()}
            turn={turn}
          />
        ))}
        <div className="h-8" />
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  if (turn.role === "user") {
    return (
      <div className="mb-6 flex justify-end">
        {turn.items.map((item) => (
          <div
            key={item.id}
            className="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm"
            style={{
              background: theme === "daylight" ? "#e8e8e6" : `${page.border}cc`,
              color: page.fg,
            }}
          >
            <RenderItemView item={item} />
          </div>
        ))}
      </div>
    );
  }

  if (turn.role === "assistant") {
    return (
      <div className="mb-6">
        <div className="flex items-start gap-3">
          {/* Assistant avatar */}
          <div
            className="shrink-0 mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold"
            style={{
              background: theme === "daylight" ? "#d4a27f" : "#e6b450",
              color: theme === "daylight" ? "#fff" : "#0a0e14",
            }}
          >
            C
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div
              className="text-xs font-semibold mb-1"
              style={{ color: page.fg }}
            >
              Claude
            </div>
            {turn.items.map((item) => {
              if (item.type === "thinking") {
                return <ThinkingBlock key={item.id} item={item} />;
              }
              if (item.type === "tool_call") {
                return <ToolCallBlock key={item.id} item={item} />;
              }
              return (
                <div
                  key={item.id}
                  className="text-sm leading-relaxed"
                  style={{ color: page.fg }}
                >
                  <RenderItemView item={item} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
