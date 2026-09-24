// Update-available pill + the in-app update flow (ADR-105; supersedes the
// passive-only badge of ADR-077 §6).
//
// The pill reads the SERVER's cached update-check answer off
// /api/system/version — the dashboard never contacts GitHub (the server
// checks ~daily; see updateCheck.ts; release notes also come from the
// server's cache via /api/system/releases). Polling here is only to notice
// the cache changed, so the cadence is hours, and rendering null is the
// normal state (which also keeps the README hero unaffected).
//
// Clicking the pill opens the flow: What's new → Check agents → Update. The
// update itself NEVER runs in the daemon: POST /api/system/upgrade launches
// `autonomos upgrade` as its own supervisor job, which keeps the CLI's health
// gate + auto-rollback. This component only follows that job's status file.

import { useEffect, useRef, useState } from "react";
import { request } from "../../api/core";
import { THEMES, useStore } from "../../store";
import {
  AMBER,
  BLUE,
  ReconnectingOverlay,
  UpdateDialog,
  type VersionInfo,
} from "./UpdateDialog";
import { useUpdateBus } from "./updateBus";
import { useUpdateFlow } from "./useUpdateFlow";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

type RawVersion = {
  version: unknown;
  latest: unknown;
  updateAvailable: unknown;
  installMode: unknown;
  releaseUrl: unknown;
  platform: unknown;
  arch: unknown;
};

type Known = VersionInfo & { updateAvailable: boolean };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function useUpdateAvailable(): Known | null {
  const [info, setInfo] = useState<Known | null>(null);
  const versionNonce = useUpdateBus((s) => s.versionNonce);

  useEffect(() => {
    void versionNonce; // re-poll now when the flow learns `latest` moved
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        // `fresh` keeps the timeout signal attached to the actual socket
        // (deduped GETs detach their signal); at a 6h cadence dedup buys
        // nothing anyway. Parsed tolerantly — /api/system/version is
        // ReleaseRollout's contract, and an older server omits fields.
        const data = await request<Partial<RawVersion>>("/api/system/version", {
          fresh: true,
          signal: AbortSignal.timeout(5_000),
        });
        if (
          data &&
          mounted &&
          typeof data.version === "string" &&
          typeof data.updateAvailable === "boolean"
        ) {
          const mode = str(data.installMode);
          setInfo({
            version: data.version,
            latest: str(data.latest) ?? "",
            updateAvailable: data.updateAvailable,
            installMode: mode === "bundle" || mode === "source" ? mode : null,
            releaseUrl: str(data.releaseUrl),
            platform: str(data.platform),
            arch: str(data.arch),
          });
        }
      } catch {
        // Server unreachable / non-JSON body — keep whatever we had; the
        // connection-status item owns reachability display.
      } finally {
        if (mounted) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [versionNonce]);

  return info;
}

function ClockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function UpdateBadgeStatusBarItem() {
  const info = useUpdateAvailable();
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const known = info?.updateAvailable && info.latest ? info : null;
  const flow = useUpdateFlow(info !== null);

  // Restore requests from Settings → Updates and the post-update banner.
  // Compared against the value seen at mount, so a remount never replays
  // an old request.
  const restoreNonce = useUpdateBus((s) => s.restoreNonce);
  const seenNonce = useRef(restoreNonce);
  const { openRestore } = flow;
  useEffect(() => {
    if (restoreNonce === seenNonce.current) return;
    seenNonce.current = restoreNonce;
    openRestore();
  }, [restoreNonce, openRestore]);

  // The flow (modal + reconnect overlay) must work with NO update available
  // — a Restore runs after the update already landed — so only the pill
  // itself is gated on `known`.
  if (!info) return null;

  const dialog = <UpdateDialog info={info} flow={flow} />;
  const overlay = flow.tracking === "reconnecting" && (
    <ReconnectingOverlay
      to={
        flow.record?.to ?? flow.upgrade?.armed?.target ?? (info.latest || "…")
      }
      elapsedMs={flow.elapsedMs}
      gaveUp={flow.gaveUp}
    />
  );

  if (flow.tracking === "armed" && known) {
    const n = flow.upgrade?.busy.length ?? 0;
    const target = flow.upgrade?.armed?.target ?? known.latest;
    const idleSecs = Math.round((flow.upgrade?.idleWindowMs ?? 30_000) / 1000);
    const names = (flow.upgrade?.busy ?? []).map((b) => b.name).join(", ");
    return (
      <span
        className="flex items-center gap-1.5 rounded-full pl-2 pr-1"
        style={{
          color: AMBER,
          border: `1px solid ${AMBER}55`,
          background: `${AMBER}14`,
          height: 18,
        }}
        data-testid="update-badge-armed"
        title={
          `Update scheduled. It starts on its own once every agent has been idle for ${idleSecs}s` +
          (names ? ` (waiting on ${names}).` : ".") +
          (flow.actionError ? ` ${flow.actionError}` : "")
        }
      >
        <ClockIcon />
        <span>
          {n > 0
            ? `Update to v${target} waiting on ${n} agent${n === 1 ? "" : "s"}`
            : `Update to v${target} starting shortly`}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded-full px-1.5 font-semibold hover:brightness-125"
          style={{ color: page.fg, borderLeft: `1px solid ${AMBER}55` }}
          disabled={flow.pending}
          onClick={() => void flow.start("now", target)}
          data-testid="update-armed-now"
        >
          Update now
        </button>
        <button
          type="button"
          aria-label="Cancel scheduled update"
          className="cursor-pointer px-1 hover:brightness-125"
          style={{ color: page.statusFg }}
          onClick={() => void flow.cancelArmed()}
          data-testid="update-armed-cancel"
        >
          ×
        </button>
        {dialog}
      </span>
    );
  }

  const running =
    flow.tracking === "running" || flow.tracking === "reconnecting";
  if (!known && !running) {
    return (
      <>
        {dialog}
        {overlay}
      </>
    );
  }
  const runTo = flow.record?.to ?? known?.latest ?? "…";
  const label = running
    ? `${flow.record?.kind === "rollback" ? "Restoring" : "Updating to"} v${runTo}…`
    : `New release available (v${info.version} → v${info.latest})`;

  return (
    <>
      <button
        type="button"
        onClick={flow.open}
        className="flex cursor-pointer items-center gap-1.5 rounded-full pl-2 pr-0.5 hover:brightness-125"
        style={{
          color: BLUE,
          border: `1px solid ${BLUE}44`,
          background: `${BLUE}12`,
          height: 18,
        }}
        title={
          running
            ? "An update is running on the server. Click to see its progress."
            : "See what's new and update autonomOS."
        }
        data-testid="update-badge"
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 7, height: 7, background: BLUE }}
        />
        <span>{label}</span>
        {!running && (
          <span
            className="px-1.5 font-semibold"
            style={{ color: page.fg, borderLeft: `1px solid ${BLUE}44` }}
          >
            Update
          </span>
        )}
      </button>
      {dialog}
      {overlay}
    </>
  );
}
