import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "../../api/core";
import type { DisplayMode, RateLimitData, SpendDisplay } from "./types";

const POLL_INTERVAL = 60_000;
const DISPLAY_MODE_KEY = "claude-usage-display-mode";
const SPEND_DISPLAY_KEY = "claude-usage-spend-display";
const SPEND_DISPLAYS: readonly SpendDisplay[] = ["text", "percent", "bar"];

/** Stored spend style, or the default (text). Tolerates blocked storage. */
function readSpendDisplay(): SpendDisplay {
  try {
    const v = localStorage.getItem(SPEND_DISPLAY_KEY);
    return SPEND_DISPLAYS.includes(v as SpendDisplay)
      ? (v as SpendDisplay)
      : "text";
  } catch {
    return "text";
  }
}

export function useUsageData() {
  const [data, setData] = useState<RateLimitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayModeState] = useState<DisplayMode>(
    () => (localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode) || "text",
  );
  const [spendDisplay, setSpendDisplayState] =
    useState<SpendDisplay>(readSpendDisplay);
  const cancelledRef = useRef(false);

  function setSpendDisplay(style: SpendDisplay) {
    setSpendDisplayState(style);
    try {
      localStorage.setItem(SPEND_DISPLAY_KEY, style);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  }

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
        setError(
          err.unreachable
            ? "unreachable"
            : // BAD_BODY carries the wire-faithful status 200 — rendering
              // "HTTP 200" as an error reads as nonsense; keep the old label.
              err.code === "BAD_BODY"
              ? "Invalid response"
              : `HTTP ${err.status}`,
        );
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

  return {
    data,
    error,
    displayMode,
    setDisplayMode,
    spendDisplay,
    setSpendDisplay,
    refetch,
  };
}
