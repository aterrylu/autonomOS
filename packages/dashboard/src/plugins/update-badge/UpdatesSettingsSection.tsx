/**
 * Settings → Updates (ADR-105): the running version, the daily update-check
 * toggle (owned by the settings panel, passed in so its behavior is
 * unchanged), and the kept state snapshots.
 *
 * Restore is offered ONLY on the server's `rollback.snapshotId` — the newest
 * snapshot taken FROM the previous version actually kept on disk, which is
 * exactly what a Restore puts back (there can be several from that version,
 * e.g. after a Restore saved the live state). Older snapshots are listed for reference / manual recovery
 * from a terminal: restoring them without their code would run old code on
 * newer records, or new code on old ones.
 */

import { type ReactNode, useEffect, useState } from "react";
import { type SystemSnapshots, systemApi } from "../../api/system";
import { THEMES, useStore } from "../../store";
import { accentsFor } from "./UpdateDialog";
import { useUpdateBus } from "./updateBus";
import {
  formatBytes,
  formatReleaseDate,
  formatSnapshotDate,
} from "./updateFlow";

/** Mirrors the server's SNAPSHOT_RETENTION. */
const KEPT = 5;

export function UpdatesSettingsSection({
  updateCheckToggle,
  onHandOff,
}: {
  /** The existing Update Check toggle row. */
  updateCheckToggle: ReactNode;
  /** Called after this section hands off to the update dialog (Restore or
   *  Update…): the settings panel closes itself. */
  onHandOff: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { green: GREEN, blue: BLUE } = accentsFor(page.bg);
  const requestOpen = useUpdateBus((s) => s.requestOpen);
  const requestRestore = useUpdateBus((s) => s.requestRestore);
  const refreshVersion = useUpdateBus((s) => s.refreshVersion);
  type Check =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "done"; latest: string | null; available: boolean }
    | { kind: "error"; message: string };
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const checkNow = async () => {
    setCheck({ kind: "checking" });
    try {
      const r = await systemApi.checkUpdates();
      setCheck({
        kind: "done",
        latest: r.latest,
        available: r.updateAvailable,
      });
      setOffer(r.updateAvailable && r.latest ? r.latest : null);
      // The status-bar pill reads /api/system/version on its own cadence —
      // nudge it so a found update shows up right away.
      refreshVersion();
    } catch (err) {
      setCheck({
        kind: "error",
        message: err instanceof Error ? err.message : "Check failed",
      });
    }
  };
  const [version, setVersion] = useState<string | null>(null);
  /** The server's cached answer, so an available update shows here too. */
  const [offer, setOffer] = useState<string | null>(null);
  const [data, setData] = useState<SystemSnapshots | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    systemApi
      .version({ signal: ctrl.signal })
      .then((v) => {
        setVersion(v.version);
        if (v.updateAvailable && v.latest) setOffer(v.latest);
      })
      .catch(() => {});
    systemApi
      .snapshots({ signal: ctrl.signal })
      .then(setData)
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      });
    return () => ctrl.abort();
  }, []);

  const label = { color: page.statusFg };
  const snapshots = data?.snapshots ?? [];
  const pairing = data?.rollback?.snapshotId ?? null;
  // "updated <date>": the snapshot taken on the way INTO this version.
  const updatedAt = snapshots.find((s) => s.toVersion === version)?.createdAt;
  const updatedDate = updatedAt ? formatReleaseDate(updatedAt) : null;

  return (
    <div className="space-y-2" data-testid="settings-updates">
      <div
        className="text-[10px] font-medium uppercase tracking-wide"
        style={label}
      >
        Updates
      </div>
      <div className="flex items-center justify-between">
        <span style={label}>Version</span>
        <span data-testid="settings-version">
          {version ? `v${version}` : "…"}
          {updatedDate && <span style={label}> · updated {updatedDate}</span>}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[10px] min-w-0"
          style={label}
          data-testid="settings-check-result"
        >
          {check.kind === "checking" && "Checking…"}
          {check.kind !== "checking" &&
            check.kind !== "error" &&
            (offer
              ? `v${offer} is available`
              : check.kind === "done" && "You're on the latest version")}
          {check.kind === "error" && `Couldn't check: ${check.message}`}
        </span>
        <span className="flex shrink-0 gap-1.5">
          {offer && check.kind !== "checking" && (
            <button
              type="button"
              className="cursor-pointer rounded px-2 py-0.5 text-[11px] font-semibold hover:brightness-110"
              style={{ border: `1px solid ${BLUE}`, color: BLUE }}
              onClick={() => {
                requestOpen();
                onHandOff();
              }}
              data-testid="settings-open-update"
            >
              Update…
            </button>
          )}
          <button
            type="button"
            className="cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium hover:brightness-110 disabled:opacity-60"
            style={{ border: `1px solid ${page.border}`, color: page.fg }}
            onClick={() => void checkNow()}
            disabled={check.kind === "checking"}
            data-testid="settings-check-now"
          >
            {check.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
        </span>
      </div>
      {updateCheckToggle}

      <div
        className="text-[10px] font-medium uppercase tracking-wide pt-1"
        style={label}
      >
        Snapshots
      </div>
      {error ? (
        <div className="text-[10px]" style={label}>
          Couldn't read snapshots.
        </div>
      ) : !data ? (
        <div className="text-[10px]" style={label}>
          Loading…
        </div>
      ) : snapshots.length === 0 ? (
        <div className="text-[10px]" style={label}>
          None yet — one is saved automatically before every update.
        </div>
      ) : (
        <ul
          className="rounded overflow-hidden"
          style={{ border: `1px solid ${page.border}` }}
        >
          {snapshots.map((s, i) => {
            const restorable = s.id === pairing;
            return (
              <li
                key={s.id}
                data-testid="settings-snapshot"
                data-restorable={restorable ? "true" : "false"}
                className="flex items-center justify-between gap-2 px-2 py-1.5"
                style={{
                  borderTop: i === 0 ? undefined : `1px solid ${page.border}`,
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span>
                      Saved on v{s.fromVersion}
                      {s.toVersion && (
                        <span style={label}> · before v{s.toVersion}</span>
                      )}
                    </span>
                    {i === 0 && (
                      <span
                        className="rounded px-1 text-[9px]"
                        style={{ color: GREEN, border: `1px solid ${GREEN}66` }}
                      >
                        newest
                      </span>
                    )}
                  </span>
                  <span className="text-[10px]" style={label}>
                    {formatSnapshotDate(s.createdAt)} · {formatBytes(s.bytes)}
                  </span>
                </span>
                {restorable && (
                  <button
                    type="button"
                    className="shrink-0 cursor-pointer rounded px-2 py-1 text-[11px] hover:brightness-110"
                    style={{ background: page.border, color: page.fg }}
                    onClick={() => {
                      requestRestore();
                      onHandOff();
                    }}
                    data-testid="settings-restore"
                  >
                    Restore v{data?.rollback?.version}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="text-[10px]" style={label}>
        The last {KEPT} are kept. autonomOS keeps one previous version, so only
        its snapshot can be restored here; older ones can be recovered from a
        terminal (<span className="font-mono">autonomos snapshots list</span>).
      </div>
    </div>
  );
}
