import { useEffect, useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import { type SaveValidateResult, saveAndValidate } from "./saveAndValidate";
import {
  type ErrorKind,
  isCredentialError,
  type RateLimitData,
  type RateLimitWindow,
} from "./types";
import { UsagePanel } from "./UsagePanel";
import { useClickOutside } from "./useClickOutside";
import { useUsageData } from "./useUsageData";
import { timeUntilReset, utilizationColor } from "./utils";

/** One-line "Connected" summary shown after a key validates successfully. */
function connectedSummary(data: RateLimitData): string {
  const pct = data.fiveHour ? Math.round(data.fiveHour.utilization) : null;
  return pct != null
    ? `Connected — 5h usage at ${pct}%.`
    : "Connected — usage is now tracking.";
}

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
        zIndex: 50,
      }}
    >
      {children}
    </div>
  );
}

type SetupPhase = "input" | "working" | "success" | "failed";

/** Guidance under a failed validation, tailored to the failure category. */
function failureHint(kind: ErrorKind | undefined): string {
  return isCredentialError(kind)
    ? "Double-check you copied the entire sessionKey value (it's long) from claude.ai → Application → Cookies."
    : "Your key looks fine — this is a temporary claude.ai issue. Retry now, or close and it'll recover on its own.";
}

function setupButtonLabel(phase: SetupPhase): string {
  if (phase === "working") return "Checking your key…";
  if (phase === "success") return "Connected ✓";
  if (phase === "failed") return "Retry";
  return "Save & verify";
}

function SetupPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [sessionKey, setSessionKey] = useState("");
  const [phase, setPhase] = useState<SetupPhase>("input");
  const [result, setResult] = useState<SaveValidateResult | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Don't fire the auto-close (or its setState) after the panel unmounts —
  // the user can dismiss via click-outside during the 1.6s success window.
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  async function handleSave() {
    if (!sessionKey.trim() || phase === "working") return;
    setPhase("working");
    // Save the key AND verify it against claude.ai before reporting success —
    // a persisted-but-invalid key is exactly the loop this fix removes.
    const res = await saveAndValidate(sessionKey.trim());
    setResult(res);
    if (res.kind === "ok") {
      setPhase("success");
      onSaved(); // refresh the status bar behind the panel
      closeTimer.current = setTimeout(() => onClose(), 1600);
    } else {
      setPhase("failed");
    }
  }

  function handleKeyChange(value: string) {
    setSessionKey(value);
    // Editing after a failed attempt clears the stale error so the panel
    // doesn't show last try's message next to a freshly-typed key.
    if (phase === "failed") {
      setPhase("input");
      setResult(null);
    }
  }

  const busy = phase === "working" || phase === "success";
  const inputStyle = {
    background: page.border,
    color: page.fg,
    border: "none",
    outline: "none",
  };

  return (
    <FloatingPanel onClose={onClose}>
      <div className="font-medium text-sm mb-2">Claude Usage Setup</div>
      <ol
        className="list-decimal list-inside space-y-1.5 mb-3"
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
          DevTools (<kbd>Cmd+Opt+I</kbd>) {">"} Application {">"} Cookies
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
      </ol>

      <div className="space-y-2 mb-3">
        <div>
          <label
            htmlFor="claude-session-key"
            className="block text-[10px] mb-0.5"
            style={{ color: page.statusFg }}
          >
            Session Key *
          </label>
          <input
            id="claude-session-key"
            type="password"
            value={sessionKey}
            disabled={busy}
            onChange={(e) => handleKeyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            placeholder="sk-ant-sid01-..."
            className="w-full rounded px-2 py-1.5 text-xs font-mono disabled:opacity-60"
            style={inputStyle}
          />
        </div>
      </div>

      {phase === "success" && result?.kind === "ok" && (
        <div
          className="rounded px-2 py-1.5 text-xs mb-3"
          style={{ background: "#23863615", color: "#3fb950" }}
        >
          {connectedSummary(result.data)}
        </div>
      )}

      {phase === "failed" && result && result.kind !== "ok" && (
        <div className="mb-3">
          <div
            className="rounded px-2 py-1.5 text-xs"
            style={{ background: "#ea6c7315", color: "#ea6c73" }}
          >
            {result.message}
          </div>
          <div className="mt-1.5 text-[11px]" style={{ color: page.statusFg }}>
            {result.kind === "unreachable"
              ? "Couldn't reach the autonomOS server — check it's running, then retry."
              : failureHint(result.errorKind)}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={!sessionKey.trim() || busy}
        className="w-full rounded px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: phase === "success" ? "#238636" : "#16825d",
          color: "#fff",
        }}
      >
        {setupButtonLabel(phase)}
      </button>
    </FloatingPanel>
  );
}

