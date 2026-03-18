import type { RenderItem, SystemItem, ToolCallItem, Turn } from "@autonomos/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useEffect, useRef, useState } from "react";
import { THEMES, useStore } from "../../store";
import { DiffView } from "./DiffView";

interface ConversationData {
  sessionId: string;
  turns: Turn[];
  itemCount: number;
  entryCount: number;
}

// ── Markdown renderer with syntax-highlighted code blocks ────────────────────

const mdComponents = {
  code({ className, children, ...props }: React.ComponentProps<"code"> & { inline?: boolean }) {
    const lang = (className || "").match(/^language-(\w+)$/)?.[1];
    if (!props.inline && lang) {
      return (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={lang}
          PreTag="div"
          customStyle={{ margin: "0.5em 0", borderRadius: "4px", fontSize: "11px" }}
        >
          {String(children).replace(/\n$/, "")}
        </SyntaxHighlighter>
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
};

function MarkdownText({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {children}
    </ReactMarkdown>
  );
}

// ── Tool call block ──────────────────────────────────────────────────────────

function toolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": return String(input.command || "").slice(0, 100);
    case "Read":
    case "Write":
    case "Edit": return String(input.file_path || "");
    case "Glob":
    case "Grep": return String(input.pattern || input.glob || "");
    case "Agent": return String(input.description || "").slice(0, 80);
    default: return Object.values(input).map(String).join(" ").slice(0, 80);
  }
}

function ToolBlock({ item }: { item: ToolCallItem }) {
  const [expanded, setExpanded] = useState(false);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const isError = item.isError || item.status === "error";
  const isPending = item.status === "pending";
  const dot = isError ? "✗" : isPending ? "○" : "✓";
  const dotColor = isError ? "#ea6c73" : isPending ? page.statusFg : "#91b362";
  const codeBg = theme === "daylight" ? "#e8e8e6" : `${page.border}88`;
  const blockBg = theme === "daylight" ? "#f0f0ee" : `${page.border}55`;

  return (
    <div
      className="rounded text-xs font-mono overflow-hidden"
      style={{ background: blockBg, border: `1px solid ${page.border}` }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 cursor-pointer text-left bg-transparent border-none"
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ color: dotColor }} className="shrink-0 w-3">{dot}</span>
        <span className="font-semibold shrink-0" style={{ color: page.fg }}>{item.toolName}</span>
        <span className="truncate flex-1 text-[11px]" style={{ color: page.statusFg }}>
          {toolSummary(item.toolName, item.input)}
        </span>
        <span className="text-[10px] shrink-0" style={{ color: page.statusFg }}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 space-y-2" style={{ borderTop: `1px solid ${page.border}` }}>
          {item.toolName === "Edit" ? (
            <div className="pt-2">
              {!!item.input.file_path && (
                <div className="text-[11px] mb-1.5" style={{ color: page.statusFg }}>
                  {String(item.input.file_path)}
                </div>
              )}
              <DiffView
                oldText={String(item.input.old_string || "")}
                newText={String(item.input.new_string || "")}
                codeBg={codeBg}
              />
            </div>
          ) : (
            <div className="pt-2">
              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: page.statusFg }}>Input</div>
              <pre
                className="whitespace-pre-wrap break-all text-[11px] rounded p-2"
                style={{ color: page.fg, background: codeBg }}
              >
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </div>
          )}

          {item.result && (
            <div>
              <div
                className="text-[10px] uppercase tracking-wider mb-1"
                style={{ color: isError ? "#ea6c73" : page.statusFg }}
              >
                {isError ? "Error" : "Result"}
              </div>
              <pre
                className="whitespace-pre-wrap break-all text-[11px] max-h-48 overflow-y-auto rounded p-2"
                style={{ color: isError ? "#ea6c73" : page.fg, background: codeBg }}
              >
                {item.result.length > 2000
                  ? `${item.result.slice(0, 2000)}\n… (${item.result.length.toLocaleString()} chars)`
                  : item.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking block ───────────────────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const codeBg = theme === "daylight" ? "#e8e8e6" : `${page.border}88`;
  const blockBg = theme === "daylight" ? "#f0f0ee" : `${page.border}55`;

  return (
    <div
      className="rounded text-xs font-mono overflow-hidden"
      style={{ background: blockBg, border: `1px solid ${page.border}` }}
    >
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer bg-transparent border-none"
        onClick={() => setExpanded(!expanded)}
        style={{ color: page.statusFg }}
      >
        <span className="italic">thinking{expanded ? "" : "…"}</span>
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-1" style={{ borderTop: `1px solid ${page.border}` }}>
          <pre
            className="whitespace-pre-wrap text-[11px] max-h-64 overflow-y-auto rounded p-2"
            style={{ color: page.statusFg, background: codeBg }}
          >
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Compaction divider ───────────────────────────────────────────────────────

function CompactionDivider({ item }: { item: SystemItem }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const tokens = item.content ? Number(item.content).toLocaleString() : null;

  return (
    <div className="flex items-center gap-3 py-1" style={{ color: page.statusFg }}>
      <div className="flex-1 border-t" style={{ borderColor: page.border }} />
      <span className="text-[11px] font-mono shrink-0 italic select-none">
        context compacted{tokens ? ` · ${tokens} tokens` : ""}
      </span>
      <div className="flex-1 border-t" style={{ borderColor: page.border }} />
    </div>
  );
}

// ── Turn renderers ───────────────────────────────────────────────────────────

function AssistantTurn({ turn }: { turn: Turn }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  return (
    <div className="space-y-2">
      {turn.items.map((item) => {
        if (item.type === "thinking") {
          return <ThinkingBlock key={item.id} content={item.content} />;
        }
        if (item.type === "tool_call") {
          return <ToolBlock key={item.id} item={item} />;
        }
        if (item.type === "text" && item.content.trim()) {
          return (
            <div key={item.id} className="prose-tui text-sm leading-relaxed" style={{ color: page.fg }}>
              <MarkdownText>{item.content}</MarkdownText>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function UserTurn({ turn }: { turn: Turn }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const text = turn.items
    .filter((i): i is RenderItem & { type: "user_prompt"; content: string } => i.type === "user_prompt")
    .map((i) => i.content)
    .join("\n");

  if (!text.trim()) return null;

  return (
    <div className="flex gap-2">
      <span className="shrink-0 font-mono text-sm font-semibold select-none" style={{ color: "#16825d" }}>
        &gt;
      </span>
      <span className="text-sm font-mono whitespace-pre-wrap" style={{ color: page.fg }}>
        {text}
      </span>
    </div>
  );
}

// ── Main conversation view ───────────────────────────────────────────────────

function TUIThread({ turns }: { turns: Turn[] }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [turns]);

  return (
    <div
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4 font-mono text-sm"
      style={{ color: page.fg }}
    >
      {turns.map((turn, i) => {
        if (turn.role === "user") return <UserTurn key={i} turn={turn} />;
        if (turn.role === "assistant") return <AssistantTurn key={i} turn={turn} />;
        if (turn.role === "system") {
          return turn.items
            .filter((item): item is SystemItem =>
              item.type === "system" && (item as SystemItem).subtype === "compact_boundary"
            )
            .map((item) => <CompactionDivider key={item.id} item={item} />);
        }
        return null;
      })}
      <div ref={bottomRef} />
    </div>
  );
}

export function ConversationView() {
  const [data, setData] = useState<ConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const sessions = useStore((s) => s.sessions);
  const activePane = useStore((s) => s.activePane);
  const activeSessionId = activePane?.type === "session" ? activePane.id : undefined;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const claudeSessionId = activeSession?.claudeSessionId;
  // sessions is transient — wait for it to be populated before erroring
  const sessionsLoaded = sessions.length > 0;

  useEffect(() => {
    if (!sessionsLoaded) return; // still loading
    if (!claudeSessionId) {
      setLoading(false);
      setError("No conversation history for this session yet");
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/conversation/${claudeSessionId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<ConversationData>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [claudeSessionId, sessionsLoaded]);

  const placeholder = (msg: string) => (
    <div className="flex flex-1 items-center justify-center text-sm font-mono" style={{ color: page.statusFg }}>
      {msg}
    </div>
  );

  if (loading) return placeholder("loading…");
  if (error) return placeholder(error);
  if (!data || data.turns.length === 0) return placeholder("no conversation data");

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TUIThread turns={data.turns} />
    </div>
  );
}
