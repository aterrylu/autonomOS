/**
 * capture-demo — boot a fully isolated autonomOS instance with a staged
 * multi-agent scene and capture marketing screenshots of the web dashboard.
 * Re-run on each release so README imagery never goes stale.
 *
 * Usage (from repo root):
 *   bun --cwd packages/dashboard run capture-demo
 *   bun --cwd packages/dashboard run capture-demo --keep   # leave running
 *
 * Desktop-app capture is a planned follow-up: it needs a small hook in
 * packages/app first (env-overridable home/userData — macOS Electron
 * resolves Application Support natively, so $HOME tricks can't isolate it)
 * plus a playwright-core bump for Electron 35's debugger handshake.
 *
 * What it does:
 *   1. Starts a local mock of the Anthropic /v1/messages SSE endpoint —
 *      the REAL `claude` binary runs against it (zero tokens, deterministic
 *      output), the same approach as the server's integration suites.
 *   2. Boots the real server with an isolated AUTONOMOS_CONFIG_DIR on an
 *      ephemeral port; the server serves the built dashboard.
 *   3. Spawns a small cast of named agents via the real REST API, builds an
 *      org chart, lets each agent produce real terminal output, then poses
 *      statuses (working / tool running / needs input / idle) by posting
 *      synthetic hook events.
 *   4. Screenshots via Playwright into docs/assets/.
 *
 * SAFETY (load-bearing — see packages/server/src/__tests__/helpers/
 * embedded-server.ts): the host machine may run a LIVE autonomOS
 * deployment. Everything here is scoped — isolated config dir, ephemeral
 * port, agents deleted through their own API, the server child killed by
 * PID. Never kill by process name.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

// ── CLI flags ────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const KEEP_ALIVE = argv.includes("--keep");

// ── Paths ────────────────────────────────────────────────────────────

const DASHBOARD_DIR = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DASHBOARD_DIR, "../..");
const SERVER_ENTRY = join(REPO_ROOT, "packages/server/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "packages/server/node_modules/.bin/tsx");
const OUT_DIR = join(REPO_ROOT, "docs/assets");

// ── The cast ─────────────────────────────────────────────────────────
// Four agents that tell the orchestration story: a lead coordinating three
// specialists, each posed in a distinct status so every badge variant is
// visible in one shot.

interface CastMember {
  name: string;
  /** PTY cols at spawn. CC never reflows scrollback on resize, so agents
   *  destined for a half-width hero pane must be born narrow. */
  cols?: number;
  /** Starting prompt — also the keyword route for the mock's reply. */
  prompt: string;
  /** Substring of the prompt the mock matches to pick this reply. */
  matchKey: string;
  /** Multi-line reply the agent's terminal will show. */
  reply: string;
  /** Tool call emitted on the first turn (real PreToolUse/PostToolUse fire). */
  tool?: { name: string; input: Record<string, unknown> };
  /** Hook event posted AFTER the run completes to pose the status icon. */
  pose?: Record<string, unknown>;
}

