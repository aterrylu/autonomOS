import { useCallback, useEffect, useRef, useState } from "react";
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

  const fetchUsage = useCallback(async () => {
    const res = await fetch("/api/plugins/claude-usage").catch(() => null);
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
