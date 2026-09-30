/**
 * Real-browser proof of the CSRF / cross-site WebSocket guard (V1).
 *
 *   bun --filter @autonomos/dashboard build   # once: the server serves dist/
 *   cd packages/dashboard && bunx tsx scripts/csrf-e2e.ts
 *
 * Boots an ISOLATED server (a short /tmp config dir, a fake HOME, a throwaway
 * token, bound to 127.0.0.1 on an ephemeral port; it never touches :3100),
 * signs a real headless Chromium in through the sign-in link, then opens a
 * hostile page served from ANOTHER PORT of the same host. SameSite=Lax ignores
 * ports, so the browser attaches the session cookie to that page's requests.
 * That was the audit's V1 PoC.
 *
 * The hostile page tries four things. All must fail:
 *   1. a no-cors text/plain POST that creates a template
 *   2. a real <form enctype="text/plain"> submit that creates a template
 *   3. a body-less no-cors POST (the kill/restart shape)
 *   4. opening /ws/agents and reading the fleet snapshot
 * Then the real dashboard, same browser and same cookie, must still work: the
 * UI loads signed in, /ws/agents delivers a frame, and a JSON POST succeeds.
 *
 * Exit 0 = all held. `CSRF_E2E_EXPECT_VULNERABLE=1` inverts the attack
 * assertions, to show the script isn't vacuous against a build without the
 * guard.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "packages/server/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "packages/server/node_modules/.bin/tsx");
const EXPECT_VULNERABLE = process.env.CSRF_E2E_EXPECT_VULNERABLE === "1";

// Short: the control socket lives in here and macOS caps socket paths at 104B.
const root = mkdtempSync("/tmp/csrf-");
const configDir = join(root, "c");
const fakeHome = join(root, "h");
mkdirSync(configDir);
mkdirSync(fakeHome);
const token = randomBytes(32).toString("hex");

let server: ChildProcess | undefined;
let evil: Server | undefined;
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function bootServer(): Promise<number> {
  // Only what the server needs. Never inherit the operator's AUTONOMOS_*.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    AUTONOMOS_CONFIG_DIR: configDir,
    AUTONOMOS_TOKEN: token,
  };
  const child = spawn(
    TSX_BIN,
    [SERVER_ENTRY, "--port=0", "--host=127.0.0.1"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server = child;
  const out: string[] = [];
  child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => out.push(d.toString()));
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`server not ready:\n${out.join("")}`)),
      30_000,
    );
    child.stdout?.on("data", () => {
      const m = out
        .join("")
        .match(/autonomOS server listening on https?:\/\/[^\s:]+:(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) =>
      reject(new Error(`server exited ${code}:\n${out.join("")}`)),
    );
  });
}

function hostilePage(target: string): string {
  return `<!doctype html><meta charset="utf-8"><title>totally a dev server</title>
<form id="f" method="POST" action="${target}/api/templates" enctype="text/plain" target="sink">
  <input name='{"name":"csrf-form","role":"x","description":"x","systemPrompt":"x","pad":"' value='"}'>
</form>
<iframe name="sink"></iframe>
<script>
window.attack = async () => {
  const r = {};
  await fetch("${target}/api/templates", {
    method: "POST", mode: "no-cors", credentials: "include",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "csrf-fetch", role: "x", description: "x", systemPrompt: "x" }),
  }).catch(() => {});
  await fetch("${target}/api/agents/restart-all", {
    method: "POST", mode: "no-cors", credentials: "include",
  }).catch(() => {});
  document.getElementById("f").submit();
  r.ws = await new Promise((done) => {
    let got = null;
    const ws = new WebSocket("${target.replace("http", "ws")}/ws/agents");
    ws.onmessage = (e) => { got = String(e.data).slice(0, 80); };
    ws.onclose = (e) => done({ frame: got, code: e.code });
    setTimeout(() => { try { ws.close(); } catch {} done({ frame: got, code: "timeout" }); }, 4000);
  });
  return r;
};
</script>`;
}

async function listTemplates(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/templates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // An object keyed by template name.
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`GET /api/templates → ${res.status}`);
  return Object.keys(body);
}

async function main(): Promise<void> {
  const port = await bootServer();
  const target = `http://127.0.0.1:${port}`;
  console.log(`isolated server on ${target} (config ${configDir})`);

  evil = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(hostilePage(target));
  });
  await new Promise<void>((r) => evil?.listen(0, "127.0.0.1", r));
  const evilUrl = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/evil.html`;

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Sign in the way an operator does: the #token= link (ADR-117).
    await page.goto(`${target}/#token=${token}`);
    await page.waitForFunction(
      () => !location.hash.includes("token="),
      undefined,
      { timeout: 15_000 },
    );
    const cookies = await ctx.cookies(target);
    check(
      "signed in: the browser holds the session cookie",
      cookies.some((c) => c.name.startsWith("autonomos_token")),
      cookies.map((c) => c.name).join(","),
    );

    // ── The attack, from another port of the same host ──
    const evilPage = await ctx.newPage();
    await evilPage.goto(evilUrl);
    const r = (await evilPage.evaluate("window.attack()")) as {
      ws: { frame: string | null; code: number | string };
    };
    await evilPage.waitForTimeout(1000); // let the form post land
    const names = await listTemplates(port);
    const expectBlocked = (name: string, blocked: boolean, detail: string) =>
      check(
        EXPECT_VULNERABLE ? `${name} SUCCEEDS (vulnerable build)` : name,
        EXPECT_VULNERABLE ? !blocked : blocked,
        detail,
      );
    expectBlocked(
      "hostile page: no-cors text/plain POST creates nothing",
      !names.includes("csrf-fetch"),
      `templates: ${names.join(",")}`,
    );
    expectBlocked(
      "hostile page: <form enctype=text/plain> creates nothing",
      !names.some((n) => n.startsWith("csrf-form")),
      `templates: ${names.join(",")}`,
    );
    expectBlocked(
      "hostile page: WebSocket /ws/agents reads nothing",
      r.ws.frame === null,
      `close=${r.ws.code} frame=${r.ws.frame ?? "none"}`,
    );
    const log = readFileSync(join(configDir, "logs", "autonomos.log"), "utf8");
    expectBlocked(
      "the server refused the body-less POST (restart-all)",
      /refused a cross-origin POST on \/api\/agents\/restart-all/.test(log),
      "from the server log",
    );

    // ── The real dashboard still works, same browser and same cookie ──
    await page.goto(target);
    await page.waitForLoadState("networkidle");
    const onLogin = await page
      .getByText(/paste your token|sign in/i)
      .first()
      .isVisible()
      .catch(() => false);
    check("dashboard loads signed in (no login screen)", !onLogin);
    const own = (await page.evaluate(async () => {
      const post = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "dashboard-ok",
          role: "r",
          description: "d",
          systemPrompt: "s",
        }),
      });
      const frame = await new Promise<string | null>((done) => {
        const ws = new WebSocket(`ws://${location.host}/ws/agents`);
        ws.onmessage = (e) => {
          done(String(e.data).slice(0, 40));
          ws.close();
        };
        ws.onclose = () => done(null);
        setTimeout(() => done(null), 4000);
      });
      return { post: post.status, frame };
    })) as { post: number; frame: string | null };
    check("dashboard: same-origin JSON POST succeeds", own.post < 300, `${own.post}`);
    check(
      "dashboard: /ws/agents delivers the fleet frame",
      own.frame !== null,
      own.frame ?? "none",
    );
    await page.screenshot({ path: join(root, "dashboard.png") });
    console.log(`screenshot: ${join(root, "dashboard.png")}`);
  } finally {
    await browser.close();
  }
}

main()
  .catch((err) => {
    check("script ran", false, String(err));
  })
  .finally(() => {
    evil?.close();
    server?.kill("SIGTERM");
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} checks passed`,
    );
    if (!process.env.CSRF_E2E_KEEP) rmSync(root, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