const CAST: CastMember[] = [
  {
    name: "TeamLead",
    cols: 78,
    prompt:
      "Coordinate today's release: dashboard polish is with FrontendDev, the flaky checkout test is with QAEngineer, and Researcher is scouting the competition. Summarize where we stand.",
    matchKey: "Coordinate today's release",
    reply: [
      "Release status — all three workstreams are moving:",
      "",
      "1. **FrontendDev** is mid-flight on the dashboard polish (split-pane drag handles + status badges). No blockers.",
      "2. **QAEngineer** reproduced the flaky checkout test — it's a race in the cart fixture. Waiting on permission to patch the fixture.",
      "3. **Researcher** has the competitor scan drafted; summary landing shortly.",
      "",
      "I'll ping you when QAEngineer's fix is ready for review.",
    ].join("\n"),
    pose: { hook_event_name: "UserPromptSubmit", prompt: "status check" },
  },
  {
    name: "FrontendDev",
    cols: 78,
    prompt:
      "Polish the dashboard split-pane drag handles and make the agent status badges animate smoothly.",
    matchKey: "split-pane drag handles",
    reply: [
      "Polished the split-pane interactions:",
      "",
      "- Drag handles now show a hover affordance and snap at 25/50/75%",
      "- Status badges animate with a 200ms ease-out scale",
      "- Fixed a layout jitter when the sidebar collapses",
      "",
      "Running the component tests next.",
    ].join("\n"),
    tool: { name: "Read", input: { file_path: "src/components/Layout.tsx" } },
    pose: {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/components/Layout.tsx" },
    },
  },
  {
    name: "QAEngineer",
    prompt:
      "Hunt down the flaky checkout test in the payments suite and propose a fix.",
    matchKey: "flaky checkout test",
    reply: [
      "Found it. The checkout test races the cart fixture:",
      "",
      "- `cart.seed()` resolves before the inventory cache invalidates",
      "- Under load the assertion reads the stale cache → intermittent failure",
      "",
      "Fix: await the cache barrier in the fixture. Requesting permission to edit the shared fixture file.",
    ].join("\n"),
    tool: { name: "Read", input: { file_path: "tests/checkout.spec.ts" } },
    pose: {
      hook_event_name: "PermissionRequest",
      tool_name: "Edit",
      tool_input: { file_path: "tests/fixtures/cart.ts" },
    },
  },
  {
    name: "Researcher",
    prompt:
      "Survey competing agent dashboards and summarize what they do well.",
    matchKey: "competing agent dashboards",
    reply: [
      "Competitor scan complete — three patterns worth stealing:",
      "",
      "1. Per-agent notification badges that deep-link to the waiting prompt",
      "2. Org-chart views that double as routing UIs",
      "3. Session restore that survives machine reboots",
      "",
      "Full notes in docs/research/. Going idle until the next assignment.",
    ].join("\n"),
    // Posed idle explicitly — hook relay curls are async and a Stop can lose
    // a race with a trailing PostToolUse, sticking the badge on "working".
    pose: { hook_event_name: "Stop" },
  },
];

// ── Demo mock backend ────────────────────────────────────────────────
// Same contract as packages/server/src/__tests__/helpers/mock-anthropic.ts,
// extended with per-agent reply routing: the request body carries the
// conversation, so matching a prompt substring picks the right script.

function sse(res: ServerResponse, ev: string, data: unknown): void {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(
  res: ServerResponse,
  block:
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: Record<string, unknown> },
): void {
  const isText = block.type === "text";
  const contentBlock = isText
    ? { type: "text", text: "" }
    : { type: "tool_use", id: "toolu_demo", name: block.name, input: {} };
  const delta = isText
    ? { type: "text_delta", text: block.text }
    : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };

  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_demo",
      type: "message",
      role: "assistant",
      model: "claude-demo",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: contentBlock,
  });
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta,
  });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: isText ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

interface DemoMock {
  url: string;
  /** How many final-text turns each cast member has been served. */
  served: () => ReadonlyMap<string, number>;
  close: () => Promise<void>;
}

