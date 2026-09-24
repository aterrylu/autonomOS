/**
 * The one-time post-update banner (ADR-103), shown under the header on the
 * first load after an in-app update (or Restore) completed. The flow writes a
 * sessionStorage flag right before its reload; this reads AND clears it on
 * mount, so a later manual reload doesn't re-announce anything.
 *
 * After an UPGRADE the new daemon checks every agent against the pre-update
 * snapshot and writes `verification` onto the status record ~20s after
 * "done". The banner polls for it (bounded) and reports:
 *   - no problems → green "All N agents verified"
 *   - problems    → AMBER "K agents need attention" with [Details] and
 *                   [Restore previous version]. Restore is ALWAYS the
 *                   operator's click — never automatic.
 */

import { useEffect, useState } from "react";
import { systemApi, type UpgradeStatusRecord } from "../../api/system";
import { THEMES, useStore } from "../../store";
import { AMBER, GREEN } from "./UpdateDialog";
import { useUpdateBus } from "./updateBus";
import {
  joinNames,
  readUpdateAck,
  resurfacedFlag,
  takeUpdatedFlag,
  type UpdatedFlag,
  writeUpdateAck,
} from "./updateFlow";

/** Mutable so tests can shrink the waits. */
export const verifyTiming = {
  pollMs: 3_000,
  /** The daemon writes verification ~20s after done; give it room. */
  maxWaitMs: 60_000,
};

type Verify =
  | { kind: "none" } // nothing to wait for (rollback, or no snapshot taken)
  | { kind: "waiting" }
  | { kind: "timeout" }
  | { kind: "done"; record: UpgradeStatusRecord };

function useVerification(flag: UpdatedFlag | null): Verify {
  const [v, setV] = useState<Verify>(() =>
    flag && flag.kind !== "rollback" ? { kind: "waiting" } : { kind: "none" },
  );
  // A flag can arrive after mount (the durable resurface path below), so
  // start waiting then too; the poll resolves it on its first tick.
  const hasUpgradeFlag = flag !== null && flag.kind !== "rollback";
  useEffect(() => {
    if (hasUpgradeFlag)
      setV((cur) => (cur.kind === "none" ? { kind: "waiting" } : cur));
  }, [hasUpgradeFlag]);
  const waiting = v.kind === "waiting";
  const to = flag?.updatedTo;

  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + verifyTiming.maxWaitMs;
    const tick = async () => {
      try {
        const s = await systemApi.upgradeState({
          signal: AbortSignal.timeout(5_000),
        });
        if (!alive) return;
        const rec = s.status;
        if (rec && rec.to === to) {
          if (rec.verification) {
            setV({ kind: "done", record: rec });
            return;
          }
          // No snapshot → the daemon never runs the check; don't wait.
          if (!rec.snapshotId) {
            setV({ kind: "none" });
            return;
          }
        }
      } catch {
        // Transient — keep polling until the deadline.
      }
      if (!alive) return;
      if (Date.now() >= deadline) setV({ kind: "timeout" });
      else timer = setTimeout(tick, verifyTiming.pollMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [waiting, to]);

  return v;
}

function Icon({ path, color }: { path: string; color: string }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d={path} />
    </svg>
  );
}

const CHECK = "M5 12.5l4.5 4.5L19 7.5";
const WARN = "M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5v.5";

