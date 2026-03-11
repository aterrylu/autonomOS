import { useEffect, useState } from "react";
import type { UsageSummary } from "./types";

const POLL_INTERVAL = 30_000;

export function useUsageData() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return { data, error };
}