function startDemoMock(): Promise<DemoMock> {
  // Tool turn is emitted once per cast member, then text — so the run ends.
  const toolEmitted = new Set<string>();
  const servedText = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks).toString("utf-8");

      if (url.includes("count_tokens")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (req.method === "POST" && url.includes("/v1/messages")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // First CAST-order match wins — TeamLead's prompt cross-references
        // the others' tasks, so TeamLead must stay first in CAST.
        const member = CAST.find((m) => raw.includes(m.matchKey));
        if (!member) {
          // Without this warn, a matchKey miss surfaces only as the staging
          // wait timing out 120s later with zero evidence why.
          console.warn(`mock: no CAST match, serving fallback. Body head: ${raw.slice(0, 200)}`);
          streamMessage(res, { type: "text", text: "Standing by." });
          return;
        }
        if (member.tool && !toolEmitted.has(member.name)) {
          toolEmitted.add(member.name);
          streamMessage(res, { type: "tool_use", ...member.tool });
        } else {
          servedText.set(member.name, (servedText.get(member.name) ?? 0) + 1);
          streamMessage(res, { type: "text", text: member.reply });
        }
        return;
      }
      // Catch-all keeps claude's probes (HEAD, model lookups) happy, but log
      // each one — a 200 {} to an endpoint claude actually needs would
      // otherwise degrade into undefined TUI behavior with no trace here.
      console.warn(`mock: unmatched ${req.method} ${url} — serving {}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    req.on("error", (err) => console.warn(`mock: request error: ${err.message}`));
    res.on("error", (err) => console.warn(`mock: response error: ${err.message}`));
  });

  return new Promise((resolveFn) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolveFn({
        url: `http://127.0.0.1:${addr.port}`,
        served: () => servedText,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ── Demo workspace ───────────────────────────────────────────────────
// A plausible little project for the agents' cwd, so paths in the TUI and
// trust prompts look real rather than like /tmp noise.

function makeDemoWorkspace(): string {
  // Nested so the sidebar shows a clean "demo-webapp", not a mkdtemp suffix.
  const dir = join(mkdtempSync(join(tmpdir(), "autonomos-capture-")), "demo-webapp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "src/components"), { recursive: true });
  mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    "# demo-webapp\n\nA web storefront. Vite + React + a payments API.\n",
  );
  writeFileSync(
    join(dir, "src/components/Layout.tsx"),
    "export function Layout() {\n  return <div className=\"app-shell\" />;\n}\n",
  );
  writeFileSync(
    join(dir, "tests/checkout.spec.ts"),
    "import { test } from \"vitest\";\n\ntest(\"checkout completes\", async () => {\n  // seeds cart fixture, asserts order total\n});\n",
  );
  return dir;
}

// ── Server boot (mirrors __tests__/helpers/embedded-server.ts) ───────

interface DemoServer {
  port: number;
  token: string;
  configDir: string;
  fakeHome: string;
  child: ChildProcess;
  logs: () => string;
  kill: () => void;
}

/** Set once teardown starts so the server-exit watchdog stays quiet. */
let shuttingDown = false;

async function bootServer(mockUrl: string): Promise<DemoServer> {
  const configDir = mkdtempSync(join(tmpdir(), "autonomos-demo-"));
  const token = `demo-${Math.random().toString(36).slice(2, 10)}`;

  writeFileSync(
    join(configDir, "settings.json"),
    `${JSON.stringify(
      {
        anthropicBaseUrl: mockUrl,
        anthropicAuthToken: "sk-demo",
        anthropicOverrideEnabled: true,
        channels: [],
        autoTrust: true,
        statusLine: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );

  // Fake HOME: the project browser and title cache read $HOME/.claude/
  // projects, which would leak the operator's real project list into
  // marketing shots. A fresh HOME also routes the demo agents' session
  // JSONLs there, so the PROJECTS section shows only demo-webapp. Seed
  // .claude.json so the fresh-home claude binary skips first-run onboarding
  // (auth comes from the mock's ANTHROPIC_AUTH_TOKEN, same as CI).
  // bypassPermissionsModeAccepted is load-bearing: autonomous spawns pass
  // --dangerously-skip-permissions, and without the stored acceptance claude
  // shows a dialog whose DEFAULT option is "No, exit" — the auto-trust
  // watcher's Enter would kill the session.
  const fakeHome = mkdtempSync(join(tmpdir(), "autonomos-demo-home-"));
  mkdirSync(join(fakeHome, ".claude", "projects"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
    }),
  );
  // claude checks for itself at ~/.local/bin/claude and renders an orange
  // "missing or broken · run claude install" warning into the TUI without
  // it — symlink the real binary so screenshots stay clean.
  const claudeBin = spawnSync("which", ["claude"], { encoding: "utf-8" }).stdout.trim();
  if (claudeBin) {
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
    symlinkSync(claudeBin, join(fakeHome, ".local", "bin", "claude"));
  }

  // Strip tmux vars so spawned claude TUIs don't render a "tmux detected"
  // hint in the screenshots when the harness itself runs inside tmux.
  // (NodeJS.ProcessEnv annotation keeps the index signature — the spread
  // would otherwise narrow the type and make the deletes a TS2339.)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    AUTONOMOS_CONFIG_DIR: configDir,
    AUTONOMOS_TOKEN: token,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const child = spawn(TSX_BIN, [SERVER_ENTRY, "--embedded", "--port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const out: string[] = [];
  child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => out.push(d.toString()));

  const port = await new Promise<number>((resolveFn, rejectFn) => {
    // Every reject path kills the child — a boot failure must not orphan
    // a live tsx server (main()'s finally can't see it yet at this point).
    const fail = (err: Error): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
      rejectFn(err);
    };
    const timer = setTimeout(
      () => fail(new Error(`server not ready in 20s:\n${out.join("")}`)),
      20_000,
    );
    const onData = (): void => {
      const m = out.join("").match(/AUTONOMOS_READY port=(\d+)/);
      if (m) {
        child.stdout?.off("data", onData);
        clearTimeout(timer);
        resolveFn(Number(m[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", (err) =>
      fail(new Error(`server spawn failed (is tsx installed at ${TSX_BIN}?): ${err.message}`)),
    );
    child.once("exit", (code) =>
      fail(new Error(`server exited (code=${code}) before ready:\n${out.join("")}`)),
    );
  });

  // Post-boot watchdog: a mid-run server crash otherwise surfaces only as a
  // bare ECONNREFUSED from some later fetch, with the logs sitting unread.
  child.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(`server exited unexpectedly (code=${code})\n${out.join("")}`);
    }
  });

  return {
    port,
    token,
    configDir,
    fakeHome,
    child,
    logs: () => out.join(""),
    kill: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

// ── API helpers ──────────────────────────────────────────────────────

async function api<T>(
  server: DemoServer,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = { error: text } as T;
  }
  return { status: res.status, body };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  what: string,
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

// ── Scene staging ────────────────────────────────────────────────────

interface AgentInfo {
  id: string;
  name: string;
  status: string;
}

async function stageScene(
  server: DemoServer,
  mock: DemoMock,
  workspace: string,
): Promise<AgentInfo[]> {
  // Spawn the whole cast concurrently — each runs real claude against the mock.
  console.log(`Spawning ${CAST.length} demo agents…`);
  await Promise.all(
    CAST.map(async (m) => {
      const { status, body } = await api<{ id?: string; error?: string }>(
        server,
        "/api/agents",
        {
          method: "POST",
          body: JSON.stringify({
            name: m.name,
            workingDirectory: workspace,
            prompt: m.prompt,
            autonomousMode: true,
            ...(m.cols ? { cols: m.cols, rows: 34 } : {}),
          }),
        },
      );
      if (status !== 201) {
        throw new Error(`spawn ${m.name} failed (${status}): ${JSON.stringify(body)}`);
      }
    }),
  );

  const agentsRes = await api<AgentInfo[]>(server, "/api/agents");
  if (agentsRes.status !== 200) {
    throw new Error(`GET /api/agents → ${agentsRes.status}: ${JSON.stringify(agentsRes.body)}`);
  }
  const agents = agentsRes.body;
  const byName = new Map(agents.map((a) => [a.name, a]));

  // Completion signal: the MOCK knows when each agent's final text reply was
  // served — more reliable than waiting for hook-derived "idle" (the async
  // curl relay can deliver Stop before a trailing PostToolUse, wedging the
  // badge on "working"; we pose every badge explicitly below anyway).
  await waitFor(
    "every agent's scripted reply served by the mock",
    async () => {
      const served = mock.served();
      console.log(
        `  served: ${CAST.map((m) => `${m.name}=${served.get(m.name) ?? 0}`).join(" ")}`,
      );
      return CAST.every((m) => (served.get(m.name) ?? 0) >= 1);
    },
    120_000,
  );
  // Let the TUIs paint the replies and any trailing hooks land before posing.
  await sleep(6_000);

  // Org chart: TeamLead manages the three specialists.
  for (const name of ["FrontendDev", "QAEngineer", "Researcher"]) {
    const a = byName.get(name);
    if (!a) throw new Error(`agent ${name} missing after spawn`);
    const { status } = await api(server, `/api/agents/${a.id}/manager`, {
      method: "POST",
      body: JSON.stringify({ manager: "TeamLead" }),
    });
    if (status !== 200) throw new Error(`set manager for ${name} → ${status}`);
  }
  console.log("Org chart staged: TeamLead → FrontendDev, QAEngineer, Researcher");

  // Pose statuses with synthetic hook events. Status derives from the last
  // hook event, so one POST repositions a badge without touching the agent.
  for (const m of CAST) {
    if (!m.pose) continue;
    const a = byName.get(m.name);
    if (!a) throw new Error(`pose: agent ${m.name} missing from /api/agents`);
    const { status } = await api(server, `/api/hooks/${a.id}`, {
      method: "POST",
      body: JSON.stringify({ ...m.pose, session_id: a.id }),
    });
    if (status !== 200) throw new Error(`pose ${m.name} → ${status}`);
  }
  console.log("Statuses posed: working / tool running / needs input / idle");

  return CAST.map((m) => {
    const a = byName.get(m.name);
    if (!a) throw new Error(`agent ${m.name} missing`);
    return a;
  });
}

// ── Web capture ──────────────────────────────────────────────────────

async function captureWeb(server: DemoServer, agents: AgentInfo[]): Promise<void> {
  console.log("Capturing web dashboard…");
  const browser = await chromium.launch();
  try {
    await captureWebPages(browser, server, agents);
  } finally {
    // Without this, any capture failure leaks a headless Chromium — the
    // outer teardown only knows about the server and temp dirs.
    await browser.close();
  }
}

async function captureWebPages(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  server: DemoServer,
  agents: AgentInfo[],
): Promise<void> {
  const context = await browser.newContext({
    // 1920×1080 at scale 1: a half-width pane fits ~80 terminal columns,
    // matching the hero agents' spawn cols so replayed output isn't clipped
    // (deviceScaleFactor 2 doubles glyph size and halves visible columns).
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    {
      name: "autonomos_token",
      value: server.token,
      url: `http://127.0.0.1:${server.port}`,
    },
  ]);

  // Seed theme + a ready-made split layout before the app boots: TeamLead
  // and FrontendDev side by side. Sidebar clicks replace the pane's only
  // tab (so drag-to-split can't be scripted from a fresh state), but the
  // layout tree is persisted state — seeding it is deterministic. The
  // store's merge() validates each persisted field individually, so a
  // partial state is safe.
  const lead = agents.find((a) => a.name === "TeamLead");
  const dev = agents.find((a) => a.name === "FrontendDev");
  if (!lead || !dev) throw new Error("TeamLead/FrontendDev missing for layout seed");
  const seed = JSON.stringify({
    state: {
      theme: "midnight",
      sidebarViewMode: "hierarchy",
      // activePane gates the whole workspace — SessionViewManager renders a
      // "Create or select an agent" placeholder when it's null, layout or not.
      activePane: { type: "session", id: lead.id },
      focusedLeafId: "leaf-demo-1",
      layout: {
        kind: "branch",
        id: "branch-demo-1",
        // "horizontal" = panes side by side (the split axis runs horizontal).
        direction: "horizontal",
        sizes: [50, 50],
        first: {
          kind: "leaf",
          id: "leaf-demo-1",
          tabs: [{ id: "tab-demo-1", pane: { type: "session", id: lead.id } }],
          activeTabIndex: 0,
        },
        second: {
          kind: "leaf",
          id: "leaf-demo-2",
          tabs: [{ id: "tab-demo-2", pane: { type: "session", id: dev.id } }],
          activeTabIndex: 0,
        },
      },
    },
    version: 0,
  });
  await context.addInitScript((s: string) => {
    localStorage.setItem("autonomos", s);
  }, seed);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);

  // Both panes' tabs render, the terminals replay their output, and the
  // TUIs repaint once more after the PTY resize (SIGWINCH reflow) — give
  // that settle time or the capture catches half-clipped lines.
  await page.getByText("TeamLead").first().waitFor({ timeout: 15_000 });
  await sleep(7_000);
  await page.screenshot({ path: join(OUT_DIR, "dashboard-hero.png") });
  console.log("  ✓ dashboard-hero.png");

  // Org chart pane — the hierarchy view is its own capture. Verify the
  // chart actually rendered before shooting: a missed click would otherwise
  // ship a screenshot of the wrong view with a green exit code. Text
  // selectors are useless here (agent names also live as hidden terminal
  // buffer text), so wait for the 4th chart node card (HierarchyPanel's
  // backdrop-blur-sm card chrome) — all four agents present in the tree.
  await page.getByText("ORG CHART", { exact: false }).first().click();
  await page.locator("div.backdrop-blur-sm").nth(3).waitFor({ timeout: 10_000 });
  await sleep(1_500);
  await page.screenshot({ path: join(OUT_DIR, "org-chart.png") });
  console.log("  ✓ org-chart.png");
}