export function UpdatedBanner() {
  const [flag, setFlag] = useState<UpdatedFlag | null>(takeUpdatedFlag);
  const [showDetails, setShowDetails] = useState(false);
  const verify = useVerification(flag);
  const agentCount = useStore((s) => s.sessions.length);
  const theme = useStore((s) => s.theme);
  const requestRestore = useUpdateBus((s) => s.requestRestore);
  const page = THEMES[theme].page;

  // No flag from this tab's own update → ask the server whether an update
  // with unacknowledged verification problems is what's running now.
  const [hadSessionFlag] = useState(() => flag !== null);
  useEffect(() => {
    if (hadSessionFlag) return;
    let alive = true;
    systemApi
      .upgradeState({ signal: AbortSignal.timeout(5_000) })
      .then((s) => {
        const f = resurfacedFlag(s, readUpdateAck());
        if (alive && f) setFlag(f);
      })
      .catch(() => {
        // Best effort: the next load asks again.
      });
    return () => {
      alive = false;
    };
  }, [hadSessionFlag]);

  if (!flag) return null;

  const names = flag.interruptedNames;
  const interruptedClause =
    names.length > 0 &&
    `${joinNames(names)} ${names.length === 1 ? "was" : "were"} interrupted mid-task`;

  const problems =
    verify.kind === "done" ? (verify.record.verification?.problems ?? []) : [];
  // A check that never reported back is not an "all good" either.
  const attention = problems.length > 0 || verify.kind === "timeout";
  const tone = attention ? AMBER : GREEN;

  let headline: string;
  let details: (string | false)[] = [];
  if (flag.kind === "rollback") {
    headline =
      flag.withSnapshot === true
        ? `Restored v${flag.updatedTo} and your agents' setup.`
        : flag.withSnapshot === false
          ? `Restored v${flag.updatedTo}.`
          : (flag.message ?? `Restored v${flag.updatedTo}.`);
    if (flag.withSnapshot === false) {
      details = ["Agent records were left as they are."];
    }
  } else if (problems.length > 0) {
    const k = problems.length;
    headline = `Updated to v${flag.updatedTo} — ${k} agent${k === 1 ? " needs" : "s need"} attention.`;
    details = [
      `${joinNames(problems.map((p) => p.name))} couldn't be verified`,
      interruptedClause,
    ];
  } else {
    headline = `Updated to v${flag.updatedTo}.`;
    const checked =
      verify.kind === "done" ? (verify.record.verification?.checked ?? 0) : 0;
    details = [
      verify.kind === "waiting" && "Verifying agents…",
      verify.kind === "done" &&
        checked > 0 &&
        `All ${checked} agent${checked === 1 ? "" : "s"} verified`,
      verify.kind === "timeout" &&
        "The agent check didn't report back — run autonomos status on the host",
      (verify.kind === "none" || (verify.kind === "done" && checked === 0)) &&
        agentCount > 0 &&
        `${agentCount} agent${agentCount === 1 ? "" : "s"} reopened`,
      interruptedClause,
    ];
  }
  const detailText = details.filter(Boolean).join(" · ");

  return (
    <div
      className="shrink-0 text-xs"
      style={{
        background: `${tone}22`,
        borderBottom: `1px solid ${tone}55`,
        color: page.fg,
      }}
      data-testid="updated-banner"
      data-tone={attention ? "attention" : "ok"}
    >
      <output className="flex min-h-8 items-center justify-between gap-3 px-4 py-1.5">
        <span className="flex items-center gap-2">
          <Icon path={attention ? WARN : CHECK} color={tone} />
          <span>
            <span className="font-semibold">{headline}</span>
            {detailText && ` ${detailText}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {problems.length > 0 && (
            <>
              <button
                type="button"
                className="cursor-pointer underline"
                style={{ color: page.fg }}
                aria-expanded={showDetails}
                onClick={() => setShowDetails((d) => !d)}
              >
                Details
              </button>
              <button
                type="button"
                className="cursor-pointer underline"
                style={{ color: page.fg }}
                onClick={requestRestore}
                data-testid="banner-restore"
              >
                Restore previous version
              </button>
            </>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="cursor-pointer px-1 text-base leading-none hover:brightness-125"
            style={{ color: page.statusFg }}
            onClick={() => {
              // Dismissing a problem report acknowledges it for this browser;
              // otherwise it resurfaces on every load while that update runs.
              if (verify.kind === "done" && problems.length > 0) {
                writeUpdateAck(verify.record.startedAt);
              }
              setFlag(null);
            }}
          >
            ×
          </button>
        </span>
      </output>
      {showDetails && verify.kind === "done" && (
        <div
          className="flex flex-col gap-1.5 px-4 pb-3"
          data-testid="updated-banner-details"
        >
          <div style={{ color: page.statusFg }}>
            Each agent that was resumable before the update, checked on v
            {flag.updatedTo}: {verify.record.verification?.checked ?? 0}{" "}
            checked, {problems.length} with a problem.
          </div>
          <ul className="flex flex-col gap-1">
            {problems.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2"
                data-testid="updated-banner-problem"
              >
                <Icon path={WARN} color={AMBER} />
                <span className="w-32 shrink-0 truncate font-medium">
                  {p.name}
                </span>
                <span style={{ color: page.statusFg }}>{p.issue}</span>
              </li>
            ))}
          </ul>
          <div style={{ color: page.statusFg }}>
            Their conversations are still on disk. Restore previous version puts
            back v{verify.record.from} and the snapshot from before the update.
          </div>
        </div>
      )}
    </div>
  );
}
