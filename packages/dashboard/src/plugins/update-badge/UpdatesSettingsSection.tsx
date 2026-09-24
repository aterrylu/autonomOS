/**
 * Settings → Updates (ADR-103): the running version, the daily update-check
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
import { GREEN } from "./UpdateDialog";
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
  onRestore,
}: {
  /** The existing Update Check toggle row. */
  updateCheckToggle: ReactNode;
  /** Called after a Restore was requested (the panel closes itself). */
  onRestore: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const requestRestore = useUpdateBus((s) => s.requestRestore);
  const [version, setVersion] = useState<string | null>(null);
  const [data, setData] = useState<SystemSnapshots | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    systemApi
      .version({ signal: ctrl.signal })
      .then((v) => setVersion(v.version))
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
      {updateCheckToggle}

      <div
        className="text-[10px] font-medium uppercase tracking-wide pt-1"
        style={label}
      >
        Snapshots · kept: last {KEPT}
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
                        latest
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
                      onRestore();
                    }}
                    data-testid="settings-restore"
                  >
                    Restore
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="text-[10px]" style={label}>
        Restore is offered on the snapshot that pairs with the previous version
        kept on disk. Older ones are kept for manual recovery — see{" "}
        <span className="font-mono">autonomos snapshots list</span>. Stored in
        your autonomOS config folder under{" "}
        <span className="font-mono">snapshots/</span>.
      </div>
    </div>
  );
}
