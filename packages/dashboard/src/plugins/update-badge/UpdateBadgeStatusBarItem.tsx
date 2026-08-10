// Passive update-available badge (ADR-077 §6).
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
  /** "bundle" | "source" | null (dev checkout / older server). */
  installMode: string | null;
  /** GitHub release-notes page for `latest`, or null (repo override). */
  releaseUrl: string | null;
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
              installMode:
                typeof data.installMode === "string" ? data.installMode : null,
              releaseUrl:
                typeof data.releaseUrl === "string" ? data.releaseUrl : null,
            });
          }
        }
      } catch {
        // Server unreachable / non-JSON body — keep whatever we had; the
        // connection-status item owns reachability display. (Fields ABSENT
        // never lands here: an older server's response parses fine and falls
        // through the type guard above, same keep-state outcome.)
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

  const label = `New release available (v${info.version} → v${info.latest})`;
  const tooltip =
    // Shape-true advice: `autonomos upgrade` refuses on a plain dev
    // checkout (installMode null) — pointing at it from the dashboard
    // Terry actually watches would advertise a refusal.
    (info.installMode === "bundle" || info.installMode === "source"
      ? "Run `autonomos upgrade` in a terminal (verified restart, auto-rollback)."
      : "Update this dev checkout with `git pull && make prod`.") +
    (info.releaseUrl ? " Click to open the release notes." : "");

  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: page.statusFg }}
      title={tooltip}
      data-testid="update-badge"
    >
      <span
        className="inline-block rounded-full"
        style={{ width: 7, height: 7, background: "#58a6ff" }}
      />
      {info.releaseUrl ? (
        // A link to the release NOTES is navigation the USER performs — the
        // dashboard app still never calls GitHub, and this is not an update
        // button (nothing touches the daemon).
        <a
          href={info.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
          style={{ color: "inherit" }}
          data-testid="update-badge-link"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}
