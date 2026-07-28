/**
 * capture-hero — the README/marketing hero-shot generator for autonomOS.
 *
 * PRODUCES: docs/assets/hero.png — the 3-pane dashboard shot COMPOSITED into a
 * macOS/PWA "polaroid" window frame (title bar + traffic-light dots, matted on a
 * dark radial-gradient). The dashboard content proves the multi-CLI story:
 *   (left)         org-chart hierarchy — mixed provider icons (Claude + Codex +
 *                  Gemini), the money shot for "orchestrate any coding agent"
 *   (top-right)    a LIVE Claude Code terminal  (real turn, subscription OAuth)
 *   (bottom-right) a LIVE Codex terminal         (real codex app-server turn)
 * Gemini appears in the ORG CHART / agents list ONLY (its own icon + a clean
 * status) — no Gemini terminal is shown, so no Gemini auth is required for a
 * good shot (see PROVIDERS below).
 *
 * The pipeline screenshots the dashboard to a TEMP raw png, then frameMacWindow
 * composites it into the window frame → the final docs/assets/hero.png.
 *
 * HOW TO RUN:
 *   make hero
 *   # or:
 *   bun --cwd packages/dashboard run capture-hero
 * Output can be redirected with HERO_OUT_DIR; viewport via HERO_W / HERO_H
 * (default 1680×920, deviceScaleFactor 1 — dsf 2 breaks the xterm fit).
 *
 * PREREQUISITES:
 *   - playwright-core + a Chromium install (bundled via the dashboard's
 *     @playwright/test dependency; run `bunx playwright install chromium` once).
 *   - `claude` on PATH — REQUIRED. The base scene always renders with Claude.
 *   - The dashboard is auto-built (packages/dashboard/dist) if missing.
 *
 * PROVIDERS (Codex + Gemini are OPTIONAL — the tool degrades gracefully):
 *   - Claude  — REQUIRED binary. Real turns use the machine's Claude login
 *               (keychain OAuth token, else ~/.claude/.credentials.json). If NO
 *               Claude credentials are found, it falls back to a local MOCK
 *               Anthropic backend serving canned replies, so the base scene
 *               still renders (zero tokens).
 *   - Codex   — OPTIONAL (`codex` binary + ~/.codex/auth.json). When present,
 *               the bottom-right terminal is a REAL Codex turn. When absent, that
 *               pane falls back to a second Claude terminal (real or mock).
 *   - Gemini  — OPTIONAL (`gemini` binary). When present, a Gemini agent is
 *               spawned ORG-CHART-ONLY (no terminal) so its provider icon shows;
 *               it needs no auth (posed to a clean "working" status). When
 *               absent, it's simply omitted from the cast.
 *
 * CAPTURE-TIME TWEAKS (Playwright only — NOT product-code edits):
 *   - Un-dim: injects `.dv-pane-fill { opacity: 1 !important }` so inactive
 *     dockview groups (normally dimmed to 0.5) render bright.
 *   - Org fit: scales the HierarchyPanel tree down so the whole hierarchy fits
 *     the left pane (the tree centers + overflows rather than auto-fitting).
 *   - Host: route-mocks `/api/host` → hostname "dev-server" so the status bar
 *     reads a generic name instead of the operator's machine.
 *   - Gemini MCP is stripped from the generated Gemini settings so it sidesteps
 *     the Gemini→gateway auth reconnect loop (hooks stay on for status).
 *   - Viewport ~1680×920 at dsf 1 for legible fonts across three panes.
 *   - Frame: after capture, the raw screenshot is composited into a macOS/PWA
 *     window (frameMacWindow) — window + image sizes derive from the raw png's
 *     real pixel dims, so the frame tracks any viewport change automatically.
 *
 * SAFETY (load-bearing — the operator may run a LIVE autonomOS on :3100 with
 * their own real agents at HOME=<real home>):
 *   - Fully isolated: temp AUTONOMOS_CONFIG_DIR, a fake $HOME (seeded read-only
 *     with copies of the operator's creds, rm -rf'd on teardown), and an
 *     EPHEMERAL port (--port=0). It NEVER binds or touches :3100.
 *   - Teardown is scoped: agents are deleted via their own API, then a
 *     fake-HOME-scoped PID sweep reaps any daemon/TUI whose HOME is our temp
 *     home (Codex app-server, Gemini/Claude TUIs). Kills are BY PID with a
 *     HOME===fakeHome check — NEVER by process name — so the operator's real
 *     agents (HOME=<real home>) are never touched.
 *
 * DETERMINISM: the Claude + Codex turns are REAL model turns, so re-shoots are
 * SIMILAR, not pixel-identical (wording/timing vary). With no Claude creds the
 * mock path is deterministic. Re-run if a turn renders empty or off-message.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "@playwright/test";

// ── Paths — derived from the script location so this works from ANY checkout ──
// This file lives at <repo>/packages/dashboard/scripts/capture-hero.ts.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const DASHBOARD_DIR = join(REPO_ROOT, "packages/dashboard");
const SERVER_ENTRY = join(REPO_ROOT, "packages/server/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "packages/server/node_modules/.bin/tsx");
const OUT_DIR = process.env.HERO_OUT_DIR ?? join(REPO_ROOT, "docs/assets");

const REAL_HOME = homedir();
const REAL_CODEX_DIR = join(REAL_HOME, ".codex");
const REAL_GEMINI_DIR = join(REAL_HOME, ".gemini");
const REAL_CLAUDE_CREDS = join(REAL_HOME, ".claude", ".credentials.json");

const argv = process.argv.slice(2);
const KEEP_ALIVE = argv.includes("--keep");
// Three panes → ~1680 wide is legible; dsf 1 keeps the xterm fit intact.
const HERO_W = Number(process.env.HERO_W ?? 1680);
const HERO_H = Number(process.env.HERO_H ?? 920);
const HERO_DSF = Number(process.env.HERO_DSF ?? 1);
const HERO_ZOOM = Number(process.env.HERO_ZOOM ?? 1);

// ── Provider capabilities (drives graceful degradation) ──────────────────────
type Provider = "claude-code" | "codex" | "gemini-cli";

interface Caps {
  /** Claude can do REAL turns (keychain token or on-disk creds present). When
   *  false, Claude agents run against a local mock backend instead. */
  claudeCreds: boolean;
  /** `codex` binary + ~/.codex/auth.json present → real Codex terminal. */
  codex: boolean;
  /** `gemini` binary present → Gemini org-chart node (no auth needed). */
  gemini: boolean;
}

