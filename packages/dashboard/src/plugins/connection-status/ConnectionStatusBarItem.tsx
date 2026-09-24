import { useEffect, useState } from "react";
import { agentsSocket, type TransportHealth } from "../../api/agentsSocket";
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

/**
 * FALLBACK health: an HTTP poll of /api/host. Authoritative only until the
 * /ws/agents push socket has opened once this page load — after that the
 * socket's 5s heartbeat is the source of truth (see useTransportHealth),
 * because this poll's 20s cadence + 2-failure debounce took up to ~30s to
 * notice a dead server and could never notice a stuck agent. Kept for the
 * case where the socket can never open (a proxy that refuses WS upgrades),
 * so the indicator still reflects reachability.
 */
function useServerHealth(enabled: boolean): ServerHealth {
  const [health, setHealth] = useState<ServerHealth>("checking");

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);

  return health;
}

/** The push socket's health, plus seconds since its last frame (re-read every
 *  second while not connected, so "last heard Ns ago" counts up). Observes
 *  via onHealthChange, which does NOT start the socket — the push bridge
 *  owns its lifecycle. */
function useTransportHealth(): { health: TransportHealth; silentSec: number } {
  const [health, setHealth] = useState<TransportHealth>(
    () => agentsSocket.getSnapshot().health,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setHealth(agentsSocket.getSnapshot().health);
    return agentsSocket.onHealthChange(setHealth);
  }, []);

  const counting = health === "reconnecting" || health === "disconnected";
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);

  const last = agentsSocket.lastHeardAt();
  // Date.now() on the transition render, not the `now` state: that state was
  // set when counting last stopped (or at mount), so the first "Reconnecting"
  // frame would read "last heard 0s ago" until the interval's first tick.
  const at = counting ? Math.max(now, Date.now()) : now;
  const silentSec = last > 0 ? Math.max(0, Math.round((at - last) / 1000)) : 0;
  return { health, silentSec };
}

const GREEN = "#3fb950";
const AMBER = "#d29922";
const RED = "#ea6c73";

export function classify(
  transport: TransportHealth,
  poll: ServerHealth,
  silentSec: number,
): { color: string; label: string; pulse: boolean } {
  switch (transport) {
    case "connected":
      return { color: GREEN, label: "Connected", pulse: false };
    case "reconnecting":
      return {
        color: AMBER,
        label: `Reconnecting… last heard ${silentSec}s ago`,
        pulse: true,
      };
    case "disconnected":
      return { color: RED, label: "Disconnected · retrying", pulse: false };
    default:
      // "connecting": the socket has never opened this page load — the HTTP
      // poll is the only evidence we have.
      switch (poll) {
        case "connected":
          return { color: GREEN, label: "Connected", pulse: false };
        case "checking":
          return { color: AMBER, label: "Checking...", pulse: true };
        default:
          return { color: RED, label: "Disconnected", pulse: false };
      }
  }
}

export function ConnectionStatusBarItem() {
  const { health: transport, silentSec } = useTransportHealth();
  const poll = useServerHealth(transport === "connecting");
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { color, label, pulse } = classify(transport, poll, silentSec);

  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: page.statusFg }}
      title={
        transport === "disconnected"
          ? `Server: no response for ${silentSec}s — retrying`
          : `Server: ${label}`
      }
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
