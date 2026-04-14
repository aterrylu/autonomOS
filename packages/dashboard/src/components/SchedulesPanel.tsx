import type { RunRecord, Schedule, SchedulerStatus } from "@autonomos/core";
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { THEMES, useStore } from "../store";

/**
 * SchedulesPanel — view and manage cron schedules.
 *
 * No create button: agents create schedules via MCP tools.
 * Dashboard shows status, run history, and controls (toggle, run now, delete).
 */

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

// ── Human-readable cron ─────────────────────────────────────────

function humanCron(expr: string): string {
  if (expr.startsWith("once:")) {
    const d = new Date(expr.slice(5));
    return `Once at ${d.toLocaleString()}`;
  }
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const dowNames: Record<string, string> = {
    "1": "Mon",
    "2": "Tue",
    "3": "Wed",
    "4": "Thu",
    "5": "Fri",
    "6": "Sat",
    "0": "Sun",
    "7": "Sun",
    "1-5": "weekdays",
    "0,6": "weekends",
    "6,0": "weekends",
  };

  if (min.startsWith("*/")) return `Every ${min.slice(2)} min`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;

  if (hour !== "*" && min !== "*" && dom === "*" && mon === "*") {
    const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `Daily at ${time}`;
    const dayStr = dowNames[dow] ?? `day ${dow}`;
    return `${dayStr} at ${time}`;
  }

  return expr;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "overdue";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

const STATUS_ICONS: Record<string, string> = {
  success: "\u2713",
  failure: "\u2717",
  skipped: "\u2298",
  running: "\u25C9",
};

const STATUS_COLORS: Record<string, string> = {
  success: "#91b362",
  failure: "#ea6c73",
  running: "#53bdfa",
};

function statusColor(status: string, fallback: string): string {
  return STATUS_COLORS[status] ?? fallback;
}

// ── Schedule Card ───────────────────────────────────────────────

interface ScheduleCardProps {
  name: string;
  schedule: Schedule;
  page: PageTheme;
}

function ScheduleCard({ name, schedule, page }: ScheduleCardProps) {
  const { deleteSchedule, runSchedule, updateSchedule, fetchSchedules } =
    useStore(
      useShallow((s) => ({
        deleteSchedule: s.deleteSchedule,
        runSchedule: s.runSchedule,
        updateSchedule: s.updateSchedule,
        fetchSchedules: s.fetchSchedules,
      })),
    );

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await fetch(
        `/api/schedules/${encodeURIComponent(name)}/runs?limit=20`,
      );
      if (res.ok) {
        const data = await res.json();
        setRuns(data);
      }
    } catch {
      // non-critical
    }
    setLoadingRuns(false);
  }, [name]);

  const handleToggleEnabled = async () => {
    try {
      await updateSchedule(name, { enabled: !schedule.enabled });
      fetchSchedules();
    } catch (err) {
      console.warn("Toggle failed:", err);
    }
  };

  const handleRunNow = async () => {
    try {
      await runSchedule(name);
      fetchSchedules();
    } catch (err) {
      console.warn("Run failed:", err);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteSchedule(name);
    } catch (err) {
      console.warn("Delete failed:", err);
    }
  };

  const toggleExpand = () => {
    if (!expanded) loadRuns();
    setExpanded(!expanded);
  };

  const { state } = schedule;

  return (
    <div
      className="relative group"
      style={{
        background: "rgba(28, 36, 51, 0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        {/* Enable/disable toggle dot */}
        <button
          type="button"
          onClick={handleToggleEnabled}
          className="cursor-pointer shrink-0"
          title={schedule.enabled ? "Disable" : "Enable"}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: schedule.enabled ? "#22c55e" : "rgba(255,255,255,0.2)",
            border: schedule.enabled
              ? "1px solid #16a34a"
              : "1px solid rgba(255,255,255,0.1)",
          }}
        />
        <div className="flex-1 min-w-0">
          <span
            className="text-[13px] font-semibold tracking-tight truncate block"
            style={{ color: "#e6e1cf" }}
          >
            {name}
          </span>
        </div>
        {/* Run now */}
        <button
          type="button"
          onClick={handleRunNow}
          className="text-[10px] px-2 py-0.5 rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            background: "rgba(34,197,94,0.15)",
            color: "#91b362",
            border: "1px solid rgba(34,197,94,0.3)",
          }}
          title="Run now"
        >
          Run
        </button>
        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleDelete}
              className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
              style={{ background: "#ea6c73", color: "#fff" }}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: "#e6e1cf",
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: "#ea6c73" }}
            title="Delete"
          >
            Del
          </button>
        )}
      </div>

      {/* Meta line */}
      <div className="text-[11px] mb-2" style={{ color: page.statusFg }}>
        <span title={schedule.schedule}>{humanCron(schedule.schedule)}</span>
        <span className="opacity-40 mx-1.5">&middot;</span>
        <span>{schedule.target}</span>
      </div>

      {/* Description */}
      {schedule.description && (
        <div
          className="text-[10px] mb-2 line-clamp-1"
          style={{ color: page.statusFg, opacity: 0.7 }}
        >
          {schedule.description}
        </div>
      )}

      {/* Run status line */}
      <div
        className="flex items-center gap-1 text-[10px]"
        style={{ color: page.statusFg }}
      >
        {state.lastRunAt && state.lastRunStatus && (
          <>
            <span
              style={{
                color: statusColor(state.lastRunStatus, page.statusFg),
              }}
            >
              {STATUS_ICONS[state.lastRunStatus] ?? "?"}
            </span>
            <span>{timeAgo(state.lastRunAt)}</span>
            <span className="opacity-40 mx-0.5">&middot;</span>
          </>
        )}
        {state.nextRunAt && schedule.enabled && (
          <span>Next: {timeUntil(state.nextRunAt)}</span>
        )}
        {!schedule.enabled && <span className="italic opacity-60">paused</span>}
      </div>

      {/* Expandable run history */}
      <button
        type="button"
        onClick={toggleExpand}
        className="text-[10px] mt-2 cursor-pointer"
        style={{ color: page.statusFg, opacity: 0.6 }}
      >
        {expanded ? "\u25BE" : "\u25B8"} Run history
        {state.runCount > 0 && ` (${state.runCount} runs)`}
      </button>

      {expanded && (
        <div className="mt-2 max-h-40 overflow-y-auto">
          {loadingRuns && (
            <div className="text-[10px]" style={{ color: page.statusFg }}>
              Loading...
            </div>
          )}
          {!loadingRuns && runs.length === 0 && (
            <div
              className="text-[10px] italic"
              style={{ color: page.statusFg }}
            >
              No runs yet
            </div>
          )}
          {!loadingRuns &&
            runs
              .slice()
              .reverse()
              .map((run) => (
                <div
                  key={run.runId}
                  className="flex items-center gap-1.5 text-[10px] py-0.5"
                  style={{ color: page.statusFg }}
                >
                  <span
                    style={{
                      color: statusColor(run.status, page.statusFg),
                    }}
                  >
                    {STATUS_ICONS[run.status] ?? "?"}
                  </span>
                  <span className="font-mono">
                    {run.startedAt.slice(11, 19)}
                  </span>
                  {run.durationMs > 0 && (
                    <span className="opacity-60">
                      ({formatDuration(run.durationMs)})
                    </span>
                  )}
                  {run.error && (
                    <span
                      className="truncate max-w-[200px]"
                      style={{ color: "#ea6c73" }}
                      title={run.error}
                    >
                      {run.error}
                    </span>
                  )}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

// ── Empty State ─────────────────────────────────────────────────

function EmptyState({ page }: { page: PageTheme }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 h-full text-center px-8"
      style={{ color: page.statusFg }}
    >
      <span className="text-[14px] font-medium" style={{ color: "#e6e1cf" }}>
        No schedules yet
      </span>
      <div className="text-[11px] leading-relaxed max-w-sm opacity-80">
        Schedules are created by agents using the{" "}
        <code
          className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          create_schedule
        </code>{" "}
        tool. Ask any running agent:
      </div>
      <div className="flex flex-col gap-1 text-[11px] italic opacity-60">
        <span>&ldquo;Set up a daily GitHub summary at 9am&rdquo;</span>
        <span>&ldquo;Schedule a weekly dependency audit&rdquo;</span>
        <span>&ldquo;Run a PR review check every 30 minutes&rdquo;</span>
      </div>
    </div>
  );
}

// ── Max Concurrent Runs Control ─────────────────────────────────

function MaxRunsControl({
  status,
  page,
}: {
  status: SchedulerStatus | null;
  page: PageTheme;
}) {
  const updateSchedulerSettings = useStore((s) => s.updateSchedulerSettings);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(status?.maxConcurrentRuns ?? 3));

  const handleSave = async () => {
    const num = Number.parseInt(value, 10);
    if (num >= 1) {
      try {
        await updateSchedulerSettings(num);
      } catch {
        // revert
      }
    }
    setEditing(false);
  };

  const max = status?.maxConcurrentRuns ?? 3;

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Max:
        </span>
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          onBlur={handleSave}
          className="w-10 text-[11px] text-center rounded px-1 py-0.5"
          style={{
            background: "rgba(0,0,0,0.3)",
            border: `1px solid ${page.border}`,
            color: "#e6e1cf",
          }}
          // biome-ignore lint/a11y/noAutofocus: small inline input
          autoFocus
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setValue(String(max));
        setEditing(true);
      }}
      className="text-[10px] cursor-pointer rounded px-2 py-0.5"
      style={{
        color: page.statusFg,
        background: "rgba(255,255,255,0.04)",
        border: `1px solid ${page.border}`,
      }}
      title="Max concurrent scheduled runs"
    >
      Max runs: {max}
    </button>
  );
}