const onPath = (bin: string): boolean =>
  spawnSync("which", [bin], { encoding: "utf-8" }).status === 0;

/** Read the current Claude OAuth token from the macOS keychain (does NOT prompt
 *  for the Claude item). Returns the trimmed JSON blob, or null if absent. */
function readClaudeKeychainToken(): string | null {
  const kc = spawnSync(
    "security",
    [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      process.env.USER ?? "",
      "-w",
    ],
    { encoding: "utf-8", timeout: 3_000 },
  );
  if (kc.status !== 0) return null;
  const out = kc.stdout.trim();
  return out.startsWith("{") ? out : null;
}

function detectCaps(): Caps {
  if (!onPath("claude")) {
    throw new Error("`claude` not on PATH — required to render the base scene.");
  }
  // Claude creds: a keychain read (does NOT prompt for the Claude item) or the
  // on-disk credentials file. Either is enough for a real turn.
  const claudeCreds =
    readClaudeKeychainToken() !== null || existsSync(REAL_CLAUDE_CREDS);
  const codex = onPath("codex") && existsSync(join(REAL_CODEX_DIR, "auth.json"));
  const gemini = onPath("gemini");

  console.log(
    `Providers: claude=real${claudeCreds ? "" : "→MOCK (no creds)"} ` +
      `codex=${codex ? "real" : "unavailable→Claude fallback"} ` +
      `gemini=${gemini ? "org-chart-only" : "unavailable→omitted"}`,
  );
  if (!claudeCreds)
    console.warn(
      "No Claude credentials — Claude terminals use the local MOCK backend.",
    );
  if (!codex)
    console.warn(
      "Codex unavailable (missing binary or ~/.codex/auth.json) — the bottom " +
        "terminal falls back to a second Claude agent.",
    );
  if (!gemini)
    console.warn("Gemini unavailable (missing binary) — omitted from the org chart.");
  return { claudeCreds, codex, gemini };
}

// ── The cast (built from capabilities) ───────────────────────────────────────
interface CastMember {
  name: string;
  provider: Provider;
  cols?: number;
  rows?: number;
  /** REAL-turn prompt (Claude/Codex). Omit for a free, prompt-less org node. */
  prompt?: string;
  /** Canned reply served by the mock backend when this Claude agent runs
   *  without real creds. `matchKey` must be a substring of `prompt`. */
  mock?: { matchKey: string; reply: string };
  /** true → shown as a terminal pane in the hero (needs a rendered turn). */
  visible?: boolean;
  manager?: string;
  /** Hook events to pose a status badge. Claude uses CC-native names; Gemini
   *  uses Gemini-native names (normalizeEvent maps them). */
  pose?: Record<string, unknown>[];
}

const DISPATCHER_PROMPT =
  "You're the tech lead for demo-webapp (a Vite + React storefront with a payments API). This repo IS the single source of truth — treat its current state as complete and do NOT ask for other paths or add caveats/disclaimers. Based on README.md and src/payments/schema.ts, write a short, upbeat release roll-up for this week with two sections — 'Frontend squad' (dashboard redesign: split-pane layout + animated status badges) and 'Backend squad' (payments API: the /v1/charge flow). 2-3 confident bullets each. No code, just the roll-up.";

const CHARGE_PROMPT =
  "You are the API developer on this demo-webapp repo. Read src/payments/schema.ts, then give me a short design for the /v1/charge endpoint you'd add: cover idempotency, validation, and the success/failure responses. Keep it to about 6 lines. Do NOT write any files — just outline it.";

const DISPATCHER_MOCK_REPLY = [
  "Release roll-up — both squads shipping this week:",
  "",
  "  Frontend squad (dashboard redesign)",
  "    - Split-pane layout landed on the new dockview engine",
  "    - Animated status badges wired into the toolbar",
  "",
  "  Backend squad (payments API)",
  "    - Charge model settled with an idempotencyKey from day one",
  "    - /v1/charge handler cleared to build against a stable schema",
  "",
  "On track — I'll flag the moment the migration clears review.",
].join("\n");

const CHARGE_MOCK_REPLY = [
  "/v1/charge design:",
  "",
  "- POST /v1/charge takes { amount, currency } + an Idempotency-Key header",
  "- Validate: non-empty key, positive integer amount (minor units), ISO currency",
  "- Store by idempotency key; identical retries return the original result",
  "- 201 on success with the Charge; 409 on key reuse with a different payload",
  "- 400 on validation errors, 402 on decline, 500 on unexpected failures",
].join("\n");

/** Build the cast for the detected capabilities. Always: Dispatcher (visible
 *  Claude) + three org-only Claude leads/devs. Second visible terminal is Codex
 *  when available, else a Claude fallback. Gemini is appended org-chart-only
 *  when its binary is present. */
function buildCast(caps: Caps): CastMember[] {
  const cast: CastMember[] = [
    {
      name: "Dispatcher",
      provider: "claude-code",
      cols: 84,
      rows: 40,
      visible: true,
      prompt: DISPATCHER_PROMPT,
      mock: { matchKey: "release roll-up", reply: DISPATCHER_MOCK_REPLY },
    },
    {
      name: "FrontendLead",
      provider: "claude-code",
      manager: "Dispatcher",
      pose: [
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "src/layout/SplitPane.tsx" },
        },
      ],
    },
    {
      name: "BackendLead",
      provider: "claude-code",
      manager: "Dispatcher",
      pose: [
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Edit",
          tool_input: { file_path: "src/payments/migrate.ts" },
        },
      ],
    },
    {
      name: "UIDeveloper",
      provider: "claude-code",
      manager: "FrontendLead",
      pose: [{ hook_event_name: "UserPromptSubmit", prompt: "working" }],
    },
  ];

  // Second visible terminal: real Codex, else a Claude fallback (real or mock).
  if (caps.codex) {
    cast.push({
      name: "APIDeveloper",
      provider: "codex",
      manager: "BackendLead",
      cols: 96,
      rows: 34,
      visible: true,
      prompt: CHARGE_PROMPT,
    });
  } else {
    cast.push({
      name: "APIDeveloper",
      provider: "claude-code",
      manager: "BackendLead",
      cols: 96,
      rows: 34,
      visible: true,
      prompt: CHARGE_PROMPT,
      mock: { matchKey: "/v1/charge endpoint", reply: CHARGE_MOCK_REPLY },
    });
  }

  // Gemini — ORG CHART ONLY. Prompt-less so it registers with the Gemini icon
  // and needs no auth; posed to "working" via the Gemini-native `BeforeAgent`
  // event (→ UserPromptSubmit → working) so it reads clean, not errored.
  if (caps.gemini) {
    cast.push({
      name: "QAEngineer",
      provider: "gemini-cli",
      manager: "BackendLead",
      pose: [{ hook_event_name: "BeforeAgent" }],
    });
  }

  return cast;
}