function ErrorPanel({
  error,
  errorKind,
  onClose,
  onReconfigure,
  onRetry,
}: {
  error: string;
  errorKind?: ErrorKind;
  onClose: () => void;
  onReconfigure: () => void;
  onRetry: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  // Only a credential failure can be fixed by re-entering the key. For
  // transient failures (rate limit, outage) we offer a retry instead of
  // pushing the user into a reconfigure loop that cannot help.
  const credential = isCredentialError(errorKind);

  return (
    <FloatingPanel onClose={onClose}>
      <div className="font-medium text-sm mb-2">
        {credential ? "Session key problem" : "Usage temporarily unavailable"}
      </div>
      <div
        className="rounded px-2 py-1.5 mb-3"
        style={{ background: "#ea6c7315", color: "#ea6c73" }}
      >
        {error}
      </div>
      {credential ? (
        <button
          type="button"
          onClick={onReconfigure}
          className="w-full rounded px-3 py-1.5 text-xs font-medium cursor-pointer"
          style={{ background: "#16825d", color: "#fff" }}
        >
          Reconfigure
        </button>
      ) : (
        <>
          <div className="mb-3 text-[11px]" style={{ color: page.statusFg }}>
            This isn't a problem with your session key — no need to reconfigure.
          </div>
          <button
            type="button"
            onClick={() => {
              onRetry();
              onClose();
            }}
            className="w-full rounded px-3 py-1.5 text-xs font-medium cursor-pointer"
            style={{ background: "#16825d", color: "#fff" }}
          >
            Retry now
          </button>
        </>
      )}
    </FloatingPanel>
  );
}

export function UsageStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error, displayMode, setDisplayMode, refetch } = useUsageData();
  const [panel, setPanel] = useState<"none" | "error" | "setup" | "usage">(
    "none",
  );
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
          onClick={() => setPanel(panel === "none" ? "setup" : "none")}
          title="Click to set up Claude usage tracking"
        >
          <Codicon name="claude" size={14} /> setup needed
        </button>
        {panel === "setup" && (
          <SetupPanel onClose={() => setPanel("none")} onSaved={refetch} />
        )}
      </div>
    );
  }

  if (data.error) {
    // A bad credential is the user's to fix (red, "err"); a transient outage
    // is not (amber, "delayed") — the label shouldn't imply user error.
    const credential = isCredentialError(data.errorKind);
    return (
      <div className="relative">
        <button
          type="button"
          className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
          style={{ color: credential ? "#ea6c73" : "#e6b450" }}
          onClick={() => setPanel(panel === "none" ? "error" : "none")}
          title={data.error}
        >
          <Codicon name="claude" size={14} /> {credential ? "err" : "delayed"}
        </button>
        {panel === "error" && (
          <ErrorPanel
            error={data.error}
            errorKind={data.errorKind}
            onClose={() => setPanel("none")}
            onReconfigure={() => setPanel("setup")}
            onRetry={refetch}
          />
        )}
        {panel === "setup" && (
          <SetupPanel onClose={() => setPanel("none")} onSaved={refetch} />
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
        onClick={() => setPanel(panel === "none" ? "usage" : "none")}
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
      {panel === "usage" && (
        <UsagePanel
          data={data}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onClose={() => setPanel("none")}
          onRefetch={refetch}
          toggleRef={toggleRef}
        />
      )}
    </div>
  );
}
