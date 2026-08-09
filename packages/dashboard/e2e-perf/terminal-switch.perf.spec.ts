import { expect, test } from "@playwright/test";

// L2 — AGENT-SWITCH cost through the REAL dashboard (Terry's #3 complaint:
// "switching agents re-renders the terminal from scratch, ~5s of text rushing
// in on a slow network").
//
// Scenario: two synthetic agents — `perf-heavy` seeded with ~1MB of Ink-style
// scrollback, `perf-light` with ~50KB. Open heavy, let it settle, switch to
// light, settle, then switch BACK to heavy and measure what that switch costs:
//
//   • wsConnects   — new terminal WS connections the switch triggered
//                    (baseline: 1 — teardown+reconnect; keep-alive cache: 0)
//   • frames/bytes — WS frames + payload re-streamed for the switch
//                    (baseline: one frame per buffered chunk ≈ 19k/MB;
//                     replay-coalescing: ~bytes/64KB; cache hit: 0)
//   • settledMs    — click → terminal fully caught up (sentinel re-received,
//                    or terminal visible when nothing needs re-streaming)
//   • longtaskMs   — main-thread blocking during the switch (render cost)
//
// Run the same spec against baseline/fix servers (env flags) to ablate.

const HEAVY_ID = "00000000-0000-4000-8000-0000000000aa";
const LIGHT_ID = "00000000-0000-4000-8000-0000000000bb";
const SENTINEL = "__AUTONOMOS_PERF_SENTINEL__";
// Cold-open replay over a throttled link legitimately takes tens of seconds.
const SETTLE_TIMEOUT = process.env.PERF_THROTTLE === "1" ? 120_000 : 30_000;

interface SessStat {
  frames: number;
  bytes: number;
  sawSentinel: boolean;
  sentinelT: number;
  connects: number;
}

declare global {
  interface Window {
    __perf: {
      measuring: boolean;
      sess: Record<string, SessStat>;
      longtaskMs: number;
      droppedFrames: number;
      _lastRaf: number;
      mark: () => void;
    };
  }
}

