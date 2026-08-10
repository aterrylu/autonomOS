/**
 * capture-demo.ts — the README/site demo recording, fully automated (`make demo`).
 *
 * One command records the product's money shot as a ~20s loop:
 *   Beat 1  a human types ONE instruction into a Claude Code lead's terminal
 *   Beat 2  the lead spawns a Codex agent + wires the org chart (create_agent /
 *           set_manager / send) — sidebar row + org node appear on their own
 *   Beat 3  the handoff message renders INLINE in the live Codex TUI and the
 *           reviewer starts replying — cross-CLI, no human relay
 *
 * Everything is real: real claude + codex binaries against an ISOLATED server
 * (own config dir + fake HOME + ephemeral port — never :3100), exactly like
 * capture-hero.ts, whose plumbing this imports. Requires BOTH real credential
 * sets (the demo has no mock path — the point is real coordination). Re-runs
 * are similar-not-identical (real turns); the BEATS are what must reproduce.
 *
 * Output: docs/assets/demo.webm (raw), demo.mp4 (site), demo.gif (README),
 * encoded via ffmpeg (2x speed). Override dir with DEMO_OUT_DIR.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  type AgentInfo,
  api,
  bestEffortReap,
  bootServer,
  DASHBOARD_DIR,
  type DemoServer,
  detectCaps,
  jsonlTreeHas,
  makeDemoWorkspace,
  ORG_FIT_CSS,
  OUT_DIR,
  type Resources,
  sleep,
  teardown,
  THEME,
  UNDIM_CSS,
  warmCodexUsage,
  warmUsage,
} from "./capture-hero.ts";

const DEMO_OUT_DIR = process.env.DEMO_OUT_DIR ?? OUT_DIR;
const DEMO_W = 1680;
const DEMO_H = 920;
const SPEEDUP = 2; // encode-time playback multiplier

const LEAD = "Dispatcher";
const REVIEWER = "CodexReviewer";
/** Marker woven through the handoff so rollout scans can prove arrival. */
const MARKER = "idempotency contract";

/** What the "human" types on camera — one instruction, then everything else is
 *  the agents. Keep it short: it's typed at ~28ms/char on the recording. */
const TYPED_INSTRUCTION =
  `Spin up a Codex agent named ${REVIEWER}, make it report to you, ` +
  `and send it this task over the message bus: review the payments API ${MARKER} in this repo.`;

/** Steering appended to the lead's system prompt so the SEQUENCE is reliable
 *  even though the words are the model's own. The tools are real. */
const LEAD_STEER =
  "Demo-recording conventions for this session: when asked to spin up a reviewer and hand off a task, do exactly and only this, in order: " +
  "(0) load the tools with ToolSearch query \"select:mcp__autonomos__create_agent,mcp__autonomos__set_manager,mcp__autonomos__send\" " +
  "(they are deferred MCP tools under the mcp__autonomos__ prefix — bare names will not match); " +
  `(1) mcp__autonomos__create_agent with name "${REVIEWER}", provider "codex", and a one-line prompt introducing its role as a code reviewer for this repo; ` +
  "(2) mcp__autonomos__set_manager making it report to you; " +
  `(3) mcp__autonomos__send it ONE concise task message that includes the phrase "${MARKER}". ` +
  "Keep your own replies to one short confirmation line per step. Do not ask clarifying questions.";

type PaneObj =
  | { type: "session"; id: string }
  | { type: "orgchart"; id: "orgchart" };

/** 2-pane dockview: org chart LEFT (38%), the lead's terminal RIGHT. The
 *  reviewer's pane arrives later by CLICKING its sidebar row (beat 3), which
 *  swaps the right group's active tab — no mid-recording layout reseed. */
function seedBlob2(leadPane: PaneObj & { type: "session" }): string {
  const wsId = "ws-demo";
  const leftW = Math.round(DEMO_W * 0.38);
  const rightW = DEMO_W - leftW;
  const leaf = (id: string, gid: string, size: number) => ({
    type: "leaf",
    size,
    data: { views: [id], activeView: id, id: gid },
  });
  const panel = (id: string, pane: PaneObj) => ({
    id,
    contentComponent: "pane",
    tabComponent: "status",
    params: { pane },
  });
  // Panel ids must BE the pane identity (agent session id / "orgchart") — the
  // dashboard resolves panels by that id; arbitrary ids fail fromJSON and the
  // whole blob degrades to the solo-activePane fallback.
  const leadId = leadPane.id;
  const serialized = {
    grid: {
      root: {
        type: "branch",
        data: [leaf("orgchart", "grp-org", leftW), leaf(leadId, "grp-main", rightW)],
        size: DEMO_H,
      },
      height: DEMO_H,
      width: DEMO_W,
      orientation: "HORIZONTAL",
    },
    panels: {
      orgchart: panel("orgchart", { type: "orgchart", id: "orgchart" }),
      [leadId]: panel(leadId, leadPane),
    },
    activeGroup: "grp-main",
  };
  const paneIds = ["orgchart", leadId];
  const state: Record<string, unknown> = {
    theme: THEME,
    sidebarViewMode: "hierarchy",
    sidebarViewModeExplicit: true,
    activePane: leadPane,
    dvWorkspaces: { [wsId]: { paneIds, serialized } },
    dvPaneWorkspace: Object.fromEntries(paneIds.map((id) => [id, wsId])),
  };
  return JSON.stringify({ state, version: 0 });
}