// ── Main Panel ──────────────────────────────────────────────────

export function SchedulesPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const schedules = useStore((s) => s.schedules);
  const schedulesLoading = useStore((s) => s.schedulesLoading);
  const schedulesError = useStore((s) => s.schedulesError);
  const schedulerStatus = useStore((s) => s.schedulerStatus);
  const fetchSchedules = useStore((s) => s.fetchSchedules);
  const fetchSchedulerStatus = useStore((s) => s.fetchSchedulerStatus);

  useEffect(() => {
    fetchSchedules();
    fetchSchedulerStatus();
    const interval = setInterval(() => {
      fetchSchedules();
      fetchSchedulerStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchSchedules, fetchSchedulerStatus]);

  const names = Object.keys(schedules).sort();
  const activeRuns = schedulerStatus?.activeRuns ?? 0;
  const queuedRuns = schedulerStatus?.queuedRuns ?? 0;

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background: page.bg, color: page.fg }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <div>
          <div className="flex items-center gap-2">
            <h2
              className="text-[15px] font-semibold tracking-tight"
              style={{ color: "#e6e1cf" }}
            >
              Schedules
            </h2>
            {(activeRuns > 0 || queuedRuns > 0) && (
              <span className="text-[10px]" style={{ color: "#53bdfa" }}>
                {activeRuns} running
                {queuedRuns > 0 && ` \u00B7 ${queuedRuns} queued`}
              </span>
            )}
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: page.statusFg }}>
            Created by agents &middot; ask any agent to set one up
          </p>
        </div>
        <MaxRunsControl status={schedulerStatus} page={page} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {schedulesLoading && names.length === 0 && (
          <div
            className="text-sm flex items-center justify-center h-full"
            style={{ color: page.statusFg }}
          >
            Loading schedules...
          </div>
        )}

        {schedulesError && !schedulesLoading && (
          <div className="text-sm" style={{ color: "#ea6c73" }}>
            {schedulesError}
          </div>
        )}

        {!schedulesLoading && !schedulesError && names.length === 0 && (
          <EmptyState page={page} />
        )}

        {names.length > 0 && (
          <div className="flex flex-col gap-3 max-w-2xl">
            {names.map((name) => (
              <ScheduleCard
                key={name}
                name={name}
                schedule={schedules[name]}
                page={page}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
