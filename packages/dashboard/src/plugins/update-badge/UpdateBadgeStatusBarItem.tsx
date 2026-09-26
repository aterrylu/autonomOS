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
// Clicking the pill opens the flow: one decision screen (notes + a live agent
// check + the buttons), then progress on the same surface. The
// update itself NEVER runs in the daemon: POST /api/system/upgrade launches
// `autonomos upgrade` as its own supervisor job, which keeps the CLI's health
// gate + auto-rollback. This component only follows that job's status file.

import { useEffect, useRef, useState } from "react";
import { request } from "../../api/core";
import { THEMES, useStore } from "../../store";
import {
  accentsFor,
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
  const { amber: AMBER, blue: BLUE } = accentsFor(page.bg);
  const known = info?.updateAvailable && info.latest ? info : null;
  const flow = useUpdateFlow(info !== null);

  // Restore requests from Settings → Updates and the post-update banner.
  // Compared against the value seen at mount, so a remount never replays
  // an old request.
  const restoreNonce = useUpdateBus((s) => s.restoreNonce);
  const seenNonce = useRef(restoreNonce);
  const { openRestore, open } = flow;
  useEffect(() => {
    if (restoreNonce === seenNonce.current) return;
    seenNonce.current = restoreNonce;
    openRestore();
  }, [restoreNonce, openRestore]);
  // "Update…" from Settings → Updates opens the same dialog as the pill.
  const openNonce = useUpdateBus((s) => s.openNonce);
  const seenOpen = useRef(openNonce);
  useEffect(() => {
    if (openNonce === seenOpen.current) return;
    seenOpen.current = openNonce;
    open();
  }, [openNonce, open]);

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
      phase={flow.record?.phase}
      rollback={flow.record?.kind === "rollback"}
      elapsedMs={flow.elapsedMs}
      gaveUp={flow.gaveUp}
    />
  );

  if (flow.tracking === "armed" && known) {
    const busy = flow.upgrade?.busy ?? [];
    const target = flow.upgrade?.armed?.target ?? known.latest;
    const who =
      busy.length === 0
        ? null
        : busy.length === 1
          ? busy[0].name
          : `${busy.length} agents`;
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap rounded-full pl-0.5 pr-0.5"
        style={{
          color: AMBER,
          border: `1px solid ${AMBER}66`,
          background: `${AMBER}14`,
          height: 18,
        }}
        data-testid="update-badge-armed"
      >
        {/* The label opens the waiting view: who it's waiting for, and the
            same Update now / Cancel choices with room to explain them. */}
        <button
          type="button"
          onClick={flow.open}
          className="flex h-full cursor-pointer items-center gap-1.5 rounded-full px-1.5 hover:brightness-125"
          style={{ color: AMBER }}
          data-testid="update-armed-open"
        >
          <ClockIcon />
          <span>
            {who ? `v${target} waits for ${who}` : `v${target} starts shortly`}
          </span>
        </button>
        <button
          type="button"
          className="h-full cursor-pointer rounded-full px-2 font-semibold hover:brightness-125"
          style={{ color: page.fg, borderLeft: `1px solid ${AMBER}66` }}
          disabled={flow.pending}
          onClick={() => void flow.start("now", target)}
          data-testid="update-armed-now"
        >
          Update now
        </button>
        <button
          type="button"
          aria-label="Cancel scheduled update"
          title="Cancel scheduled update"
          className="h-full cursor-pointer rounded-full px-2 hover:brightness-125"
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
    : `Update to v${info.latest}`;

  return (
    <>
      <button
        type="button"
        onClick={flow.open}
        className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2 font-semibold hover:brightness-125"
        style={{
          color: BLUE,
          border: `1px solid ${BLUE}44`,
          background: `${BLUE}12`,
          height: 18,
        }}
        title={
          running
            ? "Updating on the server. Click to see progress."
            : `You're on v${info.version}. See what's new and update.`
        }
        data-testid="update-badge"
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 7, height: 7, background: BLUE }}
        />
        <span>{label}</span>
      </button>
      {dialog}
      {overlay}
    </>
  );
}
