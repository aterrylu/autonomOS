// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { ConnectionStatusBarItem } from "./ConnectionStatusBarItem";

/**
 * ConnectionStatusBarItem — the bottom-left server indicator. It polls
 * /api/host on an adaptive cadence (fast until first success, then slow) and
 * debounces single failures so a momentary blip doesn't flash "Disconnected".
 *
 * We drive a stubbed fetch + fake timers to assert the state machine:
 *   - "Checking…" while the first probe is still racing,
 *   - "Connected" once it answers,
 *   - one dropped poll stays "Connected" (debounced), two flips to
 *     "Disconnected",
 *   - a later success recovers to "Connected".
 */

// Flips the stubbed /api/host response between ok / not-ok / network error.
let probeOutcome: "ok" | "notok" | "throw" = "ok";

function stubHostFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const u = String(url);
      if (u.includes("/api/host")) {
        if (probeOutcome === "throw")
          return Promise.reject(new Error("offline"));
        return Promise.resolve({ ok: probeOutcome === "ok" } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    }),
  );
}

// Stubs a /api/host that never resolves on its own but rejects with an
// AbortError when its signal fires — i.e. an up-but-hung server. This is what
// drives the PROBE_TIMEOUT_MS abort path.
function stubHangingFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    ),
  );
}

// Mirror of the component's PROBE_TIMEOUT_MS (not exported); a hung probe is
// aborted after this long and counts as a failure.
const PROBE_TIMEOUT_MS = 4_000;

/** Advance timers and flush the awaited fetch microtasks inside act(). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function label(): string | null {
  return screen.getByText(/Connected|Disconnected|Checking/).textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  probeOutcome = "ok";
  stubHostFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConnectionStatusBarItem", () => {
  it("starts on 'Checking…' then shows 'Connected' after the first probe", async () => {
    render(<ConnectionStatusBarItem />);
    expect(label()).toBe("Checking...");
    await advance(0); // flush the initial probe
    expect(label()).toBe("Connected");
  });

  it("stays 'Checking…' (not red) when the first probe fails before ever connecting", async () => {
    probeOutcome = "throw";
    render(<ConnectionStatusBarItem />);
    await advance(0);
    // One failure with no prior success → still checking, not disconnected.
    expect(label()).toBe("Checking...");
  });

  it("debounces a single dropped poll but flips to 'Disconnected' on two consecutive failures", async () => {
    render(<ConnectionStatusBarItem />);
    await advance(0);
    expect(label()).toBe("Connected");

    // While connected we poll on the SLOW cadence, so the first failure only
    // surfaces at the 20s mark — debounced, still shows Connected.
    probeOutcome = "notok";
    await advance(20_000);
    expect(label()).toBe("Connected");

    // That failure switched us to the fast cadence; the next (2nd consecutive)
    // failure 2s later flips to Disconnected.
    await advance(2_000);
    expect(label()).toBe("Disconnected");
  });

  it("recovers to 'Connected' on the fast cadence after a disconnect", async () => {
    render(<ConnectionStatusBarItem />);
    await advance(0);

    probeOutcome = "throw";
    await advance(20_000); // slow cadence → 1st failure (debounced)
    await advance(2_000); // fast cadence → 2nd failure → Disconnected
    expect(label()).toBe("Disconnected");

    // Server comes back; fast (2s) cadence should reconnect promptly.
    probeOutcome = "ok";
    await advance(2_000);
    expect(label()).toBe("Connected");
  });

  it("uses the slow cadence once connected (no re-poll before the slow interval)", async () => {
    render(<ConnectionStatusBarItem />);
    await advance(0);
    expect(label()).toBe("Connected");

    // Drop the server but DON'T advance past the slow interval yet.
    probeOutcome = "throw";
    await advance(2_000); // < SLOW_INTERVAL_MS (20s): no probe should have fired
    expect(label()).toBe("Connected");

    // Cross the slow interval → first failure (debounced, still Connected),
    // then fast cadence kicks in and a second failure flips to Disconnected.
    await advance(18_000); // reach the 20s mark → 1st failure
    expect(label()).toBe("Connected");
    await advance(2_000); // fast retry → 2nd failure
    expect(label()).toBe("Disconnected");
  });

  it("times out a hung probe and surfaces it as a failure (doesn't wait forever)", async () => {
    stubHangingFetch();
    render(<ConnectionStatusBarItem />);
    // Probe is in flight and will never resolve on its own.
    expect(label()).toBe("Checking...");

    // First probe times out → aborted → counts as failure #1. No prior
    // success, so we stay on "Checking…" (and reschedule on the fast cadence).
    await advance(PROBE_TIMEOUT_MS);
    expect(label()).toBe("Checking...");

    // Second probe (fast cadence) also hangs and times out → failure #2 →
    // Disconnected. Without the abort timeout the indicator would hang on
    // "Checking…" forever, so reaching "Disconnected" proves the timeout works.
    await advance(2_000); // fast-cadence reschedule fires the next probe
    await advance(PROBE_TIMEOUT_MS); // it times out too
    expect(label()).toBe("Disconnected");
  });
});