// ── Mock Anthropic /v1/messages SSE backend (used only when Claude has no creds)
function sse(res: ServerResponse, ev: string, data: unknown): void {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamText(res: ServerResponse, text: string): void {
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
    content_block: { type: "text", text: "" },
  });
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

interface DemoMock {
  url: string;
  served: () => ReadonlyMap<string, number>;
  close: () => Promise<void>;
}

/** Local stand-in for the Anthropic SSE endpoint. Matches each request body
 *  against a cast member's `mock.matchKey` and streams its canned reply. */
function startDemoMock(cast: CastMember[]): Promise<DemoMock> {
  const canned = cast.filter((m) => m.mock);
  const served = new Map<string, number>();

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
        const member = canned.find((m) => raw.includes(m.mock!.matchKey));
        if (member) {
          streamText(res, member.mock!.reply);
          // Count only after the stream completed (res.end inside streamText) —
          // a throw mid-stream must NOT mark the turn as rendered.
          served.set(member.name, (served.get(member.name) ?? 0) + 1);
        } else {
          streamText(res, "Standing by.");
        }
        return;
      }
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
        served: () => served,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ── Demo workspace (agents' cwd) ─────────────────────────────────────────────
function makeDemoWorkspace(): string {
  const dir = join(
    mkdtempSync(join(tmpdir(), "autonomos-capture-")),
    "demo-webapp",
  );
  mkdirSync(join(dir, "src/layout"), { recursive: true });
  mkdirSync(join(dir, "src/components"), { recursive: true });
  mkdirSync(join(dir, "src/payments"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    "# demo-webapp\n\nA web storefront. Vite + React + a payments API.\n\n" +
      "## Squads\n- Frontend: dashboard redesign (split-pane layout, animated status badges)\n" +
      "- Backend: payments API migration (the /v1/charge flow)\n",
  );
  writeFileSync(
    join(dir, "src/layout/SplitPane.tsx"),
    "export function SplitPane({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {\n" +
      '  return <div className="split">{left}{right}</div>;\n}\n',
  );
  writeFileSync(
    join(dir, "src/components/Toolbar.tsx"),
    'export function Toolbar() {\n  // TODO: animated status badges\n  return <nav className="toolbar" />;\n}\n',
  );
  writeFileSync(
    join(dir, "src/payments/schema.ts"),
    "export interface Charge {\n  id: string;\n  amount: number;\n  currency: string;\n  idempotencyKey: string;\n}\n",
  );
  return dir;
}

// ── Server boot ──────────────────────────────────────────────────────────────
interface DemoServer {
  port: number;
  token: string;
  configDir: string;
  fakeHome: string;
  child: ChildProcess;
  logs: () => string;
  kill: () => void;
}

/** Temp dirs + child registered AS bootServer creates them, so a throw or
 *  Ctrl-C mid-boot (before a full DemoServer exists) can still reap the
 *  partially-constructed, credential-bearing state. */
interface Resources {
  configDir?: string;
  fakeHome?: string;
  workspace?: string;
  child?: ChildProcess;
}

let shuttingDown = false;

/** Copy the current Claude keychain OAuth token into the fake home's
 *  credentials file (the on-disk file can be weeks stale). Read-only in the
 *  real store. Best-effort: warns and continues if nothing is found. */
function seedClaudeToken(fakeHome: string): void {
  const dst = join(fakeHome, ".claude", ".credentials.json");
  const fresh = readClaudeKeychainToken();
  if (fresh) {
    writeFileSync(dst, fresh);
    chmodSync(dst, 0o600);
    console.log("Seeded fake HOME with the current keychain OAuth token (Claude)");
  } else if (existsSync(REAL_CLAUDE_CREDS)) {
    copyFileSync(REAL_CLAUDE_CREDS, dst);
    chmodSync(dst, 0o600);
    console.warn("Keychain token unavailable — copied on-disk creds (may be stale).");
  } else {
    console.warn("No Claude OAuth token — relying on the mock backend.");
  }
}

async function bootServer(
  workspace: string,
  caps: Caps,
  mockUrl: string | undefined,
  resources: Resources,
): Promise<DemoServer> {
  const configDir = mkdtempSync(join(tmpdir(), "autonomos-demo-"));
  resources.configDir = configDir; // register for interrupt-safe cleanup
  const token = `demo-${Math.random().toString(36).slice(2, 10)}`;

  writeFileSync(
    join(configDir, "settings.json"),
    `${JSON.stringify(
      // channels:[] → injectChannelServer false for every provider (no MCP).
      { channels: [], autoTrust: true, statusLine: { enabled: false } },
      null,
      2,
    )}\n`,
  );

  // Fake HOME — isolate the operator's real ~/.claude out of the shot and route
  // demo agents' session state here. Seed onboarding + bypass flags so a fresh
  // claude skips prompts.
  const fakeHome = mkdtempSync(join(tmpdir(), "autonomos-demo-home-"));
  resources.fakeHome = fakeHome; // register BEFORE seeding creds into it
  mkdirSync(join(fakeHome, ".claude", "projects"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
    }),
  );
  seedClaudeToken(fakeHome);

  // Codex auth (auth.json + config.toml) → fakeHome/.codex — only if available.
  if (caps.codex) {
    const fakeCodex = join(fakeHome, ".codex");
    mkdirSync(fakeCodex, { recursive: true });
    for (const f of ["auth.json", "config.toml"]) {
      const src = join(REAL_CODEX_DIR, f);
      if (existsSync(src)) {
        const dst = join(fakeCodex, f);
        copyFileSync(src, dst);
        chmodSync(dst, 0o600);
      }
    }
    appendFileSync(
      join(fakeCodex, "config.toml"),
      `\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
    );
    console.log("Seeded fake HOME with ~/.codex auth");
  }

  // Gemini home (whole ~/.gemini) → only if available. Gemini is org-chart-only
  // so this is best-effort; a missing/partial copy just means it may prompt for
  // a key in its (hidden) terminal — its org-chart node + posed status are fine.
  if (caps.gemini && existsSync(REAL_GEMINI_DIR)) {
    try {
      cpSync(REAL_GEMINI_DIR, join(fakeHome, ".gemini"), { recursive: true });
      console.log("Seeded fake HOME with ~/.gemini");
    } catch (err) {
      console.warn(`Could not copy ~/.gemini (non-fatal): ${err}`);
    }
  }

  const claudeBin = spawnSync("which", ["claude"], {
    encoding: "utf-8",
  }).stdout.trim();
  if (claudeBin) {
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
    symlinkSync(claudeBin, join(fakeHome, ".local", "bin", "claude"));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    AUTONOMOS_CONFIG_DIR: configDir,
    AUTONOMOS_TOKEN: token,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CODEX_HOME; // force Codex to read fakeHome/.codex
  delete env.CLAUDE_CONFIG_DIR; // force claude-usage file fallback to fakeHome/.claude

  if (mockUrl) {
    // No Claude creds → point Claude at the local mock backend (zero tokens).
    env.ANTHROPIC_BASE_URL = mockUrl;
    env.ANTHROPIC_AUTH_TOKEN = "sk-demo";
    console.log(`Claude → mock backend at ${mockUrl}`);
  } else {
    // Real Claude subscription OAuth — strip any inherited override.
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  // Gemini auth passthrough (org-chart-only, so non-fatal). This install may
  // store the key in the keychain behind an ACL prompt that headless reads
  // can't satisfy; pass GEMINI_API_KEY through if present, else try a short
  // keychain read that only succeeds once "Always Allow" was approved.
  if (caps.gemini && !env.GEMINI_API_KEY) {
    const g = spawnSync(
      "security",
      ["find-generic-password", "-s", "gemini-cli-api-key", "-w"],
      { encoding: "utf-8", timeout: 4_000 },
    );
    if (g.status === 0 && g.stdout.trim()) {
      env.GEMINI_API_KEY = g.stdout.trim();
      console.log("Injected GEMINI_API_KEY from keychain (Gemini auth)");
    }
  }

  const child = spawn(TSX_BIN, [SERVER_ENTRY, "--port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  resources.child = child; // register so a readiness-timeout throw won't orphan it

  const out: string[] = [];
  child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => out.push(d.toString()));

  const port = await new Promise<number>((resolveFn, rejectFn) => {
    const fail = (err: Error): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
      rejectFn(err);
    };
    const timer = setTimeout(
      () => fail(new Error(`server not ready in 25s:\n${out.join("")}`)),
      25_000,
    );
    const onData = (): void => {
      const m = out
        .join("")
        .match(/autonomOS server listening on https?:\/\/[^\s:]+:(\d+)/);
      if (m) {
        child.stdout?.off("data", onData);
        clearTimeout(timer);
        resolveFn(Number(m[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", (err) =>
      fail(new Error(`server spawn failed (tsx at ${TSX_BIN}?): ${err.message}`)),
    );
    child.once("exit", (code) =>
      fail(new Error(`server exited (code=${code}) before ready:\n${out.join("")}`)),
    );
  });

  child.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(`server exited unexpectedly (code=${code})\n${out.join("")}`);
    }
  });

  // Strip the autonomos MCP server from the Gemini settings file the server
  // wrote on boot — leave hooks (status) intact. Without this, Gemini would try
  // to connect the channel server → gateway auth reconnect loop pollutes its TUI.
  if (caps.gemini) {
    const geminiSettings = join(configDir, "gemini-settings.json");
    if (existsSync(geminiSettings)) {
      try {
        const s = JSON.parse(readFileSync(geminiSettings, "utf-8"));
        delete s.mcpServers;
        writeFileSync(geminiSettings, JSON.stringify(s, null, 2), { mode: 0o600 });
        console.log("Stripped mcpServers from Gemini settings (MCP disabled)");
      } catch (err) {
        console.warn(`Could not strip Gemini mcpServers: ${err}`);
      }
    }
  }

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

// ── API helpers ──────────────────────────────────────────────────────────────
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

async function warmUsage(server: DemoServer, label: string): Promise<void> {
  try {
    const { status, body } = await api<Record<string, unknown>>(
      server,
      "/api/plugins/claude-usage",
    );
    const b = body as { error?: string; needsSetup?: boolean; fiveHour?: unknown };
    let summary: string;
    if (b.error) summary = `error: ${b.error}`;
    else if (b.needsSetup) summary = "needsSetup";
    else if (b.fiveHour) summary = `fiveHour=${JSON.stringify(b.fiveHour)}`;
    else summary = "no-data";
    console.log(`  claude-usage[${label}] ${status}: ${summary}`);
  } catch (err) {
    console.warn(`  claude-usage[${label}] failed: ${err}`);
  }
}

async function warmCodexUsage(server: DemoServer, label: string): Promise<void> {
  try {
    const { status, body } = await api<Record<string, unknown>>(
      server,
      "/api/plugins/codex-usage",
    );
    const b = body as {
      error?: string;
      needsData?: boolean;
      primary?: unknown;
      secondary?: unknown;
    };
    let summary: string;
    if (b.error) summary = `error: ${b.error}`;
    else if (b.needsData) summary = "needsData";
    else if (b.primary || b.secondary)
      summary = `primary=${JSON.stringify(b.primary)} secondary=${JSON.stringify(b.secondary)}`;
    else summary = "no-windows";
    console.log(`  codex-usage[${label}] ${status}: ${summary}`);
  } catch (err) {
    console.warn(`  codex-usage[${label}] failed: ${err}`);
  }
}

/** Scan a fake-home JSONL tree for a substring proving a real assistant turn. */
function jsonlTreeHas(root: string, needle: string): boolean {
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith(".jsonl")) {
        try {
          if (readFileSync(full, "utf-8").includes(needle)) return true;
        } catch {
          /* mid-write */
        }
      }
    }
  }
  return false;
}

const codexProducedOutput = (fakeHome: string): boolean =>
  jsonlTreeHas(join(fakeHome, ".codex", "sessions"), "agent_message");
const claudeProducedOutput = (fakeHome: string): boolean =>
  jsonlTreeHas(join(fakeHome, ".claude", "projects"), '"type":"assistant"');

// ── Scene staging ────────────────────────────────────────────────────────────
interface AgentInfo {
  id: string;
  name: string;
  status: string;
  provider?: string;
}

/** The internal control socket path — hook INGEST moved off the HTTP port onto
 *  this Unix socket (ADR-055), so status poses must go here, not to
 *  `POST /api/hooks` on the TCP port (which now only serves hook READS → 404).
 *  Parsed from the boot log, with a fallback to `$configDir/control.sock`. */
function controlSocketPath(server: DemoServer): string {
  const m = server.logs().match(/control socket ready at (\S+)/);
  return m ? m[1] : join(server.configDir, "control.sock");
}

/** POST a synthetic hook event to the internal control socket to pose an
 *  agent's status badge. The socket is the auth boundary (no token needed — same
 *  as the agents' own `curl --unix-socket` hook relay). Resolves the HTTP
 *  status; the caller treats non-200 as non-fatal. */
function poseHook(
  socketPath: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...event, session_id: sessionId });
    const req = httpRequest(
      {
        socketPath,
        path: `/api/hooks/${sessionId}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume(); // drain
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function stageScene(
  server: DemoServer,
  cast: CastMember[],
  caps: Caps,
  mock: DemoMock,
  workspace: string,
): Promise<AgentInfo[]> {
  await warmUsage(server, "boot");
  if (caps.codex) await warmCodexUsage(server, "boot");

  console.log(`Spawning ${cast.length} agents…`);
  await Promise.all(
    cast.map(async (m) => {
      const { status, body } = await api<{ id?: string; error?: string }>(
        server,
        "/api/agents",
        {
          method: "POST",
          body: JSON.stringify({
            name: m.name,
            workingDirectory: workspace,
            provider: m.provider,
            permissionMode: "bypass",
            ...(m.prompt ? { prompt: m.prompt } : {}),
            ...(m.cols ? { cols: m.cols, rows: m.rows ?? 40 } : {}),
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
    throw new Error(`GET /api/agents → ${agentsRes.status}`);
  }
  const byName = new Map(agentsRes.body.map((a) => [a.name, a]));
  const idOf = (name: string): string => {
    const a = byName.get(name);
    if (!a) throw new Error(`agent ${name} missing after spawn`);
    return a.id;
  };

  // Wait for the two SHOWN turns to render. Per visible agent: Codex → rollout
  // agent_message; real Claude → assistant JSONL; mock Claude → served count.
  //
  // FUTURE HARDENING (deferred follow-ups, tracked separately):
  //   #2 scope each turn check to THIS agent's session-id instead of the current
  //      any-assistant-JSONL / any-codex-rollout scan (a coarse OR across agents).
  //   #4 assert the terminal panes actually rendered non-empty CONTENT (not just
  //      that a turn was recorded server-side) before capturing.
  const visible = cast.filter((m) => m.visible);
  const turnOk = (m: CastMember): boolean => {
    if (m.provider === "codex") return codexProducedOutput(server.fakeHome);
    if (caps.claudeCreds) return claudeProducedOutput(server.fakeHome);
    return (mock.served().get(m.name) ?? 0) >= 1; // mock-backed Claude
  };
  console.log(`Waiting for ${visible.length} shown turns to render…`);
  const start = Date.now();
  const deadline = start + 200_000;
  let allRendered = false;
  while (Date.now() < deadline) {
    const done = visible.map((m) => `${m.name}=${turnOk(m) ? "y" : "n"}`);
    console.log(`  turns: ${done.join(" ")} t=${((Date.now() - start) / 1000).toFixed(0)}s`);
    if (visible.every(turnOk)) {
      allRendered = true;
      break;
    }
    await sleep(3_000);
  }
  if (!allRendered) {
    // Loud failure beats a blank committed hero — never screenshot empty panes.
    const map = visible.map((m) => `${m.name}=${turnOk(m) ? "y" : "n"}`).join(" ");
    throw new Error(
      `Shown turns did not render within ${((deadline - start) / 1000).toFixed(0)}s (${map}).\n` +
        `--- server logs ---\n${server.logs()}`,
    );
  }
  await sleep(8_000); // let the TUIs paint + settle

  // Org chart: assign managers.
  for (const m of cast) {
    if (!m.manager) continue;
    const { status } = await api(server, `/api/agents/${idOf(m.name)}/manager`, {
      method: "POST",
      body: JSON.stringify({ manager: m.manager }),
    });
    if (status !== 200)
      throw new Error(`set manager ${m.name}→${m.manager} → ${status}`);
  }
  console.log("Org chart wired");

  // Pose status badges via the internal control socket (Claude CC-native events;
  // Gemini Gemini-native events — the ingest router maps each provider's
  // vocabulary via normalizeEvent). Best-effort: badges are cosmetic, so a pose
  // failure warns rather than aborting the (expensive) capture.
  const socketPath = controlSocketPath(server);
  for (const m of cast) {
    if (!m.pose) continue;
    for (const ev of m.pose) {
      try {
        const status = await poseHook(socketPath, idOf(m.name), ev);
        if (status !== 200) console.warn(`pose ${m.name} → ${status} (non-fatal)`);
      } catch (err) {
        console.warn(`pose ${m.name} failed (non-fatal): ${err}`);
      }
      await sleep(120);
    }
  }

  await warmUsage(server, "pre-capture");
  if (caps.codex) await warmCodexUsage(server, "pre-capture");

  return cast.map((m) => byName.get(m.name) as AgentInfo);
}

// ── Web capture ──────────────────────────────────────────────────────────────
const THEME = "midnight"; // dark navy theme (#0a0e14 bg) — see store.ts THEMES
const VIEWPORT = { width: HERO_W, height: HERO_H };

type PaneObj =
  | { type: "session"; id: string }
  | { type: "orgchart"; id: "orgchart" };

/** 3-pane dockview: org chart LEFT, two terminals stacked on the RIGHT (top
 *  over bottom). A left leaf + a right vertical branch under a horizontal root.
 *  A slightly-off blob degrades gracefully (fromJSON failure → solo activePane). */
function seedBlob3(
  activePane: PaneObj,
  left: { id: string; pane: PaneObj },
  rightTop: { id: string; pane: PaneObj },
  rightBottom: { id: string; pane: PaneObj },
): string {
  const wsId = "ws-hero";
  const W = HERO_W;
  const H = HERO_H;
  const leftW = Math.round(W * 0.46);
  const rightW = W - leftW;
  const topH = Math.round(H * 0.5);
  const botH = H - topH;

  const leaf = (id: string, gid: string, size: number) => ({
    type: "leaf",
    size,
    data: { views: [id], activeView: id, id: gid },
  });
  const panel = (p: { id: string; pane: PaneObj }) => ({
    id: p.id,
    contentComponent: "pane",
    tabComponent: "status",
    params: { pane: p.pane },
  });

  const serialized = {
    grid: {
      root: {
        type: "branch",
        data: [
          leaf(left.id, "grp-org", leftW),
          {
            type: "branch",
            size: rightW,
            data: [
              leaf(rightTop.id, "grp-top", topH),
              leaf(rightBottom.id, "grp-bot", botH),
            ],
          },
        ],
        size: H,
      },
      height: H,
      width: W,
      orientation: "HORIZONTAL",
    },
    panels: {
      [left.id]: panel(left),
      [rightTop.id]: panel(rightTop),
      [rightBottom.id]: panel(rightBottom),
    },
    activeGroup: "grp-top",
  };

  const paneIds = [left.id, rightTop.id, rightBottom.id];
  const state: Record<string, unknown> = {
    theme: THEME,
    sidebarViewMode: "hierarchy",
    sidebarViewModeExplicit: true,
    activePane,
    dvWorkspaces: { [wsId]: { paneIds, serialized } },
    dvPaneWorkspace: Object.fromEntries(paneIds.map((id) => [id, wsId])),
  };
  return JSON.stringify({ state, version: 0 });
}

// Force ALL dockview panes to full brightness (product dims inactive groups to
// opacity 0.5 on .dv-pane-fill) — capture-time visual only.
const UNDIM_CSS = ".dv-pane-fill { opacity: 1 !important; }";

// The org-chart tree (HierarchyPanel) centers + overflows its pane rather than
// fitting; scale it down a touch so the whole hierarchy (all provider icons)
// fits inside the narrower left pane. Capture-time visual only.
const ORG_FIT_CSS =
  ".overflow-auto.p-8 > .flex.flex-col.gap-12 { transform: scale(0.8) !important; transform-origin: top center !important; }";

async function shoot(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  server: DemoServer,
  seed: string,
  opts: {
    /** Absolute path for the RAW dashboard screenshot (later composited into
     *  the macOS-window frame by frameMacWindow). */
    outPath: string;
    waitOrgNodes: number;
    settleMs: number;
    /** Minimum dockview panes + xterm terminals that must exist before the
     *  screenshot — the guard against a drifted blob degrading to a solo pane. */
    expectPanes: number;
    expectTerminals: number;
  },
): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: HERO_DSF,
  });
  try {
    await context.addCookies([
      {
        name: "autonomos_token",
        value: server.token,
        url: `http://127.0.0.1:${server.port}`,
      },
    ]);
    await context.addInitScript((s: string) => {
      localStorage.setItem("autonomos", s);
    }, seed);

    const page = await context.newPage();

    // If seedBlob3 drifts from the dockview schema, api.fromJSON throws IN the
    // browser, DockviewLayout degrades to a solo pane and only logs to the
    // browser console — which a screenshot would silently bless. Capture that
    // line and fail the run. (Guards the "a future agent changes the UI" case.)
    let dockviewError: string | null = null;
    page.on("console", (msg) => {
      const t = msg.text();
      if (t.includes("dockview workspace restore failed")) dockviewError = t;
    });

    // Rewrite /api/host → generic "dev-server" (preserve the rest of the shape
    // so the health probe stays green and dashboardFreshness matches).
    await page.route("**/api/host", async (route) => {
      try {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
          response: res,
          json: { ...body, hostname: "dev-server" },
        });
      } catch (err) {
        console.warn(
          `/api/host route-mock: upstream fetch failed, sending minimal ` +
            `{hostname} body (dashboardFreshness check may not match): ${err}`,
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ hostname: "dev-server" }),
        });
      }
    });

    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page
      .locator("div.backdrop-blur-sm")
      .nth(opts.waitOrgNodes)
      .waitFor({ timeout: 15_000 });
    await page.addStyleTag({ content: UNDIM_CSS + ORG_FIT_CSS });
    if (HERO_ZOOM !== 1) {
      await page.evaluate((z: number) => {
        (document.body.style as unknown as { zoom: string }).zoom = String(z);
      }, HERO_ZOOM);
      await sleep(400);
    }
    await sleep(opts.settleMs);
    // Re-assert the overrides in case a late re-render re-inlined opacity.
    await page.addStyleTag({ content: UNDIM_CSS + ORG_FIT_CSS });

    // Drift guards — fail loudly instead of committing a broken hero.
    if (dockviewError) {
      throw new Error(
        `dockview workspace restore failed in-browser (blob drift → solo ` +
          `fallback): ${dockviewError}`,
      );
    }
    const dom = await page.evaluate(() => ({
      panes: document.querySelectorAll(".dv-pane-fill").length,
      terminals: document.querySelectorAll(".xterm").length,
    }));
    if (dom.panes < opts.expectPanes || dom.terminals < opts.expectTerminals) {
      throw new Error(
        `Layout drift: expected ≥${opts.expectPanes} dockview panes and ` +
          `≥${opts.expectTerminals} terminals, got panes=${dom.panes} ` +
          `terminals=${dom.terminals} — the dockview blob likely degraded to a ` +
          `solo pane. Refusing to screenshot.`,
      );
    }

    await page.screenshot({ path: opts.outPath });
    console.log("  ✓ raw dashboard capture");
  } finally {
    await context.close();
  }
}

/** Read a PNG's real pixel dimensions from its IHDR header (width @ byte 16,
 *  height @ byte 20, big-endian) — no decode needed. Drives the window + image
 *  size in the frame so it stays correct if the capture viewport ever changes. */
function pngDimensions(buf: Buffer): { w: number; h: number } {
  const PNG_SIG = "89504e470d0a1a0a";
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== PNG_SIG) {
    throw new Error("frameMacWindow: raw capture is not a valid PNG");
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Composite the raw dashboard screenshot into the macOS/PWA "polaroid" window
 *  frame (V1 design) → destPngPath. Reuses the Playwright browser context; opens
 *  a fresh page, base64-embeds the raw png, waits for it to decode, then
 *  screenshots the `.mat` element. Window/image sizes derive from the raw png's
 *  real dimensions (never hardcoded). */
async function frameMacWindow(
  context: BrowserContext,
  rawPngPath: string,
  destPngPath: string,
): Promise<void> {
  const raw = readFileSync(rawPngPath);
  const { w, h } = pngDimensions(raw);
  const b64 = raw.toString("base64");

  // V1 frame — matches the design Terry picked; edit with care.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
.mat{ padding:92px 100px 112px; background:radial-gradient(120% 130% at 50% 0%, #12161d 0%, #05070b 70%); display:inline-block; }
.win{ width:${w}px; border-radius:15px; overflow:hidden; border:1px solid rgba(255,255,255,.08);
  box-shadow:0 2px 0 rgba(255,255,255,.05) inset, 0 60px 120px rgba(0,0,0,.6), 0 24px 48px rgba(0,0,0,.45); }
.bar{ height:40px; background:#0a0e14; display:flex; align-items:center; gap:9px; padding:0 17px; }
.dot{ width:13px; height:13px; border-radius:50% }
.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
.shot{ display:block; width:${w}px; height:${h}px }
</style></head><body>
<div class="mat"><div class="win">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
  <img class="shot" src="data:image/png;base64,${b64}">
</div></div>
</body></html>`;

  const page = await context.newPage();
  try {
    // Size the viewport to comfortably contain the mat (padding: 200px wide,
    // 204px tall) so the element screenshot never clips.
    await page.setViewportSize({ width: w + 240, height: h + 260 });
    await page.setContent(html, { waitUntil: "load" });
    // Wait for the embedded image to actually decode before capturing.
    await page.waitForFunction(
      () => {
        const img = document.querySelector("img.shot") as HTMLImageElement | null;
        return !!img && img.complete && img.naturalWidth > 0;
      },
      { timeout: 15_000 },
    );
    await page.locator(".mat").screenshot({ path: destPngPath });
    console.log(`  ✓ framed hero → ${destPngPath}`);
  } finally {
    await page.close();
  }
}

async function captureWeb(
  server: DemoServer,
  agents: AgentInfo[],
  cast: CastMember[],
): Promise<void> {
  console.log("Capturing hero…");
  const visibleNames = cast.filter((m) => m.visible).map((m) => m.name);
  const top = agents.find((a) => a.name === visibleNames[0]);
  const bottom = agents.find((a) => a.name === visibleNames[1]);
  if (!top || !bottom) throw new Error("visible agents missing for capture");

  const orgPane: PaneObj = { type: "orgchart", id: "orgchart" };
  const topPane: PaneObj = { type: "session", id: top.id };
  const bottomPane: PaneObj = { type: "session", id: bottom.id };

  // Capture the dashboard to a TEMP raw png, then composite it into the
  // macOS-window frame → docs/assets/hero.png (the committed, framed hero).
  const rawPath = join(
    tmpdir(),
    `autonomos-hero-raw-${Math.random().toString(36).slice(2, 10)}.png`,
  );
  const destPath = join(OUT_DIR, "hero.png");

  const browser = await chromium.launch();
  try {
    // org chart LEFT · Claude terminal TOP-RIGHT · Codex/Claude BOTTOM-RIGHT.
    await shoot(
      browser,
      server,
      seedBlob3(
        orgPane,
        { id: "orgchart", pane: orgPane },
        { id: top.id, pane: topPane },
        { id: bottom.id, pane: bottomPane },
      ),
      {
        outPath: rawPath,
        waitOrgNodes: Math.min(cast.length - 1, 5),
        settleMs: 10_000,
        // org chart + 2 terminals; both terminal panes must have rendered.
        expectPanes: 3,
        expectTerminals: 2,
      },
    );

    // Frame the raw capture in the macOS/PWA window (fresh context + page).
    const frameCtx = await browser.newContext({ deviceScaleFactor: HERO_DSF });
    try {
      await frameMacWindow(frameCtx, rawPath, destPath);
    } finally {
      await frameCtx.close();
    }
  } finally {
    await browser.close();
    try {
      rmSync(rawPath, { force: true });
    } catch (err) {
      console.warn(`captureWeb: could not remove temp raw png: ${err}`);
    }
  }
}

// ── Teardown ─────────────────────────────────────────────────────────────────
/** Every descendant pid of rootPid (via ps -Ao pid,ppid). */
function descendantPids(rootPid: number): number[] {
  let out: string;
  try {
    out = spawnSync("ps", ["-Ao", "pid,ppid"], { encoding: "utf-8" }).stdout;
  } catch (err) {
    console.warn(`teardown: descendantPids ps failed (tree sweep skipped): ${err}`);
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/);
    if (!m) continue;
    const ppid = Number(m[2]);
    const arr = children.get(ppid) ?? [];
    arr.push(Number(m[1]));
    children.set(ppid, arr);
  }
  const collected: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop() as number;
    for (const c of children.get(pid) ?? []) {
      collected.push(c);
      stack.push(c);
    }
  }
  return collected;
}

/** PIDs whose HOME env equals fakeHome — our codex/gemini/claude/node procs,
 *  regardless of reparenting. The command-name filter only narrows the (costly)
 *  `ps eww` candidate set; the KILL criterion is strictly HOME === fakeHome, so
 *  the operator's real agents (HOME=<real home>) are never touched. */
function fakeHomePids(fakeHome: string): number[] {
  let listing: string;
  try {
    listing = spawnSync("ps", ["-Ao", "pid,command"], { encoding: "utf-8" }).stdout;
  } catch (err) {
    console.warn(
      `teardown: fakeHomePids ps failed (fake-HOME PID sweep skipped — ` +
        `leftover procs possible): ${err}`,
    );
    return [];
  }
  const candidates: number[] = [];
  const rx = /\b(codex|gemini|claude|node|tsx|Chromium|chromium|chrome_crashpad)\b/i;
  for (const line of listing.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    if (rx.test(m[2])) candidates.push(Number(m[1]));
  }
  const matched: number[] = [];
  for (const pid of candidates) {
    try {
      const envOut = spawnSync("ps", ["eww", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2_000,
      }).stdout;
      if (envOut.split(/\s/).some((tok) => tok === `HOME=${fakeHome}`)) {
        matched.push(pid);
      }
    } catch {
      /* gone */
    }
  }
  return matched;
}

async function teardown(
  server: DemoServer,
  agents: AgentInfo[],
  workspace: string,
): Promise<void> {
  shuttingDown = true;
  console.log("Tearing down (scoped — agents via API, then fake-HOME PID sweep)…");

  const treePids =
    server.child.pid !== undefined ? descendantPids(server.child.pid) : [];

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
    console.warn(`teardown: agent cleanup failed: ${err}`);
  }

  try {
    if (server.child.exitCode === null) {
      const exited = new Promise<void>((r) => server.child.once("exit", () => r()));
      server.kill();
      const result = await Promise.race([
        exited.then(() => "exited" as const),
        sleep(5_000).then(() => "timeout" as const),
      ]);
      if (result === "timeout") {
        console.warn("teardown: SIGTERM ignored 5s — SIGKILL");
        server.child.kill("SIGKILL");
        await Promise.race([exited, sleep(2_000)]);
      }
    }
  } catch (err) {
    console.warn(`teardown: server kill failed: ${err}`);
  }

  // Reap any leftover process tied to the fake HOME (Codex app-server daemons,
  // Gemini/Claude TUIs) — by PID, HOME-scoped. Runs BEFORE rm so env is intact.
  await sleep(600);
  const homePids = fakeHomePids(server.fakeHome);
  for (const pid of homePids) {
    try {
      process.kill(pid, "SIGKILL");
      console.warn(`teardown: reaped fake-HOME pid ${pid}`);
    } catch {
      /* already gone */
    }
  }
  // Belt: SIGTERM any still-alive server-tree descendant not already reaped.
  for (const pid of treePids) {
    if (homePids.includes(pid)) continue;
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }

  for (const dir of [server.configDir, server.fakeHome, workspace]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`teardown: rm ${dir} failed: ${err}`);
    }
  }
}

/** Cleanup for a PARTIALLY-constructed run — a throw or Ctrl-C during boot,
 *  before a full DemoServer exists. Mirrors teardown's child-kill + HOME-scoped
 *  PID sweep + temp-dir removal, minus the agent-API deletes (no reachable
 *  server). Scoped by PID + HOME===fakeHome — never by name — so the operator's
 *  real agents are untouched. Removes the credential-bearing temp dirs. */
async function bestEffortReap(r: Resources): Promise<void> {
  shuttingDown = true;
  console.log("Interrupted/failed during boot — best-effort cleanup…");

  const child = r.child;
  const treePids = child?.pid !== undefined ? descendantPids(child.pid) : [];

  try {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((res) => child.once("exit", () => res()));
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited.then(() => "exited" as const),
        sleep(3_000).then(() => "timeout" as const),
      ]);
      if (result === "timeout") {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(1_500)]);
      }
    }
  } catch (err) {
    console.warn(`cleanup: child kill failed: ${err}`);
  }

  await sleep(400);
  if (r.fakeHome) {
    for (const pid of fakeHomePids(r.fakeHome)) {
      try {
        process.kill(pid, "SIGKILL");
        console.warn(`cleanup: reaped fake-HOME pid ${pid}`);
      } catch {
        /* already gone */
      }
    }
  }
  for (const pid of treePids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }

  for (const dir of [r.configDir, r.fakeHome, r.workspace]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`cleanup: rm ${dir} failed: ${err}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const caps = detectCaps();
  const cast = buildCast(caps);

  // These are populated as boot proceeds; cleanup reads whatever exists so an
  // interrupt during boot never leaks temp dirs (with seeded creds) or orphans.
  const resources: Resources = {};
  let server: DemoServer | undefined;
  let mock: DemoMock | null = null;
  let agents: AgentInfo[] = [];
  let cleanedUp = false;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      // Full path when a reachable server exists (agent-API deletes + sweep);
      // otherwise the partial-boot reaper (fs + PID cleanup only).
      if (server) await teardown(server, agents, resources.workspace ?? "");
      else await bestEffortReap(resources);
    } catch (err) {
      console.error("cleanup failed:", err);
    }
    try {
      await mock?.close();
    } catch {
      /* in-process */
    }
  };

  // Install signal handlers BEFORE any temp-dir / credential-copy / spawn work,
  // so a Ctrl-C during boot still reaps partial resources. A SECOND signal while
  // cleanup is in flight is ignored (and logged) rather than aborting cleanup
  // mid-way with process.exit.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (cleanupPromise) {
        console.log(`\n${sig} — cleanup already in progress, please wait…`);
        return;
      }
      console.log(`\n${sig} — tearing down…`);
      cleanupPromise = cleanup().finally(() => process.exit(130));
    });
  }

  try {
    if (!existsSync(join(DASHBOARD_DIR, "dist/index.html"))) {
      console.log("Dashboard dist missing — building…");
      const r = spawnSync("bun", ["run", "build"], {
        cwd: DASHBOARD_DIR,
        stdio: "inherit",
      });
      if (r.status !== 0) throw new Error("dashboard build failed");
    }
    mkdirSync(OUT_DIR, { recursive: true });

    const workspace = makeDemoWorkspace();
    resources.workspace = workspace;
    // Mock is booted whenever Claude has no creds (drives Claude's canned turns).
    mock = caps.claudeCreds ? null : await startDemoMock(cast);
    server = await bootServer(workspace, caps, mock?.url, resources);
    console.log(
      `Demo server: http://127.0.0.1:${server.port} (config: ${server.configDir})`,
    );

    agents = await stageScene(
      server,
      cast,
      caps,
      mock ?? { url: "", served: () => new Map(), close: async () => {} },
      workspace,
    );
    await captureWeb(server, agents, cast);
    if (KEEP_ALIVE) {
      console.log(
        `\n--keep: http://127.0.0.1:${server.port}/?token=${server.token}\nCtrl-C to stop.`,
      );
      await new Promise(() => {});
    }
  } catch (err) {
    console.error(
      `Run failed — server logs:\n${server?.logs() ?? "(server not started)"}`,
    );
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