// ── Teardown ─────────────────────────────────────────────────────────
// Each step is isolated: teardown also runs in error paths where the server
// may already be dead, and a throw here would mask the original failure and
// leak everything downstream. All cleanup stays scoped — agents via their
// own API, the child by PID, rm only on mkdtemp-created dirs.

async function teardown(server: DemoServer, agents: AgentInfo[], workspace: string): Promise<void> {
  shuttingDown = true;
  console.log("Tearing down (scoped — agents via API, server by PID)…");

  // Agents first, via their own API. ?force=true orphans children to root,
  // so delete order doesn't matter. If staging failed before the agent list
  // was captured, ask the isolated server what exists — everything inside
  // this config dir belongs to the harness.
  try {
    let list = agents;
    if (list.length === 0) {
      const res = await api<AgentInfo[]>(server, "/api/agents");
      if (res.status === 200) list = res.body;
    }
    for (const a of list) {
      const { status } = await api(server, `/api/agents/${a.id}?force=true`, {
        method: "DELETE",
      });
      if (status !== 200) console.warn(`teardown: DELETE ${a.name} → ${status}`);
    }
  } catch (err) {
    console.warn(
      `teardown: agent cleanup failed (server already down?): ${err instanceof Error ? err.message : err}`,
    );
  }

  // SIGTERM the child and wait for the real exit before removing its config
  // dir — escalate to SIGKILL rather than deleting state out from under a
  // live process.
  try {
    if (server.child.exitCode === null) {
      const exited = new Promise<void>((r) => server.child.once("exit", () => r()));
      server.kill();
      const result = await Promise.race([
        exited.then(() => "exited" as const),
        sleep(5_000).then(() => "timeout" as const),
      ]);
      if (result === "timeout") {
        console.warn("teardown: server ignored SIGTERM for 5s — escalating to SIGKILL");
        server.child.kill("SIGKILL");
        await Promise.race([exited, sleep(2_000)]);
      }
    }
  } catch (err) {
    console.warn(`teardown: server kill failed: ${err instanceof Error ? err.message : err}`);
  }

  for (const dir of [server.configDir, server.fakeHome, workspace]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`teardown: rm ${dir} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Preflight
  const claude = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (claude.status !== 0) {
    throw new Error("`claude` binary not on PATH — required to stage demo agents.");
  }
  if (!existsSync(join(DASHBOARD_DIR, "dist/index.html"))) {
    console.log("Dashboard dist missing — building…");
    const r = spawnSync("bun", ["--cwd", DASHBOARD_DIR, "run", "build"], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("dashboard build failed");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const mock = await startDemoMock();
  console.log(`Mock Anthropic backend: ${mock.url}`);
  const workspace = makeDemoWorkspace();
  const server = await bootServer(mock.url);
  console.log(`Demo server: http://127.0.0.1:${server.port} (config: ${server.configDir})`);

  let agents: AgentInfo[] = [];

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Guarded so a teardown error can never mask the original failure.
    try {
      await teardown(server, agents, workspace);
    } catch (err) {
      console.error("teardown failed:", err);
    }
    try {
      await mock.close();
    } catch {
      // In-process server; dies with us anyway.
    }
  };

  // Ctrl-C must tear down explicitly: node-pty puts the claude agents in
  // their own sessions, so they never receive the terminal's SIGINT and
  // would outlive the harness. This is also the ONLY teardown path in
  // --keep mode.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} — tearing down…`);
      void cleanup().then(() => process.exit(130));
    });
  }

  try {
    agents = await stageScene(server, mock, workspace);
    await captureWeb(server, agents);

    if (KEEP_ALIVE) {
      console.log(
        `\n--keep: demo server stays up at http://127.0.0.1:${server.port}/?token=${server.token}\nCtrl-C to stop.`,
      );
      await new Promise(() => {}); // hold until a signal triggers cleanup
    }
  } catch (err) {
    // The server log is the single most useful diagnostic and would
    // otherwise be discarded silently.
    console.error(`Run failed — server logs:\n${server.logs()}`);
    throw err;
  } finally {
    if (!KEEP_ALIVE) await cleanup();
  }
  console.log(`\nDone. Assets in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
