/**
 * The in-app update modal (ADR-105): one decision screen, then progress on
 * the same surface. Presentational: all state and server calls live in
 * useUpdateFlow; the one exception is the release notes, fetched here.
 *
 * Shape (Terry picked "Option A" from the 2026-09-26 redesign):
 *  - confirm   "Update autonomOS to vX": a live agent line (+ the per-agent
 *              table when something is busy), one safety line, a callout that
 *              QUOTES any breaking change, capped notes, and the buttons.
 *              Idle: [Not now][Update and restart]. Busy: [Not now]
 *              [Update now · interrupts X][Update when idle].
 *  - waiting   an armed wait-for-idle (the amber pill reopens it)
 *  - updating  three honest stages; the fine-grained steps behind a disclosure
 *
 * Accessibility lives in the shell, so every screen gets it: the app behind
 * is inert, Tab wraps, the heading takes focus on every view change and names
 * the dialog, and a polite status region carries what changes.
 *
 * Rendered through a portal to <body> so it stacks above the status bar's
 * own stacking context (and sits outside the inert app root).
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ReleaseNote,
  type SystemReleases,
  systemApi,
  type UpgradePhase,
  type UpgradeState,
  type UpgradeStatusRecord,
} from "../../api/system";
import { isLightBg } from "../../components/recency";
import { statusLabelStyle } from "../../components/statusLabelStyle";
import {
  type AgentStatus,
  agentStatusLabel,
} from "../../components/ui/agent-status-icon";
import { holdAppInert, trapTab } from "../../hooks/modalFocus";
import { useBackdropDismiss } from "../../hooks/useBackdropDismiss";
import { pushEscapeCloser } from "../../shortcuts/escapeStack";
import { THEMES, useStore } from "../../store";
import { ReleaseMarkdown } from "./releaseMarkdown";
import {
  activeStepIndex,
  breakingReleases,
  breakingSummary,
  consequenceFor,
  FIRST_TASK_CONSEQUENCE,
  formatBytes,
  formatReleaseDate,
  formatSnapshotDate,
  joinNames,
  plural,
  SNAPSHOT_CONTENTS,
  type Stage,
  sortNewestFirst,
  stageDetail,
  stageFor,
  stepsFor,
} from "./updateFlow";
import type { UpdateFlow } from "./useUpdateFlow";

// ── colors: from the theme, never one set for every background ──────────

export interface Accents {
  /** Text/icon green. */
  green: string;
  /** Fill behind white text (primary button). */
  greenFill: string;
  amber: string;
  red: string;
  /** Fill behind white text (danger button). */
  redFill: string;
  blue: string;
}

/** Every value clears 4.5:1 as text on its theme's page background (and the
 *  fills clear 4.5:1 under white text). The old single set measured 1.74:1
 *  (amber) and 2.28:1 (blue) on Daylight. */
export function accentsFor(bg: string): Accents {
  return isLightBg(bg)
    ? {
        green: "#1a7f37",
        greenFill: "#1a7f37",
        amber: "#8a6100",
        red: "#b31d28",
        redFill: "#b31d28",
        blue: "#0366d6",
      }
    : {
        green: "#3fb27f",
        greenFill: "#16825d",
        amber: "#e6b450",
        red: "#f0868c",
        redFill: "#c42b35",
        blue: "#58a6ff",
      };
}

export interface VersionInfo {
  version: string;
  latest: string;
  installMode: "bundle" | "source" | null;
  releaseUrl: string | null;
  platform: string | null;
  arch: string | null;
}

type Page = (typeof THEMES)[keyof typeof THEMES]["page"];

function usePage(): Page {
  const theme = useStore((s) => s.theme);
  return THEMES[theme].page;
}

export function useAccents(): Accents {
  return accentsFor(usePage().bg);
}

const TITLE_ID = "update-dialog-title";

// ── small building blocks ───────────────────────────────────────────────

function Button({
  kind = "secondary",
  children,
  ...rest
}: {
  kind?: "primary" | "secondary" | "danger";
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const page = usePage();
  const a = useAccents();
  const style =
    kind === "primary"
      ? {
          background: a.greenFill,
          color: "#fff",
          border: `1px solid ${a.greenFill}`,
        }
      : kind === "danger"
        ? {
            background: "transparent",
            color: a.red,
            border: `1px solid ${a.red}`,
          }
        : {
            background: "transparent",
            color: page.fg,
            border: `1px solid ${page.border}`,
          };
  return (
    <button
      type="button"
      className="min-h-[30px] rounded px-3 py-1.5 text-xs font-medium cursor-pointer hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
      style={style}
      {...rest}
    >
      {children}
    </button>
  );
}

function Spinner({ size = 14, color }: { size?: number; color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="2.4"
      strokeLinecap="round"
      className="motion-safe:animate-spin"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function InfoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5v.5" />
    </svg>
  );
}

function WarnIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5v.5" />
    </svg>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: 8, height: 8, background: color }}
    />
  );
}

/** The screen's heading. It names the dialog (aria-labelledby) and takes
 *  focus on every view change, so a screen reader hears where it landed. */
