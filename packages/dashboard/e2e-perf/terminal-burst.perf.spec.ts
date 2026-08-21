import { expect, test } from "@playwright/test";

// L2 — in-browser render cost of a burst through the REAL dashboard.
//
// Measures, on the real `useTerminal` + WebGL path:
//   • frames        — WS frames the browser received (end-to-end #1 proof)
//   • drainMs        — first frame → sentinel frame (transport catch-up)
//   • longtaskMs     — total main-thread blocking during the burst (RENDER cost,
//                      the metric Terry feels). PerformanceObserver('longtask').
//   • droppedFrames  — rAF gaps > 32ms during the burst (perceived jank)
//   • renderer       — 'webgl/canvas' (has <canvas>) vs 'dom' (#0 sanity)
//
// The burst size + coalescing are controlled by the perf SERVER's env
// (AUTONOMOS_WS_COALESCE). Run the same spec against a server booted with the
// flag off vs on to ablate #1 end-to-end in the browser.

const SESSION_ID = "00000000-0000-4000-8000-0000000000ff";
const SENTINEL = "__AUTONOMOS_PERF_SENTINEL__";

const INSTRUMENT = `
window.__perf = {
  measuring: false, frames: 0, bytes: 0,
  firstFrameT: 0, sentinelT: 0, sawSentinel: false, wsOpen: false,
  longtaskMs: 0, droppedFrames: 0, _lastRaf: 0,
  tightPairs: 0, lastFrameT: 0,
};
(function () {
  const Native = window.WebSocket;
  function Wrapped(url, protocols) {
    const ws = new Native(url, protocols);
    if (String(url).includes('/ws/terminal/')) {
      ws.addEventListener('open', () => { window.__perf.wsOpen = true; });
      ws.addEventListener('message', (ev) => {
        const p = window.__perf;
        if (!p.measuring) return;
        const text = typeof ev.data === 'string' ? ev.data : '';
        p.frames++; p.bytes += text.length;
        if (p.lastFrameT && ev.timeStamp - p.lastFrameT < 12) p.tightPairs++;
        p.lastFrameT = ev.timeStamp;
        if (!p.firstFrameT) p.firstFrameT = performance.now();
        if (!p.sawSentinel && text.indexOf('${SENTINEL}') !== -1) {
          p.sawSentinel = true; p.sentinelT = performance.now();
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
      const d = now - p._lastRaf;
      if (d > 32) p.droppedFrames++;
    }
    p._lastRaf = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

test("burst render cost through real dashboard", async ({ page, request }) => {
  // Remote runs require an auth token (local NOAUTH runs leave it unset).
  const TOKEN = process.env.PERF_TOKEN;
  const tq = TOKEN ? `?token=${TOKEN}` : "";

  // Fresh, empty session (clears any replay buffer).
  const reg = await request.post(`/api/perf/session${tq}`, { data: {} });
  expect(reg.ok()).toBeTruthy();

  await page.addInitScript(INSTRUMENT);
  // Authenticate the browser (sets the cookie the WS upgrade carries).
  if (TOKEN) await page.goto(`/auth?token=${TOKEN}`);
  await page.goto("/");

  // Open the synthetic session's terminal by clicking it in the sidebar.
  await page.getByText("perf-burst", { exact: false }).first().click();

  // Real xterm mounts + WS connects.
  await page.locator(".xterm").first().waitFor({ state: "visible" });
  await expect.poll(() => page.evaluate(() => window.__perf?.wsOpen), {
    timeout: 15_000,
  }).toBe(true);
  // Let WebGL attach + any replay settle.
  await page.waitForTimeout(800);

  // Begin measuring, fire the burst.
  await page.evaluate(() => {
    window.__perf.measuring = true;
  });
  const t0 = Date.now();
  const mb = process.env.PERF_MB;
  const q = [mb ? `mb=${mb}` : "", TOKEN ? `token=${TOKEN}` : ""]
    .filter(Boolean)
    .join("&");
  const emit = await request.post(
    `/api/perf/emit/${SESSION_ID}${q ? `?${q}` : ""}`,
  );
  expect(emit.ok()).toBeTruthy();
  const emitInfo = (await emit.json()) as { chunks: number; bytes: number };

  // Wait until the sentinel frame reaches the browser.
  await expect
    .poll(() => page.evaluate(() => window.__perf?.sawSentinel), {
      timeout: 30_000,
    })
    .toBe(true);
  // Let trailing long-tasks finish, then stop measuring.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__perf.measuring = false;
  });

  const m = await page.evaluate(() => {
    const p = window.__perf;
    const canvases = document.querySelectorAll(".xterm canvas").length;
    return {
      frames: p.frames,
      bytes: p.bytes,
      // Frames <12ms apart = a repaint split across WS frames — the torn-
      // paint flicker fingerprint. DIAGNOSTIC on this synchronous burst (the
      // 16KB threshold emits back-to-back frames in one tick, so ~0 is not
      // achievable here); the enforced guards are the trailing-edge unit
      // tests + the DEFAULT_COALESCE pin in terminal-coalesce.test.ts.
      tightPairs: p.tightPairs,
      drainMs: p.sentinelT - p.firstFrameT,
      longtaskMs: p.longtaskMs,
      droppedFrames: p.droppedFrames,
      renderer: canvases > 0 ? "webgl/canvas" : "dom",
    };
  });

  const wallMs = Date.now() - t0;
  const coalesce = process.env.AUTONOMOS_WS_COALESCE ?? "(server default)";

  // biome-ignore lint/suspicious/noConsole: harness output is the deliverable
  console.log(
    "\n=== L2 BROWSER RENDER ===\n" +
      JSON.stringify(
        {
          coalesceFlag: coalesce,
          ptyChunks: emitInfo.chunks,
          payloadKB: +(emitInfo.bytes / 1024).toFixed(1),
          browser: m,
          wallMs,
        },
        null,
        2,
      ) +
      `\n\nHEADLINE: ${emitInfo.chunks} chunks → ${m.frames} frames in browser, ` +
      `render-block ${m.longtaskMs.toFixed(0)}ms, dropped ${m.droppedFrames} frames, ` +
      `renderer=${m.renderer}\n`,
  );

  // Integrity: the burst must have actually reached + rendered.
  expect(m.frames).toBeGreaterThan(0);
});
