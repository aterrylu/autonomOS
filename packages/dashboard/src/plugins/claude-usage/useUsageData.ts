import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "../../api/core";
import type { DisplayMode, RateLimitData } from "./types";

const POLL_INTERVAL = 60_000;
const DISPLAY_MODE_KEY = "claude-usage-display-mode";

export function useUsageData() {
  const [data, setData] = useState<RateLimitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayModeState] = useState<DisplayMode>(
    () => (localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode) || "text",
  );
  const cancelledRef = useRef(false);

  function setDisplayMode(mode: DisplayMode) {
    setDisplayModeState(mode);
    localStorage.setItem(DISPLAY_MODE_KEY, mode);
  }

  // A failed poll keeps the LAST data on screen and marks it with `error` —
  // stale-but-labeled beats blanking a usage bar the user is reading.
  const fetchUsage = useCallback(async () => {
    try {
      const usage = await request<RateLimitData>("/api/plugins/claude-usage");
      if (cancelledRef.current) return;
      // request() resolves null only for an EMPTY 2xx body (non-JSON now
      // throws BAD_BODY and lands in the catch below); the guard stays for
      // that edge — exactly the old "Invalid response" case.
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

  const refetch = useCallback(async () => {
    setData(null);
    setError(null);
    try {
      await fetchUsage();
    } catch {
      setError("Fetch failed");
    }
  }, [fetchUsage]);

  useEffect(() => {
    cancelledRef.current = false;
    fetchUsage();
    const interval = setInterval(fetchUsage, POLL_INTERVAL);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [fetchUsage]);

  return { data, error, displayMode, setDisplayMode, refetch };
}
