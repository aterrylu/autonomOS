/**
 * The in-app update modal (ADR-105) — every screen of the flow except the
 * status-bar pill and the full-screen Reconnecting overlay. Presentational:
 * all state and server calls live in useUpdateFlow; the one exception is the
 * What's-new screen, which fetches the release notes it renders.
 *
 * Rendered through a portal to <body> so it stacks above the status bar's
 * own stacking context.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ReleaseNote,
  type SystemReleases,
  systemApi,
  type UpgradeState,
  type UpgradeStatusRecord,
} from "../../api/system";
import { isLightBg } from "../../components/recency";
import { statusLabelStyle } from "../../components/statusLabelStyle";
import {
  type AgentStatus,
  agentStatusLabel,
} from "../../components/ui/agent-status-icon";
import { pushEscapeCloser } from "../../shortcuts/escapeStack";
import { THEMES, useStore } from "../../store";
import { ReleaseMarkdown } from "./releaseMarkdown";
import {
  activeStepIndex,
  breakingReleases,
  consequenceFor,
  formatBytes,
  formatReleaseDate,
  formatSnapshotDate,
  joinNames,
  sortNewestFirst,
  stepsFor,
} from "./updateFlow";
import type { UpdateFlow } from "./useUpdateFlow";

export const GREEN = "#16825d";
export const AMBER = "#e6b450";
export const RED = "#ea6c73";
export const BLUE = "#58a6ff";

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
  const style =
    kind === "primary"
      ? { background: GREEN, color: "#fff", border: `1px solid ${GREEN}` }
      : kind === "danger"
        ? { background: RED, color: "#fff", border: `1px solid ${RED}` }
        : {
            background: "transparent",
            color: page.fg,
            border: `1px solid ${page.border}`,
          };
  return (
    <button
      type="button"
      className="rounded px-3 py-1.5 text-xs font-medium cursor-pointer hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
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
      className="animate-spin"
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
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function InfoIcon({ size = 18 }: { size?: number }) {
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

function WarnIcon({ size = 18 }: { size?: number }) {
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

const STEP_NAMES = ["What's new", "Check agents", "Update"] as const;

/** The 1 · 2 · 3 progress header shared by the three main screens. */
function Stepper({ current }: { current: 0 | 1 | 2 }) {
  const page = usePage();
  return (
    <ol className="flex items-center gap-2 text-[11px]" aria-label="Progress">
      {STEP_NAMES.map((name, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={name} className="flex items-center gap-2">
            {i > 0 && (
              <span
                aria-hidden="true"
                style={{ width: 22, height: 1, background: page.border }}
              />
            )}
            <span
              className="inline-flex items-center justify-center rounded-full font-semibold"
              style={{
                width: 18,
                height: 18,
                background: done || active ? GREEN : page.border,
                color: done || active ? "#fff" : page.statusFg,
              }}
            >
              {done ? <CheckIcon size={11} /> : i + 1}
            </span>
            <span
              aria-current={active ? "step" : undefined}
              style={{
                color: done ? GREEN : active ? page.fg : page.statusFg,
              }}
            >
              {name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Header({
  step,
  title,
  subtitle,
}: {
  step?: 0 | 1 | 2;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  const page = usePage();
  return (
    <div
      className="flex flex-col gap-3 px-5 pt-4 pb-3"
      style={{ borderBottom: `1px solid ${page.border}` }}
    >
      {step !== undefined && <Stepper current={step} />}
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && (
          <div className="text-xs" style={{ color: page.statusFg }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

function Footer({ left, children }: { left?: ReactNode; children: ReactNode }) {
  const page = usePage();
  return (
    <div
      className="flex items-center justify-between gap-3 px-5 py-3"
      style={{ borderTop: `1px solid ${page.border}` }}
    >
      <div className="min-w-0 text-xs" style={{ color: page.statusFg }}>
        {left}
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded px-2 py-1.5 text-xs"
      style={{ background: `${RED}18`, color: RED }}
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
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const page = usePage();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);

  // Escape rides the registry's ui.dismiss entry (ADR-065).
  useEffect(() => pushEscapeCloser(onClose), [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; keyboard close is the registry's ui.dismiss (Escape via the escape stack)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is the registry's ui.dismiss (Escape via the escape stack)
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[6vh] font-sans"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid="update-dialog"
        className="flex w-[640px] max-w-[92vw] max-h-[86vh] flex-col overflow-hidden rounded-lg shadow-xl outline-none"
        style={{
          background: page.bg,
          color: page.fg,
          border: `1px solid ${page.border}`,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── screen 1: what's new ────────────────────────────────────────────────

type NotesState =
  | { kind: "loading" }
  | { kind: "ok"; data: SystemReleases; releases: ReleaseNote[] }
  | { kind: "unavailable" };

function NotesScreen({
  info,
  notice,
  onLater,
  onContinue,
}: {
  info: VersionInfo;
  /** Why we're back here (e.g. a newer release appeared mid-flow). */
  notice?: string | null;
  onLater: () => void;
  onContinue: () => void;
}) {
  const page = usePage();
  const [notes, setNotes] = useState<NotesState>({ kind: "loading" });

  // Refetch when the target moves (VERSION_CHANGED → new `latest`).
  useEffect(() => {
    void info.latest;
    const ctrl = new AbortController();
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
  }, [info.latest]);

  const releases = notes.kind === "ok" ? notes.releases : [];
  const breaking = breakingReleases(releases);
  // Structured server flag (a body marker) — never prose-sniffed here.
  const storageChange = releases.filter((r) => r.storageFormatChange === true);
  const newestDate = releases[0]
    ? formatReleaseDate(releases[0].publishedAt)
    : null;
  const releaseUrl =
    (notes.kind === "ok" ? notes.data.releaseUrl : null) ?? info.releaseUrl;

  return (
    <>
      <Header
        step={0}
        title={`What's new in v${info.latest}`}
        subtitle={[
          `You're on v${info.version}`,
          newestDate && `released ${newestDate}`,
          releases.length > 1 && `${releases.length} releases`,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        {notes.kind === "loading" && (
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: page.statusFg }}
          >
            <Spinner size={12} /> Loading release notes…
          </div>
        )}
        {notice && <ErrorLine>{notice}</ErrorLine>}
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
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: BLUE }}
                >
                  view on GitHub
                </a>
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
        {storageChange.length > 0 && (
          <div
            data-testid="storage-format-callout"
            className="flex gap-3 rounded-md px-3 py-2.5"
            style={{
              background: `${BLUE}14`,
              border: `1px solid ${BLUE}55`,
              color: BLUE,
            }}
          >
            <InfoIcon />
            <div className="flex flex-col gap-0.5">
              <div className="text-xs font-semibold">
                This update changes how agents are stored
              </div>
              <div className="text-xs" style={{ color: page.fg }}>
                Older versions can't read the new format. Going back restores
                your pre-update snapshot, so changes made after updating won't
                carry back.
              </div>
            </div>
          </div>
        )}
        {breaking.length > 0 && (
          <div
            data-testid="breaking-callout"
            className="flex gap-3 rounded-md px-3 py-2.5"
            style={{
              background: `${AMBER}14`,
              border: `1px solid ${AMBER}55`,
              color: AMBER,
            }}
          >
            <WarnIcon />
            <div className="flex flex-col gap-0.5">
              <div className="text-xs font-semibold">
                {breaking.length === 1
                  ? `v${breaking[0].version} has a breaking change`
                  : `Breaking changes in ${joinNames(breaking.map((r) => `v${r.version}`))}`}
              </div>
              <div className="text-xs" style={{ color: page.fg }}>
                Look for “Breaking change” in the notes below before updating.
              </div>
            </div>
          </div>
        )}
        {releases.map((r) => {
          const date = formatReleaseDate(r.publishedAt);
          const showName =
            r.name && r.name !== r.version && r.name !== `v${r.version}`;
          return (
            <section
              key={r.version}
              data-testid="release-section"
              data-version={r.version}
              className="flex flex-col gap-1.5"
            >
              <div
                className="flex items-baseline gap-2 pb-1"
                style={{ borderBottom: `1px solid ${page.border}` }}
              >
                <h3 className="text-sm font-semibold">v{r.version}</h3>
                {showName && <span className="truncate text-xs">{r.name}</span>}
                {date && (
                  <span
                    className="ml-auto shrink-0 text-[11px]"
                    style={{ color: page.statusFg }}
                  >
                    {date}
                  </span>
                )}
              </div>
              <ReleaseMarkdown body={r.body ?? ""} />
            </section>
          );
        })}
      </div>
      <Footer
        left={
          releaseUrl && (
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: BLUE }}
              data-testid="update-github-link"
            >
              Full notes on GitHub
            </a>
          )
        }
      >
        <Button onClick={onLater}>Later</Button>
        {/* Never gated on the notes loading — notes are a courtesy. */}
        <Button kind="primary" onClick={onContinue}>
          Continue
        </Button>
      </Footer>
    </>
  );
}

// ── screen 2: check agents ──────────────────────────────────────────────

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

function AgentList({ rows }: { rows: AgentRow[] }) {
  const page = usePage();
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
            className="flex items-center gap-3 px-3 py-2 text-xs"
            style={{
              borderTop: i === 0 ? undefined : `1px solid ${page.border}`,
              background: r.busy ? `${color}10` : undefined,
            }}
          >
            <span
              aria-hidden="true"
              className="rounded-full shrink-0"
              style={{ width: 7, height: 7, background: color }}
            />
            <span className="w-32 shrink-0 truncate font-medium">{r.name}</span>
            <span className="w-24 shrink-0" style={{ color }}>
              {r.reason === "first_task"
                ? "Starting"
                : agentStatusLabel(r.status as AgentStatus) || "Unknown"}
            </span>
            <span
              className="min-w-0 flex flex-col"
              style={{ color: page.statusFg }}
            >
              <span>
                {r.reason === "first_task"
                  ? "Its first task hasn't started yet — it would be lost"
                  : consequenceFor(r.status, r.provider)}
              </span>
              {r.background && r.background.length > 0 && (
                <span
                  style={{ color: AMBER }}
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

function Radio({
  checked,
  onSelect,
  title,
  badge,
  children,
  testId,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  children: ReactNode;
  testId: string;
}) {
  const page = usePage();
  return (
    <label
      className="flex cursor-pointer gap-3 rounded-md px-3 py-2.5"
      style={{
        border: `1px solid ${checked ? GREEN : page.border}`,
        background: checked ? `${GREEN}14` : "transparent",
      }}
    >
      <input
        type="radio"
        name="update-when"
        checked={checked}
        onChange={onSelect}
        className="sr-only"
        data-testid={testId}
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-full"
        style={{
          width: 14,
          height: 14,
          border: `2px solid ${checked ? GREEN : page.statusFg}`,
        }}
      >
        {checked && (
          <span
            className="rounded-full"
            style={{ width: 6, height: 6, background: GREEN }}
          />
        )}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-xs font-semibold">{title}</span>
          {badge && (
            <span
              className="rounded px-1.5 text-[10px]"
              style={{ color: GREEN, border: `1px solid ${GREEN}66` }}
            >
              {badge}
            </span>
          )}
        </span>
        <span
          className="text-xs leading-relaxed"
          style={{ color: page.statusFg }}
        >
          {children}
        </span>
      </span>
    </label>
  );
}

/** "1 background process will be stopped: npm run dev". */
function backgroundLine(procs: { command: string }[]): string {
  const n = procs.length;
  return `${n} background process${n === 1 ? "" : "es"} will be stopped: ${procs
    .map((p) => p.command)
    .join(" · ")}`;
}

/** Warn-only: agents that read idle but left work running in a background
 *  shell, which the restart stops. Never blocks the update. */
function BackgroundWarning({ rows }: { rows: AgentRow[] }) {
  const withBg = rows.filter((r) => r.background && r.background.length > 0);
  if (withBg.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-3 py-2 text-xs"
      style={{ border: `1px solid ${AMBER}55`, background: `${AMBER}12` }}
      data-testid="update-background-warning"
    >
      {withBg.map((r) => (
        <div key={r.id}>
          <span className="font-semibold" style={{ color: AMBER }}>
            {r.name}:
          </span>{" "}
          {backgroundLine(r.background ?? [])}.
        </div>
      ))}
      <div>
        The update restarts it — start it again after if you still need it.
      </div>
    </div>
  );
}

/** "Interrupts a and b mid-task and dismisses c's question." */
function interruptSummary(rows: AgentRow[]): string {
  const busy = rows.filter((r) => r.busy);
  const asking = busy
    .filter((r) => r.status === "needs_input")
    .map((r) => r.name);
  const starting = busy
    .filter((r) => r.reason === "first_task")
    .map((r) => r.name);
  const working = busy
    .filter((r) => r.status !== "needs_input" && r.reason !== "first_task")
    .map((r) => r.name);
  const parts: string[] = [];
  if (working.length) parts.push(`Interrupts ${joinNames(working)} mid-task`);
  if (asking.length) {
    const who =
      asking.length === 1
        ? `${asking[0]}'s question`
        : `the questions from ${joinNames(asking)}`;
    parts.push(`${working.length ? "dismisses" : "Dismisses"} ${who}`);
  }
  if (starting.length) {
    const whose =
      starting.length === 1
        ? `${starting[0]}'s first task`
        : `the first tasks of ${joinNames(starting)}`;
    parts.push(`${parts.length ? "loses" : "Loses"} ${whose}`);
  }
  return `${parts.join(" and ")}. Files they already wrote stay on disk.`;
}

function takesAbout(mode: VersionInfo["installMode"]): string {
  if (mode === "bundle") return "30–60 seconds";
  if (mode === "source") return "1–3 minutes (rebuilds from source)";
  return "30–60 seconds (installed bundle) · 1–3 minutes (source install: rebuilds)";
}

function CheckScreen({ info, flow }: { info: VersionInfo; flow: UpdateFlow }) {
  const page = usePage();
  const { upgrade, checkError, actionError, pending } = flow;
  const rows = useAgentRows(upgrade);
  const busyCount = upgrade?.busy.length ?? 0;
  const [when, setWhen] = useState<"idle" | "now">("idle");

  if (!upgrade) {
    return (
      <>
        <Header step={1} title="Checking agents…" />
        <div className="px-5 py-4 flex flex-col gap-3">
          {checkError ? (
            <ErrorLine>
              Couldn't read the fleet's status: {checkError}
            </ErrorLine>
          ) : (
            <div
              className="flex items-center gap-2 text-xs"
              style={{ color: page.statusFg }}
            >
              <Spinner size={12} /> Reading each agent's status…
            </div>
          )}
        </div>
        <Footer>
          <Button onClick={flow.close}>Cancel</Button>
          {checkError && <Button onClick={flow.retryCheck}>Retry</Button>}
        </Footer>
      </>
    );
  }

  if (busyCount === 0) {
    const n = rows.length;
    return (
      <>
        <Header
          step={1}
          title={
            <span className="flex items-center gap-2">
              <span style={{ color: GREEN }}>
                <CheckIcon size={16} />
              </span>
              {n === 0
                ? "No agents are running"
                : `All ${n} agent${n === 1 ? " is" : "s are"} idle`}
            </span>
          }
          subtitle={
            n === 0
              ? "Safe to update."
              : "Safe to update. They'll close briefly and reopen on their conversations."
          }
        />
        <div
          className="px-5 py-4 flex flex-col gap-3"
          data-testid="update-check-clear"
        >
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-xs">
            <dt style={{ color: page.statusFg }}>Takes about</dt>
            <dd>{takesAbout(upgrade.installMode ?? info.installMode)}</dd>
            <dt style={{ color: page.statusFg }}>You stay signed in</dt>
            <dd>Your access token doesn't change</dd>
            <dt style={{ color: page.statusFg }}>Snapshot first</dt>
            <dd>
              Your agents' setup is saved before anything changes — restore it
              any time from Settings → Updates
            </dd>
            <dt style={{ color: page.statusFg }}>If it goes wrong</dt>
            <dd>
              autonomOS rolls itself back to v{info.version} — code and snapshot
              together
            </dd>
          </dl>
          <BackgroundWarning rows={rows} />
          {actionError && <ErrorLine>{actionError}</ErrorLine>}
        </div>
        <Footer>
          <Button onClick={flow.open}>Back</Button>
          <Button
            kind="primary"
            disabled={pending}
            onClick={() => void flow.start("now", info.latest)}
            data-testid="update-start"
          >
            Update to v{info.latest}
          </Button>
        </Footer>
      </>
    );
  }

  const idleSecs = Math.round((upgrade.idleWindowMs || 30_000) / 1000);
  return (
    <>
      <Header
        step={1}
        title={`${busyCount} agent${busyCount === 1 ? " is" : "s are"} mid-task`}
        subtitle="Updating restarts autonomOS. Every agent's terminal closes and reopens on its saved conversation. A snapshot of your agents' setup is saved before anything changes."
      />
      <div
        className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3"
        data-testid="update-check-busy"
      >
        <AgentList rows={rows} />
        <div
          className="flex flex-col gap-2"
          role="radiogroup"
          aria-label="When to update"
        >
          <Radio
            checked={when === "idle"}
            onSelect={() => setWhen("idle")}
            title="Update when they're idle"
            badge="Recommended"
            testId="update-when-idle"
          >
            We wait until every agent has been idle for {idleSecs} seconds, then
            update automatically. Keep working — a new turn just pushes it back.
          </Radio>
          <Radio
            checked={when === "now"}
            onSelect={() => setWhen("now")}
            title="Update now"
            testId="update-when-now"
          >
            {interruptSummary(rows)}
          </Radio>
        </div>
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
      </div>
      <Footer left="Status is read live from each agent.">
        <Button onClick={flow.close}>Cancel</Button>
        <Button
          kind={when === "now" ? "danger" : "primary"}
          disabled={pending}
          onClick={() => void flow.start(when, info.latest)}
          data-testid="update-start"
        >
          {when === "idle" ? "Wait, then update" : "Update now"}
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
            : "This autonomOS isn't running as a background service, so it can't restart itself. Run this on the machine it's running on:"
        }
      />
      <div
        className="px-5 py-4 flex flex-col gap-3"
        data-testid="update-not-supervised"
      >
        <div
          className="flex items-center justify-between gap-3 rounded px-3 py-2 font-mono text-xs"
          style={{ background: page.border }}
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

// ── updating ────────────────────────────────────────────────────────────

function UpdatingScreen({
  info,
  flow,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
}) {
  const page = usePage();
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
  // snapshot AFTER the build — that must not walk the list backwards.
  const furthest = useRef<{ run: string | undefined; i: number }>({
    run: undefined,
    i: 0,
  });
  const computed = activeStepIndex(steps, rec?.phase, !!rec?.verification);
  if (furthest.current.run !== rec?.startedAt) {
    furthest.current = { run: rec?.startedAt, i: computed };
  } else if (computed > furthest.current.i) {
    furthest.current.i = computed;
  }
  const active = furthest.current.i;
  return (
    <>
      <Header
        step={rollback ? undefined : 2}
        title={rollback ? `Restoring v${to}` : `Updating to v${to}`}
        subtitle="Runs on the server — closing this tab won't stop it."
      />
      <ol className="px-5 py-4 flex flex-col gap-3" data-testid="update-steps">
        {steps.map((s, i) => {
          const state =
            i < active ? "done" : i === active ? "active" : "pending";
          return (
            <li
              key={s.id}
              data-step={s.id}
              data-state={state}
              className="flex items-start gap-3 text-xs"
            >
              <span
                className="mt-px flex shrink-0 items-center justify-center rounded-full"
                style={{
                  width: 16,
                  height: 16,
                  color:
                    state === "done"
                      ? GREEN
                      : state === "active"
                        ? BLUE
                        : page.statusFg,
                  border:
                    state === "pending"
                      ? `1.5px solid ${page.border}`
                      : undefined,
                }}
              >
                {state === "done" ? (
                  <CheckIcon size={14} />
                ) : state === "active" ? (
                  <Spinner size={14} />
                ) : null}
              </span>
              <span className="flex flex-col gap-0.5">
                <span
                  className={state === "active" ? "font-semibold" : undefined}
                  style={{
                    color: state === "pending" ? page.statusFg : page.fg,
                  }}
                >
                  {s.label}
                </span>
                {s.detail && (
                  <span style={{ color: page.statusFg }}>{s.detail}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {rec?.message && (
        <div className="px-5 pb-3 text-xs" style={{ color: page.statusFg }}>
          {rec.message}
        </div>
      )}
      <Footer>
        <Button onClick={flow.close}>Hide</Button>
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
  const [copied, copy] = useCopy();
  const rec = flow.record;
  if (!rec) return null;
  const rolledBack = rec.phase === "rolled_back";
  const restore = rec.kind === "rollback";
  return (
    <>
      <div
        className="flex gap-3 px-5 pt-4 pb-3"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span style={{ color: rolledBack ? AMBER : RED }}>
          <WarnIcon size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">
            {restore
              ? `Restoring v${rec.to} didn't finish`
              : rolledBack
                ? `v${rec.to} didn't start — you're back on v${rec.from}`
                : `The update to v${rec.to} failed`}
          </h2>
          <div
            className="text-xs"
            style={{ color: page.statusFg }}
            data-testid="update-failed-summary"
          >
            {restore
              ? "See what happened below. Run autonomos status on the host to see which version is running."
              : rolledBack
                ? rec.snapshotId
                  ? "autonomOS restored the previous version and your agents' setup from the snapshot taken just before, and your agents reopened. Nothing else changed."
                  : "autonomOS restored the previous version automatically and your agents reopened. Nothing else changed."
                : "The update didn't finish. See what happened below, and run autonomos status on the host to see which version is running."}
          </div>
        </div>
      </div>
      <div
        className="px-5 py-4 flex flex-col gap-2"
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
          style={{ background: page.border }}
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
          onClick={restore ? flow.openRestore : flow.goCheck}
        >
          Try again
        </Button>
      </Footer>
    </>
  );
}

// ── 401 after reconnect ─────────────────────────────────────────────────

function AuthRejectedScreen({ flow }: { flow: UpdateFlow }) {
  const page = usePage();
  return (
    <>
      <div
        className="flex gap-3 px-5 pt-4 pb-3"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span style={{ color: RED }}>
          <WarnIcon size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">
            Your session token was rejected after the update
          </h2>
          <div
            className="text-xs"
            style={{ color: page.statusFg }}
            data-testid="update-auth-rejected"
          >
            autonomOS is answering again, but it no longer accepts this
            browser's sign-in. Updates are meant to keep your access token, so
            this is unexpected — check{" "}
            <span className="font-mono">autonomos status</span> on the host.
            Reloading will ask you to sign in again.
          </div>
        </div>
      </div>
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
  const { restore, pending, actionError } = flow;
  if (restore.kind !== "ok") {
    return (
      <>
        <Header title="Restore previous version" />
        <div className="px-5 py-4 flex flex-col gap-3">
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
          <Button onClick={flow.close}>Cancel</Button>
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
        title={`Restore v${target.version} and your agents' setup?`}
        subtitle={
          target.snapshotId
            ? "Puts back the version you had and the snapshot taken just before updating, together — old code never runs on newer records."
            : undefined
        }
      />
      <div
        className="px-5 py-4 flex flex-col gap-3"
        data-testid="restore-confirm"
      >
        {!target.snapshotId && (
          <div
            data-testid="restore-no-snapshot"
            className="flex gap-3 rounded-md px-3 py-2.5 text-xs"
            style={{
              background: `${AMBER}14`,
              border: `1px solid ${AMBER}55`,
              color: page.fg,
            }}
          >
            <span style={{ color: AMBER }}>
              <WarnIcon size={16} />
            </span>
            <span>
              No snapshot pairs with v{target.version} (it was installed before
              snapshots existed) — only the code is restored; agent records stay
              as they are.
            </span>
          </div>
        )}
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-xs">
          {target.snapshotId && (
            <>
              <dt style={dt}>Snapshot</dt>
              <dd data-testid="restore-snapshot">
                {snap
                  ? `${formatSnapshotDate(snap.createdAt)} · ${formatBytes(snap.bytes)}`
                  : target.snapshotId}
              </dd>
              <dt style={dt}>Location</dt>
              <dd>
                <span className="font-mono">
                  snapshots/{target.snapshotId}/
                </span>{" "}
                in your autonomOS config folder
              </dd>
              <dt style={dt}>Won't carry back</dt>
              <dd>
                Changes made since the update — agents, schedules, presets,
                settings. They aren't lost: today's setup is saved as its own
                snapshot first, and rolling forward again restores it.
              </dd>
            </>
          )}
          <dt style={dt}>Never touched</dt>
          <dd>
            Conversations themselves (Claude Code, Codex and Gemini keep their
            own history)
          </dd>
          <dt style={dt}>From a terminal</dt>
          <dd className="font-mono">autonomos rollback</dd>
        </dl>
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
      </div>
      <Footer>
        <Button onClick={flow.close}>Cancel</Button>
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

const LABELS: Record<Exclude<UpdateFlow["view"], "closed">, string> = {
  notes: "What's new",
  check: "Check agents",
  notSupervised: "Update from a terminal",
  updating: "Updating autonomOS",
  failed: "Update failed",
  authRejected: "Session rejected",
  restoreConfirm: "Restore previous version",
};

export function UpdateDialog({
  info,
  flow,
}: {
  info: VersionInfo;
  flow: UpdateFlow;
}) {
  if (flow.view === "closed") return null;
  return (
    <DialogShell label={LABELS[flow.view]} onClose={flow.close}>
      {flow.view === "notes" && (
        <NotesScreen
          info={info}
          notice={flow.actionError}
          onLater={flow.close}
          onContinue={flow.goCheck}
        />
      )}
      {flow.view === "check" && <CheckScreen info={info} flow={flow} />}
      {flow.view === "notSupervised" && (
        <NotSupervisedScreen
          info={info}
          forRollback={flow.terminalFor === "rollback"}
          onDone={flow.close}
        />
      )}
      {flow.view === "updating" && <UpdatingScreen info={info} flow={flow} />}
      {flow.view === "failed" && <FailedScreen flow={flow} />}
      {flow.view === "authRejected" && <AuthRejectedScreen flow={flow} />}
      {flow.view === "restoreConfirm" && <RestoreConfirmScreen flow={flow} />}
    </DialogShell>
  );
}

// ── full-screen reconnecting overlay ────────────────────────────────────

export function ReconnectingOverlay({
  to,
  elapsedMs,
  gaveUp,
}: {
  to: string;
  elapsedMs: number;
  gaveUp: boolean;
}) {
  const page = usePage();
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center font-sans"
      style={{ background: `${page.bg}f2`, color: page.fg }}
      role="alertdialog"
      aria-modal="true"
      aria-label="Reconnecting"
      data-testid="update-reconnecting"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <span style={{ color: BLUE }}>
          <Spinner size={28} />
        </span>
        <div className="text-base font-semibold">
          autonomOS is restarting on v{to}
        </div>
        <div className="font-mono text-xs" style={{ color: page.statusFg }}>
          Reconnecting… {Math.floor(elapsedMs / 1000)}s
        </div>
        {gaveUp ? (
          <div
            className="text-xs"
            style={{ color: AMBER }}
            data-testid="update-gave-up"
          >
            autonomOS isn't responding. On the host, run{" "}
            <span className="font-mono">autonomos status</span>.
          </div>
        ) : (
          <div className="text-xs" style={{ color: page.statusFg }}>
            You'll stay signed in. This page reloads itself when the new version
            answers.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
