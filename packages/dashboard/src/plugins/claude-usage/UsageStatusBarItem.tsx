import { useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import type { RateLimitWindow } from "./types";
import { UsagePanel } from "./UsagePanel";
import { useClickOutside } from "./useClickOutside";
import { useUsageData } from "./useUsageData";
import { timeUntilReset, utilizationColor } from "./utils";

function MiniBar({ pct }: { pct: number }) {
  const color = utilizationColor(pct);
  return (
    <span
      className="inline-block h-2 rounded-sm overflow-hidden align-middle"
      style={{ width: 28, background: `${color}22` }}
    >
      <span
        className="block h-full rounded-sm"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </span>
  );
}

function WindowLabel({
  label,
  window,
  mode,
}: {
  label: string;
  window: RateLimitWindow;
  mode: "text" | "bar";
}) {
  const pct = Math.round(window.utilization);
  const reset = timeUntilReset(window.resetsAt);
  const title = `${label}: ${pct}% used${reset ? ` · resets in ${reset}` : ""}`;

  if (mode === "bar") {
    return (
      <span className="inline-flex items-center gap-1" title={title}>
        <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>
        <MiniBar pct={pct} />
      </span>
    );
  }

  return (
    <span title={title}>
      <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>{" "}
      <span style={{ color: utilizationColor(pct) }}>{pct}%</span>
    </span>
  );
}

function FloatingPanel({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-1 min-w-[340px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
      }}
    >
      {children}
    </div>
  );
}

function SetupPanel({ onClose }: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  return (
    <FloatingPanel onClose={onClose}>
      <div className="font-medium text-sm mb-2">Claude Usage Setup</div>
      <div className="mb-3" style={{ color: page.statusFg }}>
        To see your rate limits, add your Claude session cookie to{" "}
        <code
          className="rounded px-1 py-0.5"
          style={{ background: page.border }}
        >
          .env
        </code>
      </div>
      <ol
        className="list-decimal list-inside space-y-2 mb-3"
        style={{ color: page.statusFg }}
      >
        <li>
          Go to{" "}
          <a
            href="https://claude.ai"
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: page.fg }}
          >
            claude.ai
          </a>
        </li>
        <li>
          Open DevTools (<kbd>Cmd+Option+I</kbd>) &rarr;{" "}
          <strong>Application</strong> &rarr; <strong>Cookies</strong>
        </li>
        <li>
          Copy the{" "}
          <code
            className="rounded px-1 py-0.5"
            style={{ background: page.border }}
          >
            sessionKey
          </code>{" "}
          value
        </li>
        <li>
          Add to your <code>.env</code> file:
        </li>
      </ol>
      <div
        className="rounded p-2 font-mono text-[11px] mb-2 select-all"
        style={{ background: page.border, wordBreak: "break-all" }}
      >
        CLAUDE_SESSION_COOKIE=sessionKey=sk-ant-...
      </div>
      <div style={{ color: page.statusFg }}>
        Then restart the server (<code>make up</code>).
      </div>
    </FloatingPanel>
  );
}

function ErrorPanel({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  return (
    <FloatingPanel onClose={onClose}>
      <div className="font-medium text-sm mb-2">Usage Error</div>
      <div
        className="rounded px-2 py-1.5 mb-3"
        style={{ background: "#ea6c7315", color: "#ea6c73" }}
      >
        {error}
      </div>
      <div style={{ color: page.statusFg }}>
        If your session cookie expired, update{" "}
        <code
          className="rounded px-1 py-0.5"
          style={{ background: page.border }}
        >
          CLAUDE_SESSION_COOKIE
        </code>{" "}
        in <code>.env</code> and restart the server.
      </div>
    </FloatingPanel>
  );
}

export function UsageStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error, displayMode, setDisplayMode } = useUsageData();
  const [panelOpen, setPanelOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-1"
        style={{ color: page.statusFg }}
        title={`Usage error: ${error}`}
      >
        <Codicon name="claude" size={14} /> –
      </span>
    );
  }

  if (!data) {
    return (
      <span
        className="inline-flex items-center gap-1"
        style={{ color: page.statusFg }}
      >
        <Codicon name="claude" size={14} /> …
      </span>
    );
  }

  if (data.needsSetup) {
    return (
      <div className="relative">
        <button
          type="button"
          className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
          style={{ color: "#e6b450" }}
          onClick={() => setPanelOpen(!panelOpen)}
          title="Click to set up Claude usage tracking"
        >
          <Codicon name="claude" size={14} /> setup needed
        </button>
        {panelOpen && <SetupPanel onClose={() => setPanelOpen(false)} />}
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="relative">
        <button
          type="button"
          className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
          style={{ color: "#ea6c73" }}
          onClick={() => setPanelOpen(!panelOpen)}
          title={data.error}
        >
          <Codicon name="claude" size={14} /> err
        </button>
        {panelOpen && (
          <ErrorPanel error={data.error} onClose={() => setPanelOpen(false)} />
        )}
      </div>
    );
  }

  const hasData = data.fiveHour || data.sevenDay;
  if (!hasData) {
    return (
      <span
        className="inline-flex items-center gap-1"
        style={{ color: page.statusFg }}
        title="No rate limit data available"
      >
        <Codicon name="claude" size={14} /> n/a
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        ref={toggleRef}
        type="button"
        className="inline-flex items-center gap-2 cursor-pointer hover:opacity-80"
        style={{ color: page.fg }}
        onClick={() => setPanelOpen(!panelOpen)}
        title="Click for rate limit details"
      >
        <Codicon name="claude" size={14} />
        {data.fiveHour && (
          <WindowLabel label="5h" window={data.fiveHour} mode={displayMode} />
        )}
        {data.sevenDay && (
          <WindowLabel label="7d" window={data.sevenDay} mode={displayMode} />
        )}
      </button>
      {panelOpen && (
        <UsagePanel
          data={data}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onClose={() => setPanelOpen(false)}
          toggleRef={toggleRef}
        />
      )}
    </div>
  );
}