async function pollUntil(
  what: string,
  deadlineMs: number,
  check: () => Promise<boolean> | boolean,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await check()) {
      console.log(`  ✓ ${what} (t=${((Date.now() - start) / 1000).toFixed(0)}s)`);
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for: ${what} (${deadlineMs / 1000}s)`);
}

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ffmpeg ${args.join(" ")}`);
}

async function main(): Promise<void> {
  const caps = detectCaps();
  // The demo has no mock path on purpose: its one claim is REAL cross-CLI
  // coordination, so faking either side would record a lie.
  if (!caps.claudeCreds || !caps.codex) {
    throw new Error(
      "make demo needs BOTH real credential sets (Claude + Codex) — " +
        `have claude=${caps.claudeCreds} codex=${caps.codex}. No mock fallback by design.`,
    );
  }

  const resources: Resources = {};
  let server: DemoServer | undefined;
  let agents: AgentInfo[] = [];
  let cleanedUp = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (server) await teardown(server, agents, resources.workspace ?? "");
      else await bestEffortReap(resources);
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (cleanupPromise) return;
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
    mkdirSync(DEMO_OUT_DIR, { recursive: true });

    const workspace = makeDemoWorkspace();
    resources.workspace = workspace;
    server = await bootServer(workspace, caps, undefined, resources);
    console.log(`Demo server: http://127.0.0.1:${server.port} (config: ${server.configDir})`);
    await warmUsage(server, "boot");
    await warmCodexUsage(server, "boot");

    // Spawn ONLY the lead — promptless (the instruction is typed on camera),
    // steered via systemPrompt so the tool sequence is reliable.
    console.log(`Spawning ${LEAD} (lead, claude-code, bypass)…`);
    const spawn = await api<{ id?: string; error?: string }>(server, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: LEAD,
        workingDirectory: workspace,
        provider: "claude-code",
        permissionMode: "bypass",
        systemPrompt: LEAD_STEER,
      }),
    });
    if (spawn.status !== 201 || !spawn.body.id) {
      throw new Error(`spawn ${LEAD} failed (${spawn.status}): ${JSON.stringify(spawn.body)}`);
    }
    const leadId = spawn.body.id;
    agents = [{ id: leadId, name: LEAD } as AgentInfo];

    // Let the TUI boot + auto-trust settle before recording starts.
    await sleep(12_000);

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: DEMO_W, height: DEMO_H },
      deviceScaleFactor: 1,
      recordVideo: { dir: DEMO_OUT_DIR, size: { width: DEMO_W, height: DEMO_H } },
    });
    let videoSrc: string | undefined;
    try {
      await context.addCookies([
        {
          name: "autonomos_token",
          value: server.token,
          url: `http://127.0.0.1:${server.port}`,
        },
      ]);
      const seed = seedBlob2({ type: "session", id: leadId });
      await context.addInitScript((blob: string) => {
        window.localStorage.setItem("autonomos", blob);
      }, seed);
      const page = await context.newPage();
      const vid = page.video();
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });
      await page.addStyleTag({ content: UNDIM_CSS + ORG_FIT_CSS });

      // Stage sanity: both panes + the lead terminal must exist before beat 1.
      try {
        await pollUntil("dashboard staged (2 panes + terminal)", 30_000, () =>
          page.evaluate(() => {
            const panes = document.querySelectorAll(".dv-pane-fill").length;
            const terms = document.querySelectorAll(".xterm").length;
            return panes >= 2 && terms >= 1;
          }),
        );
      } catch (err) {
        const dump = await page.evaluate(() => ({
          url: location.href,
          panes: document.querySelectorAll(".dv-pane-fill").length,
          terms: document.querySelectorAll(".xterm").length,
          bodyText: document.body.innerText.slice(0, 300),
        }));
        await page.screenshot({ path: join(DEMO_OUT_DIR, "demo-stage-fail.png") });
        console.error("stage dump:", JSON.stringify(dump, null, 1));
        throw err;
      }
      await sleep(2_500); // opening hold — viewers need a beat of stillness

      // ── Beat 1: the human types ONE instruction ──────────────────────────
      console.log("Beat 1: typing the instruction…");
      const term = page.locator(".xterm").first();
      await term.click();
      await sleep(600);
      await page.keyboard.type(TYPED_INSTRUCTION, { delay: 28 });
      await sleep(700);
      await page.keyboard.press("Enter");

      // ── Beat 2: the fleet reacts (spawn + org wiring, UI updates itself) ─
      console.log("Beat 2: waiting for the lead to spawn the reviewer…");
      const fh = server.fakeHome;
      try {
        await pollUntil(`${REVIEWER} agent exists`, 150_000, async () => {
          const { body } = await api<Array<{ name: string }>>(server as DemoServer, "/api/agents", {});
          return Array.isArray(body) && body.some((a) => a.name === REVIEWER);
        });
      } catch (err) {
        const cljson = join(fh, ".claude", "projects");
        // pull the actual tool_result lines mentioning create_agent for diagnosis
        const { readdirSync, readFileSync } = await import("node:fs");
        const grab = (root: string, needle: string): string[] => {
          const out: string[] = [];
          const stack = [root];
          while (stack.length && out.length < 6) {
            const dir = stack.pop() as string;
            let es: import("node:fs").Dirent[] = [];
            try { es = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of es) {
              const full = join(dir, e.name);
              if (e.isDirectory()) stack.push(full);
              else if (e.name.endsWith(".jsonl")) {
                try {
                  for (const line of readFileSync(full, "utf-8").split("\n")) {
                    if (line.includes(needle)) out.push(line.slice(0, 600));
                  }
                } catch { /* mid-write */ }
              }
            }
          }
          return out;
        };
        console.error("beat-2 create_agent lines:\n" + grab(cljson, "create_agent").join("\n---\n"));
        await page.screenshot({ path: join(DEMO_OUT_DIR, "demo-beat2-fail.png") });
        throw err;
      }
      // Beat-2 hold: wait for the sidebar to actually PAINT the new row (the
      // server record leads the UI poll by a few seconds), then give the
      // two-agent sidebar + grown org chart real screen time — this is the
      // "fleet reacts" visual.
      await page
        .locator("aside")
        .getByText(REVIEWER, { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      console.log("  ✓ reviewer row painted in sidebar");
      await sleep(7_000);

      // The handoff message must have REACHED codex before we cut to its pane.
      await pollUntil("handoff arrived in the Codex rollout", 120_000, () =>
        jsonlTreeHas(join(fh, ".codex", "sessions"), MARKER),
      );

      // ── Beat 3: cut to the Codex TUI — the message is inline ─────────────
      console.log("Beat 3: switching to the reviewer's pane…");
      await page.locator("aside").getByText(REVIEWER, { exact: true }).first().click();
      // The money shot is the INBOUND message + codex starting to work — not
      // its full reply (waiting for that padded the cut with ~25s of codex
      // exploring). Fixed holds: ~6s covers pane attach + replay of the
      // inline message, then a short working-state hold, then end.
      await sleep(14_000);
      await page.close();
      videoSrc = vid ? await vid.path() : undefined;
    } finally {
      await context.close(); // finalizes the webm
      await browser.close();
    }
    if (!videoSrc || !existsSync(videoSrc)) {
      throw new Error("Playwright produced no video file");
    }

    // ── Encode: raw webm → mp4 (site) + gif (README), both sped up ────────
    const rawPath = join(DEMO_OUT_DIR, "demo.webm");
    renameSync(videoSrc, rawPath);
    console.log(`Encoding (${SPEEDUP}x)…`);
    ffmpeg([
      "-i", rawPath,
      "-vf", `setpts=PTS/${SPEEDUP},scale=1280:-2`,
      "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      join(DEMO_OUT_DIR, "demo.mp4"),
    ]);
    ffmpeg([
      "-i", rawPath,
      "-filter_complex",
      `[0:v]setpts=PTS/${SPEEDUP},fps=12,scale=960:-2,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
      join(DEMO_OUT_DIR, "demo.gif"),
    ]);
    console.log(`\nDone. demo.webm / demo.mp4 / demo.gif in ${DEMO_OUT_DIR}`);
  } catch (err) {
    console.error(`Run failed — server logs:\n${server?.logs() ?? "(server not started)"}`);
    throw err;
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
