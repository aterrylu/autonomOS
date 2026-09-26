import type { AgentActivityBatch } from "@autonomos/core";
import { useEffect, useRef, useState } from "react";
import { agentsApi } from "../../api/agents";

const REFRESH_MS = 20_000;
const DEBOUNCE_MS = 800;

/**
 * The cards' status history for the WHOLE fleet in ONE request
 * (`GET /api/agents/analytics`) — never one request per card. Refreshed every
 * 20s while the tab is visible, and shortly after any status change
 * (`statusKey`), debounced so a burst of hook events costs one fetch.
 *
 * A malformed or failed response keeps the last good data: the strip and the
 * time-in-state are informational, and a blip must not blank every card.
 */
export function useFleetActivity(statusKey: string): AgentActivityBatch | null {
  const [data, setData] = useState<AgentActivityBatch | null>(null);
  const latest = useRef(0);
  const load = useRef((_always?: boolean) => {});
  load.current = (always = false) => {
    // Periodic refreshes pause while the tab is hidden; the first load never
    // does, so a chart that mounts in a background tab still has its data.
    if (
      !always &&
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    const mine = ++latest.current;
    agentsApi
      .activity()
      .then((b) => {
        const ok = !!b && typeof b === "object" && !!b.agents;
        if (ok && mine === latest.current) setData(b);
      })
      .catch(() => {
        // Keep what we had.
      });
  };

  useEffect(() => {
    load.current(true);
    const t = setInterval(() => load.current(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      latest.current += 1; // orphan any in-flight request
    };
  }, []);

  // A status change: refetch soon (debounced). Skipped on mount — the effect
  // above already fetched.
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusKey is the trigger
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => load.current(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [statusKey]);

  return data;
}
