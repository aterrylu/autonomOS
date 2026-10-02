// Rig probe (not shipped): in a REAL headless Chromium (rAF runs), open an
// agent's pane on a dev dashboard proxied to a rig server, wheel up, and
// report what happened: the xterm buffer type, viewport position before and
// after, and every byte the pane sent to the PTY.
//   node scripts/wheel-probe.mjs <baseUrl> <agentId> [wheelTicks] [--reload]
import { chromium } from "@playwright/test";

const [base, agentId, ticksArg] = process.argv.slice(2);
const ticks = Number(ticksArg ?? 10);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript((id) => {
  localStorage.setItem(
    "autonomos",
    JSON.stringify({ state: { activePane: { type: "session", id } }, version: 0 }),
  );
  window.__sent = [];
  const o = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (String(this.url).includes("/ws/terminal/")) {
      if (typeof d === "string") window.__sent.push(d);
      else {
        const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        window.__sent.push(new TextDecoder().decode(u8[0] === 1 ? u8.subarray(9) : u8));
      }
    }
    return o.call(this, d);
  };
}, agentId);
await page.goto(base);
await page.waitForFunction((id) => !!window.__autonomosTerminal?.(id), agentId, { timeout: 20000 });
await page.waitForTimeout(3000); // replay + fit settle
const state = () =>
  page.evaluate((id) => {
    const t = window.__autonomosTerminal(id).terminal;
    const b = t.buffer.active;
    return { type: b.type, baseY: b.baseY, viewportY: b.viewportY, cols: t.cols, rows: t.rows };
  }, agentId);
const before = await state();
await page.evaluate(() => { window.__sent = []; });
const box = await page.locator(".xterm").first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < ticks; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(800);
const after = await state();
const sent = await page.evaluate(() => window.__sent.filter((s) => !s.startsWith('{"type":"resize"')));
console.log(JSON.stringify({ agentId, before, after, sent: sent.map((s) => JSON.stringify(s)).slice(0, 12), sentCount: sent.length }));
await page.screenshot({ path: `/tmp/aosg/wheel-${agentId.slice(0, 8)}.png` });
await browser.close();
