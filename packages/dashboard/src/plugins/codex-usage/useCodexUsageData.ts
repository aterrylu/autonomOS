import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexUsageData } from "./types";

const POLL_INTERVAL = 60_000;

/** Poll the codex-usage route. Mirrors claude-usage's useUsageData: 60s poll,
 *  cancellation-safe. `error` carries transport failures; domain problems ride
 *  in `data.error`/`data.errorKind` on a 200 response. */
export function useCodexUsageData() {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchUsage = useCallback(async () => {
    const res = await fetch("/api/plugins/codex-usage").catch(() => null);
    if (cancelledRef.current) return;
    if (!res?.ok) {
      setError(res ? `HTTP ${res.status}` : "unreachable");
      return;
    }
    try {
      setData(await res.json());
      setError(null);
    } catch {
      setError("Invalid response");
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchUsage();
    const interval = setInterval(fetchUsage, POLL_INTERVAL);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [fetchUsage]);

  return { data, error };
}
