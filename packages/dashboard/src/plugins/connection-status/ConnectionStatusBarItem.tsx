import { useEffect, useState } from "react";
import { ApiError, request } from "../../api/core";
import { THEMES, useStore } from "../../store";

type ServerHealth = "connected" | "disconnected" | "checking";

// Poll cadence. We probe aggressively until the server first answers — this
// covers the desktop startup race and the webview's auth-bootstrap reload,
// where the page can mount a beat before /api/host is reachable — then relax
// to a steady heartbeat. Any time we're NOT solidly connected we drop back to
// the fast cadence so recovery from a blip is ~2s instead of the old fixed 15s.
const FAST_INTERVAL_MS = 2_000;
const SLOW_INTERVAL_MS = 20_000;
// A single failed probe is treated as transient. Only after this many
// CONSECUTIVE failures do we actually surface "disconnected", which debounces
// momentary blips (reload churn, sleep/wake, a server restart on upgrade) that
// the old code flashed red on the instant they happened.
const FAILURES_BEFORE_DISCONNECTED = 2;
// Don't let a hung request stall a poll cycle — abort and treat as a failure.
const PROBE_TIMEOUT_MS = 4_000;

function useServerHealth(): ServerHealth {
  const [health, setHealth] = useState<ServerHealth>("checking");

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let everConnected = false;

    // A liveness probe has two transport needs the shared GET path deliberately
    // doesn't provide: each tick must put a REAL request on the wire (in-flight
    // dedup would coalesce probes behind a hung sibling), and an abort must
    // truly cancel the socket (a hung server would otherwise accumulate one
    // leaked request per tick until the browser's ~6-per-host cap wedges every
    // later probe). `fresh: true` opts out of dedup, and the client forwards
    // `signal` to fetch on non-deduped requests — abort kills the socket.
    async function probe(): Promise<boolean> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        await request("/api/host", { fresh: true, signal: controller.signal });
        return true;
      } catch (err) {
        // A timed-out probe, a network failure, and a reachable-but-erroring
        // server (5xx/401/…) all mean "unhealthy", but log them distinctly so
        // an up-but-slow server is diagnosable from the console.
        if (err instanceof ApiError && err.code === "ABORTED") {
          console.debug(`Health check timed out after ${PROBE_TIMEOUT_MS}ms`);
        } else if (err instanceof ApiError && !err.unreachable) {
          console.debug(`Health check got non-ok status: ${err.status}`);
        } else {
          console.debug("Health check failed (network error):", err);
        }
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function tick(): Promise<void> {
      let ok = false;
      try {
        ok = await probe();
        if (!mounted) return;

        if (ok) {
          failures = 0;
          everConnected = true;
          setHealth("connected");
        } else {
          failures += 1;
          if (failures >= FAILURES_BEFORE_DISCONNECTED) {
            setHealth("disconnected");
          } else if (!everConnected) {
            // Still racing the first successful probe — stay on "checking"
            // rather than flashing red before we've ever reached the server.
            setHealth("checking");
          }
          // Otherwise we were connected and this is the first failure: keep
          // showing "connected" (debounced) while the fast cadence below
          // re-probes to confirm whether it's a real drop.
        }
      } finally {
        // Reschedule in `finally` so a throw anywhere in the body above can't
        // permanently kill the heartbeat — without this, a single thrown
        // setHealth would freeze the indicator forever. Skip when unmounted
        // (the early return lands here too) so cleanup stays authoritative.
        // Fast whenever we're not solidly connected, so both initial connect
        // and recovery happen within ~2s; slow once we're stably up.
        if (mounted) {
          timer = setTimeout(tick, ok ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS);
        }
      }
    }

    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return health;
}

function classify(health: ServerHealth): {
  color: string;
  label: string;
  pulse: boolean;
} {
  switch (health) {
    case "connected":
      return { color: "#3fb950", label: "Connected", pulse: false };
    case "checking":
      return { color: "#d29922", label: "Checking...", pulse: true };
    default:
      return { color: "#ea6c73", label: "Disconnected", pulse: false };
  }
}

export function ConnectionStatusBarItem() {
  const health = useServerHealth();
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { color, label, pulse } = classify(health);

  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: page.statusFg }}
      title={`Server: ${label}`}
    >
      <span
        className="inline-block rounded-full"
        style={{
          width: 7,
          height: 7,
          background: color,
          boxShadow: pulse ? `0 0 4px ${color}` : undefined,
          animation: pulse ? "pulse 1.5s ease-in-out infinite" : undefined,
        }}
      />
      <span>{label}</span>
    </span>
  );
}
