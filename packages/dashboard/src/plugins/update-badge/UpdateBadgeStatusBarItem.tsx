// Passive update-available badge (ADR-072 §6).
//
// PASSIVE is load-bearing: this renders information and nothing else. No
// update button in v1 — the in-process REST upgrade path has no health gate
// (the process that would run it exits), and OpenClaw's most-reported update
// bugs were all dashboard-side (a no-op update that still restarted the
// gateway; a button that looked dead mid-update). The badge points at the
// CLI, which owns verification and auto-rollback.
//
// This component reads the SERVER's cached answer off /api/system/version —
// the dashboard never contacts GitHub (the server checks ~daily; see
// updateCheck.ts). Polling here is only to notice the cache changed, so the
// cadence is hours, not seconds, and the very first fetch usually finds
// nothing (fresh boots haven't checked yet) — rendering null is the normal
// state, which also means the README hero is unaffected.

import { useEffect, useState } from "react";
import { THEMES, useStore } from "../../store";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

type VersionInfo = {
  version: string;
  latest: string | null;
  updateAvailable: boolean;
};

function useUpdateAvailable(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        const res = await fetch("/api/system/version", {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok && mounted) {
          const data = (await res.json()) as Partial<VersionInfo>;
          if (
            typeof data.version === "string" &&
            typeof data.updateAvailable === "boolean"
          ) {
            setInfo({
              version: data.version,
              latest: typeof data.latest === "string" ? data.latest : null,
              updateAvailable: data.updateAvailable,
            });
          }
        }
      } catch {
        // Server unreachable or fields absent (older server) — keep whatever
        // we had; the connection-status item owns reachability display.
      } finally {
        if (mounted) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return info;
}

export function UpdateBadgeStatusBarItem() {
  const info = useUpdateAvailable();
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  if (!info?.updateAvailable || !info.latest) return null;

  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: page.statusFg }}
      title={
        `Update available: v${info.version} → v${info.latest}. ` +
        "Run `autonomos upgrade` in a terminal (verified restart, auto-rollback)."
      }
      data-testid="update-badge"
    >
      <span
        className="inline-block rounded-full"
        style={{ width: 7, height: 7, background: "#58a6ff" }}
      />
      <span>{`v${info.latest} available`}</span>
    </span>
  );
}
