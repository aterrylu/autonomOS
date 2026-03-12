import { useEffect, useState } from "react";
import type { DisplayMode, RateLimitData } from "./types";

const POLL_INTERVAL = 60_000;
const DISPLAY_MODE_KEY = "claude-usage-display-mode";

export function useUsageData() {
  const [data, setData] = useState<RateLimitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayModeState] = useState<DisplayMode>(
    () => (localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode) || "text",
  );

  function setDisplayMode(mode: DisplayMode) {
    setDisplayModeState(mode);
    localStorage.setItem(DISPLAY_MODE_KEY, mode);
  }

  useEffect(() => {
    let cancelled = false;

    async function fetchUsage() {
      const res = await fetch("/api/plugins/claude-usage").catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        setError(res ? `HTTP ${res.status}` : "unreachable");
        return;
      }
      setError(null);
      setData(await res.json());
    }

    fetchUsage();
    const interval = setInterval(fetchUsage, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { data, error, displayMode, setDisplayMode };
}