const INSTRUMENT = `
window.__perf = {
  measuring: false,
  sess: {},
  longtaskMs: 0, droppedFrames: 0, _lastRaf: 0,
  mark() {
    this.sess = {};
    this.longtaskMs = 0;
    this.droppedFrames = 0;
    this.measuring = true;
  },
};
(function () {
  function stat(id) {
    const p = window.__perf;
    if (!p.sess[id]) p.sess[id] = { frames: 0, bytes: 0, sawSentinel: false, sentinelT: 0, connects: 0 };
    return p.sess[id];
  }
  const Native = window.WebSocket;
  function Wrapped(url, protocols) {
    const ws = new Native(url, protocols);
    const m = String(url).match(/\\/ws\\/terminal\\/([0-9a-f-]+)/);
    if (m) {
      const id = m[1];
      if (window.__perf.measuring) stat(id).connects++;
      ws.addEventListener('message', (ev) => {
        if (!window.__perf.measuring) return;
        const s = stat(id);
        const text = typeof ev.data === 'string' ? ev.data : '';
        s.frames++; s.bytes += text.length;
        if (!s.sawSentinel && text.indexOf('${SENTINEL}') !== -1) {
          s.sawSentinel = true; s.sentinelT = performance.now();
        }
      });
    }
    return ws;
  }
  Wrapped.prototype = Native.prototype;
  Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3;
  window.WebSocket = Wrapped;

  try {
    new PerformanceObserver((list) => {
      const p = window.__perf;
      if (!p.measuring) return;
      for (const e of list.getEntries()) p.longtaskMs += e.duration;
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  function tick(now) {
    const p = window.__perf;
    if (p.measuring && p._lastRaf) {
      if (now - p._lastRaf > 32) p.droppedFrames++;
    }
    p._lastRaf = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

test("agent-switch re-stream cost through real dashboard", async ({
  page,
  request,
}) => {
  // Two agents: heavy scrollback (the one we switch back to) + a light one.
  const heavy = await request.post("/api/perf/session", {
    data: { id: HEAVY_ID, name: "perf-heavy", seedMb: 1 },
  });
  expect(heavy.ok()).toBeTruthy();
  const light = await request.post("/api/perf/session", {
    data: { id: LIGHT_ID, name: "perf-light", seedMb: 0.05 },
  });
  expect(light.ok()).toBeTruthy();
  const seeded = ((await heavy.json()) as {
    seeded?: { chunks: number; bytes: number };
  }).seeded;

  await page.addInitScript(INSTRUMENT);
  await page.goto("/");

  // PERF_THROTTLE=1 → Slow-3G-ish network via CDP (150ms RTT, ~750kbps down),
  // applied AFTER the app itself loads (the vite dev bundle over Slow 3G
  // would otherwise eat the whole timeout before a terminal ever mounts).
  // This is the condition under which the old per-chunk replay was "seconds
  // of text rushing in": per-frame overhead × ~19k frames. NOTE: whether
  // Chrome applies these conditions to WebSocket traffic varies by version —
  // the keep-alive switch-back is network-free either way, so its number is
  // throttle-proof by construction; treat the cold-open number as indicative.
  if (process.env.PERF_THROTTLE === "1") {
    test.setTimeout(240_000);
    await page.waitForLoadState("networkidle");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (750 * 1024) / 8,
      uploadThroughput: (250 * 1024) / 8,
    });
  }

  // ── Cold open of heavy (context number, not the headline) ────────────
  await page.evaluate(() => window.__perf.mark());
  const coldT0 = Date.now();
  await page.getByText("perf-heavy", { exact: false }).first().click();
  await page.locator(".xterm").first().waitFor({ state: "visible" });
  await expect
    .poll(
      () => page.evaluate((id) => !!window.__perf.sess[id]?.sawSentinel, HEAVY_ID),
      { timeout: SETTLE_TIMEOUT },
    )
    .toBe(true);
  const coldMs = Date.now() - coldT0;

  // ── Switch heavy → light, let it fully settle ────────────────────────
  await page.getByText("perf-light", { exact: false }).first().click();
  await expect
    .poll(
      () => page.evaluate((id) => !!window.__perf.sess[id]?.sawSentinel, LIGHT_ID),
      { timeout: SETTLE_TIMEOUT },
    )
    .toBe(true);
  await page.waitForTimeout(500);

  // ── THE MEASUREMENT: switch back to heavy ────────────────────────────
  await page.evaluate(() => window.__perf.mark());
  const t0 = Date.now();
  await page.getByText("perf-heavy", { exact: false }).first().click();
  await page.locator(".xterm").first().waitFor({ state: "visible" });
  const visibleMs = Date.now() - t0;

  // Settled = sentinel re-received (a re-stream happened), OR a quiet window
  // with zero frames (keep-alive cache: nothing re-streamed at all).
  let settledVia = "sentinel";
  try {
    await expect
      .poll(
        () =>
          page.evaluate((id) => !!window.__perf.sess[id]?.sawSentinel, HEAVY_ID),
        { timeout: 8_000 },
      )
      .toBe(true);
  } catch {
    const frames = await page.evaluate(
      (id) => window.__perf.sess[id]?.frames ?? 0,
      HEAVY_ID,
    );
    if (frames === 0) settledVia = "no-restream";
    else throw new Error(
      `switch re-streamed ${frames} frames but sentinel never arrived — partial replay?`,
    );
  }
  const settledMs = settledVia === "sentinel" ? Date.now() - t0 : visibleMs;
  // Let trailing long-tasks land before reading counters.
  await page.waitForTimeout(600);

  const m = await page.evaluate((id) => {
    const p = window.__perf;
    p.measuring = false;
    const s = p.sess[id] ?? {
      frames: 0,
      bytes: 0,
      sawSentinel: false,
      sentinelT: 0,
      connects: 0,
    };
    return {
      wsConnects: s.connects,
      frames: s.frames,
      kbRestreamed: +(s.bytes / 1024).toFixed(1),
      longtaskMs: +p.longtaskMs.toFixed(0),
      droppedFrames: p.droppedFrames,
    };
  }, HEAVY_ID);

  // biome-ignore lint/suspicious/noConsole: harness output is the deliverable
  console.log(
    "\n=== L2 AGENT-SWITCH ===\n" +
      JSON.stringify(
        {
          seededScrollback: seeded,
          coldOpenMs: coldMs,
          switchBack: { ...m, visibleMs, settledMs, settledVia },
        },
        null,
        2,
      ) +
      `\n\nHEADLINE: switch back to a 1MB-scrollback agent → ` +
      `${m.wsConnects} WS reconnect(s), ${m.frames} frames / ${m.kbRestreamed}KB re-streamed, ` +
      `settled in ${settledMs}ms (${settledVia}), render-block ${m.longtaskMs}ms\n`,
  );

  // Integrity: the switched-to terminal must actually SHOW content — a
  // keep-alive bug could produce perfect zeros above while rendering a blank
  // pane. Screenshot the terminal and require pixel variance.
  const shot = await page.locator(".xterm").first().screenshot();
  const pixels = new Set<string>();
  // PNG bytes aren't raw pixels, but a blank canvas compresses to a tiny,
  // low-entropy file — use size + byte diversity as a cheap non-blank proxy.
  for (const b of shot.subarray(0, 4096)) pixels.add(String(b));
  expect(shot.length).toBeGreaterThan(2_000);
  expect(pixels.size).toBeGreaterThan(30);
});
