import { expect, test } from "@playwright/test";

// MOVE 2 — decompose the ~160ms main-thread render-block of a burst.
//
// Captures a CDP CPU profile during the burst and buckets self-time by source
// (xterm.js parse/render vs React vs dashboard code vs scroll), so the biggest
// slice names the local-lag fix instead of us guessing.

const SESSION_ID = "00000000-0000-4000-8000-0000000000ff";
const SENTINEL = "__AUTONOMOS_PERF_SENTINEL__";

const INSTRUMENT = `
window.__perf = { measuring:false, sawSentinel:false, wsOpen:false };
(function(){
  const Native = window.WebSocket;
  function W(url, p){
    const ws = new Native(url, p);
    if (String(url).includes('/ws/terminal/')) {
      ws.addEventListener('open', () => { window.__perf.wsOpen = true; });
      ws.addEventListener('message', (ev) => {
        if (!window.__perf.measuring) return;
        const t = typeof ev.data === 'string' ? ev.data : '';
        if (t.indexOf('${SENTINEL}') !== -1) window.__perf.sawSentinel = true;
      });
    }
    return ws;
  }
  W.prototype = Native.prototype; W.OPEN = 1; W.CONNECTING = 0; W.CLOSING = 2; W.CLOSED = 3;
  window.WebSocket = W;
})();
`;

function bucketOf(url: string, fn: string): string {
  const u = url || "";
  if (u.includes("xterm") || /_Terminal|InputHandler|Parser|Buffer|Renderer|Webgl/.test(fn))
    return "xterm (parse+render)";
  if (u.includes("react-dom") || u.includes("/react/") || u.includes("scheduler"))
    return "React";
  if (u.includes("useTerminal") || u.includes("/src/") || u.includes("dashboard"))
    return "dashboard app";
  if (u.includes("node_modules")) return "other deps";
  if (u === "" || fn === "(program)" || fn === "(idle)" || fn === "(garbage collector)")
    return `runtime: ${fn || "native"}`;
  return "other";
}

test("profile burst render-block by source", async ({ page, request }) => {
  await request.post("/api/perf/session", { data: {} });
  await page.addInitScript(INSTRUMENT);
  await page.goto("/");
  await page.getByText("perf-burst", { exact: false }).first().click();
  await page.locator(".xterm").first().waitFor({ state: "visible" });
  await expect
    .poll(() => page.evaluate(() => window.__perf?.wsOpen), { timeout: 15_000 })
    .toBe(true);
  await page.waitForTimeout(800);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); // 100µs
  await cdp.send("Profiler.start");

  await page.evaluate(() => {
    window.__perf.measuring = true;
  });
  await request.post(`/api/perf/emit/${SESSION_ID}`);
  await expect
    .poll(() => page.evaluate(() => window.__perf?.sawSentinel), {
      timeout: 30_000,
    })
    .toBe(true);
  await page.waitForTimeout(400);

  const { profile } = await cdp.send("Profiler.stop");

  // Aggregate self-time (sample count × interval) per node, bucket by source.
  const interval = (profile.timeDeltas?.length
    ? profile.timeDeltas.reduce((a, b) => a + b, 0) / profile.samples!.length
    : 100) / 1000; // ms per sample (approx)
  const selfByNode = new Map<number, number>();
  for (const id of profile.samples ?? []) {
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + 1);
  }
  const buckets = new Map<string, number>();
  const fnTotals = new Map<string, number>();
  let totalSamples = 0;
  for (const node of profile.nodes ?? []) {
    const n = selfByNode.get(node.id) ?? 0;
    if (!n) continue;
    totalSamples += n;
    const fn = node.callFrame.functionName || "(anonymous)";
    const b = bucketOf(node.callFrame.url, fn);
    buckets.set(b, (buckets.get(b) ?? 0) + n);
    const key = `${b} › ${fn}`;
    fnTotals.set(key, (fnTotals.get(key) ?? 0) + n);
  }

  const toMs = (samples: number) => +(samples * interval).toFixed(1);
  const pct = (samples: number) =>
    `${((samples / totalSamples) * 100).toFixed(1)}%`;

  const bucketRows = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => ({ bucket: b, ms: toMs(n), pct: pct(n) }));
  const topFns = [...fnTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, n]) => ({ fn: k, ms: toMs(n), pct: pct(n) }));

  // biome-ignore lint/suspicious/noConsole: harness output is the deliverable
  console.log(
    "\n=== MOVE 2: RENDER-BLOCK DECOMPOSITION ===\n" +
      `total on-CPU ≈ ${toMs(totalSamples)}ms across ${totalSamples} samples\n\n` +
      "BY SOURCE:\n" +
      bucketRows.map((r) => `  ${r.pct.padStart(6)} ${String(r.ms).padStart(7)}ms  ${r.bucket}`).join("\n") +
      "\n\nTOP SELF-TIME FUNCTIONS:\n" +
      topFns.map((r) => `  ${r.pct.padStart(6)} ${String(r.ms).padStart(7)}ms  ${r.fn}`).join("\n") +
      "\n",
  );

  expect(totalSamples).toBeGreaterThan(0);
});