function Header({
  title,
  subtitle,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
}) {
  const page = usePage();
  return (
    <div className="flex gap-3 px-4 pt-4 pb-2 sm:px-5">
      {icon}
      <div className="flex min-w-0 flex-col gap-1">
        <h2
          id={TITLE_ID}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {title}
        </h2>
        {subtitle && (
          <div
            className="text-xs"
            style={{ color: page.statusFg }}
            data-testid="update-subtitle"
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sticky, so the actions stay reachable when the dialog has to scroll
 *  (400% zoom leaves ~256 CSS px of height). */
function Footer({ left, children }: { left?: ReactNode; children: ReactNode }) {
  const page = usePage();
  return (
    <div
      className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-5"
      style={{ borderTop: `1px solid ${page.border}`, background: page.bg }}
    >
      {left && (
        <div
          className="mr-auto min-w-0 text-xs"
          style={{ color: page.statusFg }}
        >
          {left}
        </div>
      )}
      {children}
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  const a = useAccents();
  return (
    <div
      role="alert"
      className="rounded px-2 py-1.5 text-xs"
      style={{ border: `1px solid ${a.red}66`, color: a.red }}
    >
      {children}
    </div>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [
    copied,
    (text) => {
      navigator.clipboard
        ?.writeText(text)
        .then(() => setCopied(true))
        .catch(() => {});
    },
  ];
}

// ── the shell ───────────────────────────────────────────────────────────

function DialogShell({
  viewKey,
  status,
  onClose,
  children,
}: {
  /** Changes when the screen changes: focus moves to the new heading. */
  viewKey: string;
  /** Read out politely when it changes (agent check, progress). */
  status: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const page = usePage();
  const dialogRef = useRef<HTMLDivElement>(null);

  // The app behind can't be reached while this is open; focus returns to
  // where it was (the pill) once the app is interactive again.
  useEffect(() => {
    const prev = document.activeElement;
    const release = holdAppInert();
    return () => {
      release();
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);

  // Every screen change lands on its heading — never on <body>.
  useEffect(() => {
    void viewKey;
    const heading = dialogRef.current?.querySelector<HTMLElement>(
      `#${TITLE_ID}`,
    );
    (heading ?? dialogRef.current)?.focus();
  }, [viewKey]);

  // Escape rides the registry's ui.dismiss entry (ADR-065).
  useEffect(() => pushEscapeCloser(onClose), [onClose]);
  // Survives a text selection that starts or ends over the backdrop.
  const backdrop = useBackdropDismiss(onClose);

  return createPortal(
    // Backdrop: mouse dismissal via useBackdropDismiss; keyboard dismissal is Escape (the registry's ui.dismiss).
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-3 pt-[6vh] font-sans"
      style={{ background: "rgba(0,0,0,0.55)" }}
      {...backdrop}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        data-testid="update-dialog"
        data-view={viewKey}
        onKeyDown={(e) => trapTab(e, dialogRef.current)}
        className="flex w-[640px] max-w-full max-h-[90dvh] flex-col overflow-y-auto rounded-lg shadow-xl outline-none"
        style={{
          background: page.bg,
          color: page.fg,
          border: `1px solid ${page.border}`,
        }}
      >
        <output aria-live="polite" className="sr-only">
          {status}
        </output>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── release notes ───────────────────────────────────────────────────────

type NotesState =
  | { kind: "loading" }
  | { kind: "ok"; data: SystemReleases; releases: ReleaseNote[] }
  | { kind: "unavailable" };

/** Refetches when the target moves (VERSION_CHANGED → new `latest`). */
function useReleaseNotes(latest: string, enabled: boolean): NotesState {
  const [notes, setNotes] = useState<NotesState>({ kind: "loading" });
  useEffect(() => {
    void latest;
    if (!enabled) return;
    const ctrl = new AbortController();
    setNotes({ kind: "loading" });
    systemApi
      .releases({ signal: ctrl.signal })
      .then((data) => {
        if (!data || !Array.isArray(data.releases)) {
          setNotes({ kind: "unavailable" });
          return;
        }
        setNotes({
          kind: "ok",
          data,
          releases: sortNewestFirst(data.releases),
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setNotes({ kind: "unavailable" });
      });
    return () => ctrl.abort();
  }, [latest, enabled]);
  return notes;
}

function releaseUrlOf(notes: NotesState, info: VersionInfo): string | null {
  return (
    (notes.kind === "ok" ? notes.data.releaseUrl : null) ?? info.releaseUrl
  );
}

function ExternalLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  const a = useAccents();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
      style={{ color: a.blue }}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

/** Capped, so the buttons never sink below the fold. The newest release is
 *  open; older ones fold. Links inside leave the Tab order (27 PR links used
 *  to sit between the heading and the buttons) — the box itself is one
 *  focusable, scrollable region, and "Full release notes" stays a tab stop. */
function NotesBox({ notes, info }: { notes: NotesState; info: VersionInfo }) {
  const page = usePage();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    for (const a of ref.current?.querySelectorAll("a") ?? []) {
      a.setAttribute("tabindex", "-1");
    }
  });
  const releases = notes.kind === "ok" ? notes.releases : [];
  const releaseUrl = releaseUrlOf(notes, info);
  return (
    <div className="flex flex-col gap-1.5">
      <section
        ref={ref}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable to scroll it (WCAG 2.1.1).
        tabIndex={0}
        aria-label="Release notes"
        data-testid="update-notes"
        className="flex flex-col gap-3 overflow-y-auto rounded-md px-3 py-2.5"
        style={{
          maxHeight: "min(34vh, 300px)",
          border: `1px solid ${page.border}`,
        }}
      >
        {notes.kind === "loading" && (
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: page.statusFg }}
          >
            <Spinner size={12} /> Loading release notes…
          </div>
        )}
        {notes.kind === "unavailable" && (
          <div
            className="text-xs"
            data-testid="notes-unavailable"
            style={{ color: page.statusFg }}
          >
            Release notes unavailable
            {releaseUrl ? (
              <>
                {" — "}
                <ExternalLink href={releaseUrl}>view on GitHub</ExternalLink>
              </>
            ) : (
              "."
            )}
          </div>
        )}
        {notes.kind === "ok" && releases.length === 0 && (
          <div className="text-xs" style={{ color: page.statusFg }}>
            No release notes were published for this update.
          </div>
        )}
        {releases.map((r, i) => {
          const date = formatReleaseDate(r.publishedAt);
          const showName =
            r.name && r.name !== r.version && r.name !== `v${r.version}`;
          const head = (
            <>
              <span className="text-sm font-semibold">v{r.version}</span>
              {showName && <span className="truncate text-xs">{r.name}</span>}
              {date && (
                <span
                  className="ml-auto shrink-0 text-[11px]"
                  style={{ color: page.statusFg }}
                >
                  {date}
                </span>
              )}
            </>
          );
          return i === 0 ? (
            <section
              key={r.version}
              data-testid="release-section"
              data-version={r.version}
              className="flex flex-col gap-1.5"
            >
              <h3 className="flex items-baseline gap-2">{head}</h3>
              <ReleaseMarkdown body={r.body ?? ""} />
            </section>
          ) : (
            <details
              key={r.version}
              data-testid="release-section"
              data-version={r.version}
              className="flex flex-col gap-1.5"
              style={{ borderTop: `1px solid ${page.border}` }}
            >
              <summary className="flex cursor-pointer items-baseline gap-2 pt-2">
                {head}
              </summary>
              <ReleaseMarkdown body={r.body ?? ""} />
            </details>
          );
        })}
      </section>
      {releaseUrl && (
        <div className="text-xs">
          <ExternalLink href={releaseUrl} testId="update-github-link">
            Full release notes <span aria-hidden="true">↗</span>
          </ExternalLink>
        </div>
      )}
    </div>
  );
}

/** Storage-format and breaking-change callouts. The breaking one QUOTES the
 *  change; it used to say "look for it in the notes below" (nobody could). */
function Callouts({ notes, info }: { notes: NotesState; info: VersionInfo }) {
  const page = usePage();
  const a = useAccents();
  const releases = notes.kind === "ok" ? notes.releases : [];
  const breaking = breakingReleases(releases);
  // Structured server flag (a body marker) — never prose-sniffed here.
  const storageChange = releases.some((r) => r.storageFormatChange === true);
  const quotes = breaking
    .map((r) => breakingSummary(r.body ?? ""))
    .filter((q): q is string => !!q);
  return (
    <>
      {breaking.length > 0 && (
        <div
          data-testid="breaking-callout"
          className="flex gap-3 rounded-md px-3 py-2.5"
          style={{ border: `1px solid ${a.amber}88`, color: a.amber }}
        >
          <WarnIcon />
          <div className="flex flex-col gap-0.5">
            <div className="text-xs font-semibold">
              {breaking.length === 1
                ? `Breaking change in v${breaking[0].version}`
                : `Breaking changes in ${joinNames(breaking.map((r) => `v${r.version}`))}`}
            </div>
            <div
              className="text-xs"
              style={{ color: page.fg }}
              data-testid="breaking-quote"
            >
              {quotes.length > 0
                ? quotes.join(" ")
                : "The release notes describe it; read them before updating."}
            </div>
          </div>
        </div>
      )}
      {storageChange && (
        <div
          data-testid="storage-format-callout"
          className="flex gap-3 rounded-md px-3 py-2.5"
          style={{ border: `1px solid ${a.blue}88`, color: a.blue }}
        >
          <InfoIcon />
          <div className="flex flex-col gap-0.5">
            <div className="text-xs font-semibold">
              This update changes how agents are stored
            </div>
            <div className="text-xs" style={{ color: page.fg }}>
              Older versions can't read the new format. If you restore v
              {info.version} later, you get the snapshot from before this
              update, so changes made after updating won't carry over.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── agents ──────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  status: string;
  provider?: string;
  busy: boolean;
  /** Just spawned; its first task hasn't started yet. */
  reason?: "first_task";
  /** Background shell work a restart would stop (warn-only). */
  background?: { pid: number; command: string }[];
}

function useAgentRows(upgrade: UpgradeState | null): AgentRow[] {
  const sessions = useStore((s) => s.sessions);
  const statuses = useStore((s) => s.agentStatuses);
  return useMemo(() => {
    const busy = new Map((upgrade?.busy ?? []).map((b) => [b.id, b]));
    const bg = new Map(
      (upgrade?.background ?? []).map((b) => [b.id, b.processes]),
    );
    const rows: AgentRow[] = sessions.map((s) => {
      const server = busy.get(s.id);
      const status = statuses[s.id]?.status ?? server?.status ?? "unknown";
      return {
        id: s.id,
        name: s.name,
        status,
        provider: s.provider,
        busy: busy.has(s.id),
        reason: server?.reason,
        background: bg.get(s.id),
      };
    });
    // A busy agent the store doesn't know yet still has to be shown.
    for (const b of busy.values()) {
      if (!rows.some((r) => r.id === b.id)) {
        rows.push({
          id: b.id,
          name: b.name,
          status: b.status,
          busy: true,
          reason: b.reason,
          background: bg.get(b.id),
        });
      }
    }
    return [...rows.filter((r) => r.busy), ...rows.filter((r) => !r.busy)];
  }, [sessions, statuses, upgrade]);
}

/** "Stops 1 background process: npm run dev". */
function backgroundLine(procs: { command: string }[]): string {
  return `Stops ${plural(procs.length, "background process", "background processes")}: ${procs
    .map((p) => p.command)
    .join(" · ")}`;
}

/** Who the busy agents are, in a button or a heading: "busy-bee",
 *  "a and b", "3 agents". */
function busyWho(busy: { name: string }[]): string {
  return busy.length <= 2
    ? joinNames(busy.map((b) => b.name))
    : `${busy.length} agents`;
}

/** One row per agent: name · status · what the restart costs it. Stacks
 *  below 640px so nothing clips ("Nothin lost" at 390px). */
function AgentTable({ rows }: { rows: AgentRow[] }) {
  const page = usePage();
  const a = useAccents();
  const light = isLightBg(page.bg);
  return (
    <ul
      className="overflow-hidden rounded-md"
      style={{ border: `1px solid ${page.border}` }}
      data-testid="update-agent-list"
    >
      {rows.map((r, i) => {
        const color = statusLabelStyle(r.status as AgentStatus, light).color;
        return (
          <li
            key={r.id}
            data-testid="update-agent-row"
            data-busy={r.busy ? "true" : "false"}
            className="grid grid-cols-1 gap-x-3 gap-y-0.5 px-3 py-2 text-xs sm:grid-cols-[9rem_8rem_1fr]"
            style={{
              borderTop: i === 0 ? undefined : `1px solid ${page.border}`,
            }}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <Dot color={color} />
              <span className="truncate">{r.name}</span>
            </span>
            <span style={{ color }}>
              {r.reason === "first_task"
                ? "Starting"
                : agentStatusLabel(r.status as AgentStatus) || "Unknown"}
            </span>
            <span className="flex min-w-0 flex-col">
              <span>
                {r.reason === "first_task"
                  ? FIRST_TASK_CONSEQUENCE
                  : consequenceFor(r.status, r.provider)}
              </span>
              {r.background && r.background.length > 0 && (
                <span
                  style={{ color: a.amber }}
                  data-testid="update-agent-background"
                >
                  {backgroundLine(r.background)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Warn-only: agents that read idle but left work running in a background
 *  shell, which the restart stops. Never blocks the update. */
function BackgroundWarning({ rows }: { rows: AgentRow[] }) {
  const a = useAccents();
  const withBg = rows.filter((r) => r.background && r.background.length > 0);
  if (withBg.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-3 py-2 text-xs"
      style={{ border: `1px solid ${a.amber}88` }}
      data-testid="update-background-warning"
    >
      {withBg.map((r) => (
        <div key={r.id}>
          <span className="font-semibold" style={{ color: a.amber }}>
            {r.name}:
          </span>{" "}
          {backgroundLine(r.background ?? [])}.
        </div>
      ))}
      <div>
        These don't restart on their own. Start them again afterwards if you
        need them.
      </div>
    </div>
  );
}

/** The live agent check as a sentence. Also the dialog's status text. */
function agentHeadline(
  rows: AgentRow[],
  busy: AgentRow[],
): { title: string; detail: string } {
  if (busy.length === 0) {
    if (rows.length === 0)
      return { title: "No agents running.", detail: "Nothing to interrupt." };
    if (rows.length === 1)
      return {
        title: `${rows[0].name} is idle.`,
        detail: "It reopens where it left off.",
      };
    return {
      title: `All ${rows.length} agents are idle.`,
      detail: "They reopen where they left off.",
    };
  }
  return {
    title: `${busyWho(busy)} ${busy.length === 1 ? "is" : "are"} mid-task.`,
    detail: `Updating now stops ${busy.length === 1 ? "its" : "their"} current work.`,
  };
}

function AgentCheck({
  upgrade,
  rows,
  checkError,
  onRetry,
}: {
  upgrade: UpgradeState | null;
  rows: AgentRow[];
  checkError: string | null;
  onRetry: () => void;
}) {
  const page = usePage();
  const a = useAccents();
  const busy = rows.filter((r) => r.busy);
  const box = {
    border: `1px solid ${page.border}`,
  };
  if (!upgrade) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2.5 text-xs"
        style={box}
        data-testid="update-agents"
        data-state={checkError ? "error" : "checking"}
      >
        {checkError ? (
          <>
            <span style={{ color: a.red }}>
              Couldn't check your agents: {checkError}
            </span>
            <Button onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <span
            className="flex items-center gap-2"
            style={{ color: page.statusFg }}
          >
            <Spinner size={12} /> Checking your agents…
          </span>
        )}
      </div>
    );
  }
  const { title, detail } = agentHeadline(rows, busy);
  return (
    <div
      className="flex flex-col gap-2 rounded-md px-3 py-2.5 text-xs"
      style={box}
      data-testid="update-agents"
      data-state={busy.length ? "busy" : "clear"}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="flex items-center gap-1.5 font-semibold"
          style={{ color: busy.length ? a.amber : a.green }}
        >
          {busy.length ? <Dot color={a.amber} /> : <CheckIcon />}
          {title}
        </span>
        <span>{detail}</span>
      </div>
      {busy.length > 0 ? (
        <AgentTable rows={rows} />
      ) : (
        rows.length > 0 && (
          <details>
            <summary
              className="cursor-pointer"
              style={{ color: page.statusFg }}
            >
              Details
            </summary>
            <div className="pt-2">
              <AgentTable rows={rows} />
            </div>
          </details>
        )
      )}
    </div>
  );
}

function takesAbout(mode: VersionInfo["installMode"]): string {
  if (mode === "bundle") return "Under a minute.";
  if (mode === "source") return "About 1–3 minutes (it builds from source).";
  return "About a minute.";
}

function SafetyLine({
  info,
  mode,
}: {
  info: VersionInfo;
  mode: VersionInfo["installMode"];
}) {
  const page = usePage();
  return (
    <p
      className="text-xs leading-relaxed"
      style={{ color: page.statusFg }}
      data-testid="update-safety"
    >
      <span className="font-semibold" style={{ color: page.fg }}>
        {takesAbout(mode)}
      </span>{" "}
      A snapshot of your{" "}
      {SNAPSHOT_CONTENTS.charAt(0).toLowerCase() + SNAPSHOT_CONTENTS.slice(1)}{" "}
      is saved first. If v{info.latest} doesn't start, autonomOS restores v
      {info.version} on its own. You stay signed in.
    </p>
  );
}

// ── confirm: the one decision ───────────────────────────────────────────

function ConfirmScreen({
  info,
  flow,
  notes,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
  notes: NotesState;
}) {
  const { upgrade, checkError, actionError, pending } = flow;
  const rows = useAgentRows(upgrade);
  const busy = rows.filter((r) => r.busy);
  const releases = notes.kind === "ok" ? notes.releases : [];
  const newestDate = releases[0]
    ? formatReleaseDate(releases[0].publishedAt)
    : null;
  const subtitle = [
    `You're on v${info.version}`,
    newestDate && `released ${newestDate}`,
    releases.length > 1 && `${releases.length} releases since yours`,
  ]
    .filter(Boolean)
    .join(" · ");
  // Never offer the restart before we know who it would interrupt.
  const known = upgrade !== null;
  return (
    <>
      <Header
        title={`Update autonomOS to v${info.latest}`}
        subtitle={subtitle}
      />
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
        <AgentCheck
          upgrade={upgrade}
          rows={rows}
          checkError={checkError}
          onRetry={flow.retryCheck}
        />
        <BackgroundWarning rows={rows} />
        <SafetyLine
          info={info}
          mode={upgrade?.installMode ?? info.installMode}
        />
        <Callouts notes={notes} info={info} />
        <NotesBox notes={notes} info={info} />
      </div>
      <Footer>
        <Button onClick={flow.close}>Not now</Button>
        {busy.length > 0 ? (
          <>
            <Button
              kind="danger"
              disabled={pending}
              onClick={() => void flow.start("now", info.latest)}
              data-testid="update-now-interrupt"
            >
              Update now · interrupts {busyWho(busy)}
            </Button>
            <Button
              kind="primary"
              disabled={pending}
              onClick={() => void flow.start("idle", info.latest)}
              data-testid="update-start"
            >
              Update when idle
            </Button>
          </>
        ) : (
          <Button
            kind="primary"
            disabled={pending || !known}
            onClick={() => void flow.start("now", info.latest)}
            data-testid="update-start"
          >
            Update and restart
          </Button>
        )}
      </Footer>
    </>
  );
}

// ── waiting for idle ────────────────────────────────────────────────────

function WaitingScreen({
  info,
  flow,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
}) {
  const page = usePage();
  const a = useAccents();
  const { upgrade, actionError, pending } = flow;
  const rows = useAgentRows(upgrade);
  const busy = rows.filter((r) => r.busy);
  const target = upgrade?.armed?.target ?? info.latest;
  const idleSecs = Math.round((upgrade?.idleWindowMs || 30_000) / 1000);
  return (
    <>
      <Header
        title={
          busy.length
            ? `v${target} is waiting for ${busyWho(busy)}`
            : `v${target} starts in a moment`
        }
        subtitle={`It starts once every agent has been idle for ${idleSecs} seconds. Keep working; new activity resets the wait.`}
        icon={
          <span className="pt-1" style={{ color: a.amber }}>
            <Spinner size={16} />
          </span>
        }
      />
      <div
        className="flex flex-col gap-3 px-4 pb-4 sm:px-5"
        data-testid="update-waiting"
      >
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
        {busy.length > 0 ? (
          <AgentTable rows={busy} />
        ) : (
          <div
            className="flex items-center gap-1.5 text-xs font-semibold"
            style={{ color: a.green }}
          >
            <CheckIcon /> Every agent is idle.
          </div>
        )}
        <SafetyLine
          info={{ ...info, latest: target }}
          mode={upgrade?.installMode ?? info.installMode}
        />
      </div>
      <Footer
        left={
          <span style={{ color: page.statusFg }}>
            Closing this keeps the wait going.
          </span>
        }
      >
        <Button
          onClick={() => void flow.cancelArmed()}
          data-testid="update-cancel-armed"
        >
          Cancel update
        </Button>
        <Button
          kind={busy.length ? "danger" : "secondary"}
          disabled={pending}
          onClick={() => void flow.start("now", target)}
          data-testid="update-waiting-now"
        >
          {busy.length
            ? `Update now · interrupts ${busyWho(busy)}`
            : "Update now"}
        </Button>
        <Button kind="primary" onClick={flow.close}>
          Close
        </Button>
      </Footer>
    </>
  );
}

// ── progress ────────────────────────────────────────────────────────────

const STAGE_NAMES = ["Preparing", "Restarting", "Reopening agents"] as const;

function stageHints(mode: VersionInfo["installMode"] | "rollback"): string[] {
  const first =
    mode === "rollback"
      ? "Save today's state, put the old version back"
      : mode === "source"
        ? "Fetch, snapshot, build"
        : "Download, check, snapshot, install";
  return [first, "About 10 seconds", "Each one on its conversation"];
}

/** The three stages. State is text too (not only color or an icon). */
function Stages({
  stage,
  detail,
  hints,
}: {
  stage: Stage;
  detail: string;
  hints: string[];
}) {
  const page = usePage();
  const a = useAccents();
  return (
    <ol
      aria-label="Progress"
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      data-testid="update-stages"
    >
      {STAGE_NAMES.map((name, i) => {
        const state = i < stage ? "done" : i === stage ? "active" : "todo";
        return (
          <li
            key={name}
            data-stage={i}
            data-state={state}
            aria-current={state === "active" ? "step" : undefined}
            className="flex flex-col gap-0.5 rounded-md px-3 py-2 text-xs"
            style={{
              border: `1px solid ${state === "active" ? a.blue : state === "done" ? `${a.green}88` : page.border}`,
              opacity: state === "todo" ? 0.7 : 1,
            }}
          >
            <span className="flex items-center gap-1.5 font-semibold">
              {state === "done" ? (
                <span style={{ color: a.green }}>
                  <CheckIcon />
                </span>
              ) : state === "active" ? (
                <Spinner size={12} color={a.blue} />
              ) : null}
              {name}
              <span className="sr-only">
                {state === "done"
                  ? " (done)"
                  : state === "active"
                    ? " (in progress)"
                    : " (not started)"}
              </span>
            </span>
            <span style={{ color: page.statusFg }}>
              {state === "active"
                ? detail
                : state === "done"
                  ? "Done"
                  : hints[i]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function UpdatingScreen({
  info,
  flow,
  notes,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
  notes: NotesState;
}) {
  const page = usePage();
  const a = useAccents();
  const rec = flow.record;
  const to = rec?.to ?? flow.upgrade?.armed?.target ?? info.latest;
  const mode = flow.upgrade?.installMode ?? info.installMode;
  const asset =
    info.platform && info.arch
      ? `autonomos-${info.platform}-${info.arch}.tar.gz`
      : undefined;
  const rollback = rec?.kind === "rollback";
  const steps = stepsFor(rollback ? "rollback" : mode, to, {
    asset,
    snapshotId: rec?.snapshotId,
    waitIdle: rec?.waitIdle,
    waitingMessage: rec?.phase === "waiting_idle" ? rec.message : undefined,
  });
  // Monotonic within a run: a source job re-checks idle and refreshes its
  // snapshot AFTER the build — that must not walk anything backwards.
  const furthest = useRef<{ run: string | undefined; i: number; s: Stage }>({
    run: undefined,
    i: 0,
    s: 0,
  });
  const computed = activeStepIndex(steps, rec?.phase, !!rec?.verification);
  const computedStage = stageFor(rec?.phase);
  if (furthest.current.run !== rec?.startedAt) {
    furthest.current = { run: rec?.startedAt, i: computed, s: computedStage };
  } else {
    furthest.current.i = Math.max(furthest.current.i, computed);
    furthest.current.s = Math.max(furthest.current.s, computedStage) as Stage;
  }
  const active = furthest.current.i;
  const stage = furthest.current.s;
  const detail = stageDetail(rec?.phase, to, {
    rollback,
    message: rec?.message,
  });
  return (
    <>
      <Header
        title={rollback ? `Restoring v${to}` : `Updating to v${to}`}
        subtitle="Runs on the server. Closing this won't stop it."
      />
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        <Stages
          stage={stage}
          detail={detail}
          hints={stageHints(rollback ? "rollback" : mode)}
        />
        {rec?.message && rec.phase !== "waiting_idle" && (
          <div className="text-xs" style={{ color: page.statusFg }}>
            {rec.message}
          </div>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer" style={{ color: a.blue }}>
            Show details
          </summary>
          <ol className="flex flex-col gap-2 pt-2" data-testid="update-steps">
            {steps.map((s, i) => {
              const state =
                i < active ? "done" : i === active ? "active" : "pending";
              return (
                <li
                  key={s.id}
                  data-step={s.id}
                  data-state={state}
                  aria-current={state === "active" ? "step" : undefined}
                  className="flex items-start gap-2"
                >
                  <span
                    className="mt-px flex w-3.5 shrink-0 justify-center"
                    style={{
                      color:
                        state === "done"
                          ? a.green
                          : state === "active"
                            ? a.blue
                            : page.statusFg,
                    }}
                  >
                    {state === "done" ? (
                      <CheckIcon size={13} />
                    ) : state === "active" ? (
                      <Spinner size={12} />
                    ) : (
                      "·"
                    )}
                  </span>
                  <span className="flex flex-col">
                    <span
                      style={{
                        color: state === "pending" ? page.statusFg : page.fg,
                      }}
                    >
                      {s.label}
                      <span className="sr-only">
                        {state === "done"
                          ? " (done)"
                          : state === "active"
                            ? " (in progress)"
                            : ""}
                      </span>
                    </span>
                    {s.detail && (
                      <span style={{ color: page.statusFg }}>{s.detail}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </details>
        {!rollback && <NotesBox notes={notes} info={{ ...info, latest: to }} />}
      </div>
      <Footer>
        <Button kind="primary" onClick={flow.close}>
          Close
        </Button>
      </Footer>
    </>
  );
}

// ── not supervised ──────────────────────────────────────────────────────

function NotSupervisedScreen({
  info,
  forRollback,
  onDone,
}: {
  info: VersionInfo;
  forRollback: boolean;
  onDone: () => void;
}) {
  const page = usePage();
  const [copied, copy] = useCopy();
  // Shape-true advice: `autonomos upgrade` refuses on a plain dev checkout.
  const devCheckout = info.installMode === null;
  const command = forRollback
    ? "autonomos rollback"
    : devCheckout
      ? "git pull && make prod"
      : "autonomos upgrade";
  return (
    <>
      <Header
        title={
          forRollback ? "Restore from a terminal" : "Update from a terminal"
        }
        subtitle={
          devCheckout && !forRollback
            ? "This is a development checkout, so it can't update itself. Run this in the checkout:"
            : "autonomOS isn't running as a background service, so it can't restart itself. Run this on the machine running it:"
        }
      />
      <div
        className="px-4 pb-4 sm:px-5 flex flex-col gap-3"
        data-testid="update-not-supervised"
      >
        <div
          className="flex items-center justify-between gap-3 rounded px-3 py-2 font-mono text-xs"
          style={{ border: `1px solid ${page.border}` }}
        >
          <span data-testid="update-command">{command}</span>
          <Button onClick={() => copy(command)}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {!devCheckout && (
          <div className="text-xs" style={{ color: page.statusFg }}>
            Tip: <span className="font-mono">autonomos install-service</span>{" "}
            makes future updates one click.
          </div>
        )}
      </div>
      <Footer>
        <Button kind="primary" onClick={onDone}>
          Done
        </Button>
      </Footer>
    </>
  );
}

// ── rolled back / failed ────────────────────────────────────────────────

function detailsText(rec: UpgradeStatusRecord): string {
  return [
    `autonomOS update v${rec.from} → v${rec.to}: ${rec.phase}`,
    rec.message ?? "(no message recorded)",
    `started ${rec.startedAt} · last update ${rec.updatedAt}`,
  ].join("\n");
}

function FailedScreen({ flow }: { flow: UpdateFlow }) {
  const page = usePage();
  const a = useAccents();
  const [copied, copy] = useCopy();
  const rec = flow.record;
  if (!rec) return null;
  const rolledBack = rec.phase === "rolled_back";
  const restore = rec.kind === "rollback";
  return (
    <>
      <Header
        icon={
          <span
            className="pt-0.5"
            style={{ color: rolledBack ? a.amber : a.red }}
          >
            <WarnIcon size={20} />
          </span>
        }
        title={
          restore
            ? `Restoring v${rec.to} didn't finish`
            : rolledBack
              ? `v${rec.to} didn't start — you're back on v${rec.from}`
              : `The update to v${rec.to} didn't finish`
        }
        subtitle={
          <span data-testid="update-failed-summary">
            {rolledBack && !restore
              ? rec.snapshotId
                ? `autonomOS restored v${rec.from} and the snapshot from just before, and your agents reopened. Nothing else changed.`
                : `autonomOS restored v${rec.from} on its own and your agents reopened. Nothing else changed.`
              : "autonomOS may be on either version. Run autonomos status on the machine running it."}
          </span>
        }
      />
      <div
        className="px-4 pb-4 sm:px-5 flex flex-col gap-2"
        data-testid="update-failed"
      >
        <div
          className="text-[11px] font-medium uppercase tracking-wide"
          style={{ color: page.statusFg }}
        >
          What happened
        </div>
        <pre
          className="whitespace-pre-wrap rounded px-3 py-2 font-mono text-xs"
          style={{ border: `1px solid ${page.border}` }}
          data-testid="update-failed-message"
        >
          {rec.message ?? "No details were recorded."}
        </pre>
      </div>
      <Footer
        left={
          <Button onClick={() => copy(detailsText(rec))}>
            {copied ? "Copied" : "Copy details"}
          </Button>
        }
      >
        <Button onClick={flow.close}>Close</Button>
        <Button
          kind="primary"
          onClick={restore ? flow.openRestore : flow.review}
        >
          Try again
        </Button>
      </Footer>
    </>
  );
}

// ── 401 after reconnect ─────────────────────────────────────────────────

function AuthRejectedScreen({ flow }: { flow: UpdateFlow }) {
  const a = useAccents();
  return (
    <>
      <Header
        icon={
          <span className="pt-0.5" style={{ color: a.red }}>
            <WarnIcon size={20} />
          </span>
        }
        title="Sign in again"
        subtitle={
          <span data-testid="update-auth-rejected">
            autonomOS restarted but didn't accept this browser's access token.
            Updates keep your token, so this isn't expected — check{" "}
            <span className="font-mono">autonomos status</span> on the machine
            running it.
          </span>
        }
      />
      <Footer>
        <Button onClick={flow.close}>Close</Button>
        <Button kind="primary" onClick={() => window.location.reload()}>
          Reload and sign in
        </Button>
      </Footer>
    </>
  );
}

// ── restore confirmation ────────────────────────────────────────────────

function RestoreConfirmScreen({ flow }: { flow: UpdateFlow }) {
  const page = usePage();
  const a = useAccents();
  const { restore, pending, actionError } = flow;
  if (restore.kind !== "ok") {
    return (
      <>
        <Header title="Restore a previous version" />
        <div className="px-4 pb-4 sm:px-5 flex flex-col gap-3">
          {restore.kind === "loading" ? (
            <div
              className="flex items-center gap-2 text-xs"
              style={{ color: page.statusFg }}
            >
              <Spinner size={12} /> Reading snapshots…
            </div>
          ) : (
            <ErrorLine>
              Couldn't read the snapshots: {restore.message}
            </ErrorLine>
          )}
        </div>
        <Footer>
          <Button onClick={flow.close}>Not now</Button>
        </Footer>
      </>
    );
  }
  const target = restore.data.rollback;
  if (!target) {
    return (
      <>
        <Header
          title="Nothing to restore"
          subtitle="There's no previous version kept on this machine."
        />
        <Footer>
          <Button onClick={flow.close}>Close</Button>
        </Footer>
      </>
    );
  }
  const snap = target.snapshotId
    ? restore.data.snapshots.find((s) => s.id === target.snapshotId)
    : undefined;
  const dt = { color: page.statusFg };
  return (
    <>
      <Header
        title={`Restore v${target.version}?`}
        subtitle={
          target.snapshotId
            ? `Brings back v${target.version} and the snapshot saved just before you updated.`
            : undefined
        }
      />
      <div
        className="px-4 pb-4 sm:px-5 flex flex-col gap-3"
        data-testid="restore-confirm"
      >
        {!target.snapshotId && (
          <div
            data-testid="restore-no-snapshot"
            className="flex gap-3 rounded-md px-3 py-2.5 text-xs"
            style={{ border: `1px solid ${a.amber}88` }}
          >
            <span style={{ color: a.amber }}>
              <WarnIcon />
            </span>
            <span>
              v{target.version} predates snapshots, so only the version is
              restored. Your agents, schedules and settings stay as they are.
            </span>
          </div>
        )}
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[10rem_1fr] sm:gap-y-2">
          {target.snapshotId && (
            <>
              <dt style={dt}>Snapshot</dt>
              <dd data-testid="restore-snapshot">
                {snap
                  ? `${formatSnapshotDate(snap.createdAt)} · ${formatBytes(snap.bytes)}`
                  : target.snapshotId}
              </dd>
              <dt style={dt}>Changes since the update</dt>
              <dd>
                {SNAPSHOT_CONTENTS} changed since then aren't carried over.
                They're saved as a new snapshot first, so updating again brings
                them back.
              </dd>
            </>
          )}
          <dt style={dt}>Not affected</dt>
          <dd>Conversations. Each CLI keeps its own history.</dd>
        </dl>
        <details className="text-xs">
          <summary className="cursor-pointer" style={{ color: a.blue }}>
            Show details
          </summary>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 pt-2 sm:grid-cols-[10rem_1fr]">
            {target.snapshotId && (
              <>
                <dt style={dt}>Location</dt>
                <dd>
                  <span className="font-mono">
                    snapshots/{target.snapshotId}/
                  </span>{" "}
                  in your autonomOS config folder
                </dd>
              </>
            )}
            <dt style={dt}>From a terminal</dt>
            <dd className="font-mono">autonomos rollback</dd>
          </dl>
        </details>
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
      </div>
      <Footer>
        <Button onClick={flow.close}>Not now</Button>
        <Button
          kind="primary"
          disabled={pending}
          onClick={() => void flow.confirmRestore()}
          data-testid="restore-confirm-button"
        >
          Restore v{target.version}
        </Button>
      </Footer>
    </>
  );
}

// ── the switch ──────────────────────────────────────────────────────────

/** What the polite status region says for the current screen. */
function statusText(
  flow: UpdateFlow,
  info: VersionInfo,
  rows: AgentRow[],
): string {
  switch (flow.view) {
    case "confirm": {
      if (!flow.upgrade)
        return flow.checkError
          ? `Couldn't check your agents: ${flow.checkError}`
          : "Checking your agents…";
      const h = agentHeadline(
        rows,
        rows.filter((r) => r.busy),
      );
      return `${h.title} ${h.detail}`;
    }
    case "waiting": {
      const n = flow.upgrade?.busy.length ?? 0;
      return n
        ? `Waiting for ${plural(n, "agent")} to finish.`
        : "Every agent is idle. Starting shortly.";
    }
    case "updating": {
      const rec = flow.record;
      const to = rec?.to ?? info.latest;
      return `${STAGE_NAMES[stageFor(rec?.phase)]}: ${stageDetail(rec?.phase, to, { rollback: rec?.kind === "rollback", message: rec?.message })}`;
    }
    default:
      return "";
  }
}

export function UpdateDialog({
  info,
  flow,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
}) {
  const open = flow.view !== "closed";
  const notes = useReleaseNotes(
    info.latest,
    open && (flow.view === "confirm" || flow.view === "updating"),
  );
  const rows = useAgentRows(flow.upgrade);
  const onClose = useCallback(() => flow.close(), [flow.close]);
  if (!open) return null;
  return (
    <DialogShell
      viewKey={flow.view}
      status={statusText(flow, info, rows)}
      onClose={onClose}
    >
      {flow.view === "confirm" && (
        <ConfirmScreen info={info} flow={flow} notes={notes} />
      )}
      {flow.view === "waiting" && <WaitingScreen info={info} flow={flow} />}
      {flow.view === "notSupervised" && (
        <NotSupervisedScreen
          info={info}
          forRollback={flow.terminalFor === "rollback"}
          onDone={flow.close}
        />
      )}
      {flow.view === "updating" && (
        <UpdatingScreen info={info} flow={flow} notes={notes} />
      )}
      {flow.view === "failed" && <FailedScreen flow={flow} />}
      {flow.view === "authRejected" && <AuthRejectedScreen flow={flow} />}
      {flow.view === "restoreConfirm" && <RestoreConfirmScreen flow={flow} />}
    </DialogShell>
  );
}

// ── full-screen reconnecting overlay ────────────────────────────────────

/** Up from the moment the daemon goes down until the page reloads — through
 *  the new version's health check, so "Restarting" never flashes away and
 *  leaves a spinner behind it. */
export function ReconnectingOverlay({
  to,
  phase,
  rollback,
  elapsedMs,
  gaveUp,
}: {
  to: string;
  phase?: UpgradePhase;
  rollback?: boolean;
  elapsedMs: number;
  gaveUp: boolean;
}) {
  const page = usePage();
  const a = useAccents();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement;
    const release = holdAppInert();
    ref.current?.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      release();
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);
  const stage: Stage = phase === "done" ? 2 : 1;
  const detail = stageDetail(phase ?? "restarting", to, { rollback });
  return createPortal(
    <div
      ref={ref}
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto p-4 font-sans"
      style={{ background: `${page.bg}f2`, color: page.fg }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-reconnect-title"
      data-testid="update-reconnecting"
      onKeyDown={(e) => trapTab(e, ref.current)}
    >
      <div className="flex w-[560px] max-w-full flex-col gap-4">
        <h2
          id="update-reconnect-title"
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {rollback ? `Restoring v${to}` : `Restarting autonomOS on v${to}`}
        </h2>
        <Stages
          stage={stage}
          detail={detail}
          hints={stageHints(rollback ? "rollback" : null)}
        />
        <output aria-live="polite" className="sr-only">
          {`${STAGE_NAMES[stage]}: ${detail}`}
        </output>
        <div
          className="font-mono text-xs"
          style={{ color: page.statusFg }}
          aria-hidden="true"
        >
          Reconnecting… {Math.floor(elapsedMs / 1000)}s
        </div>
        {gaveUp ? (
          <div
            role="alert"
            className="text-xs"
            style={{ color: a.amber }}
            data-testid="update-gave-up"
          >
            autonomOS hasn't come back. On the machine running it, run{" "}
            <span className="font-mono">autonomos status</span>.
          </div>
        ) : (
          <div className="text-xs" style={{ color: page.statusFg }}>
            You'll stay signed in. This page reloads when autonomOS is back.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
