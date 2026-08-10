import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "../../api/core";
import type { CodexUsageData } from "./types";

const POLL_INTERVAL = 60_000;

/** Poll the codex-usage route. Mirrors claude-usage's useUsageData: 60s poll,
 *  cancellation-safe. `error` carries transport failures; domain problems ride
 *  in `data.error`/`data.errorKind` on a 200 response. */
export function useCodexUsageData() {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Error handling mirrors claude-usage's useUsageData exactly, including
  // keeping the last data on a failed poll.
  const fetchUsage = useCallback(async () => {
    try {
      const usage = await request<CodexUsageData>("/api/plugins/codex-usage");
      if (cancelledRef.current) return;
      // request() resolves null only for an EMPTY 2xx body (non-JSON now
      // throws BAD_BODY); guard stays for that edge.
      if (!usage) {
        setError("Invalid response");
        return;
      }
      setData(usage);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof ApiError) {
        setError(err.unreachable ? "unreachable" : `HTTP ${err.status}`);
      } else {
        setError("Invalid response");
      }
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
