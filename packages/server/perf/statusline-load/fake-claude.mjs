#!/usr/bin/env node
// Stand-in `claude` for the statusline load test (and the manual rig in
// README.md). It consumes the REAL --settings the server builds and drives
// the REAL commands in it on Claude Code's cadence:
//   - the statusLine command every refreshInterval, and ~300ms after each
//     simulated assistant message (CC's own triggers), one at a time;
//   - every hook command per turn (sync hooks awaited, as CC does);
// plus light Ink-style PTY output. No model, no network beyond the server.
//
// Each statusline run is appended to $SL_LOG_DIR/<session>.jsonl:
//   { t, ms, l1, l2 }   (ANSI stripped; empty lines = no output in time)
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const settings = JSON.parse(flag("--settings") ?? "{}");
const sessionId = flag("--session-id") ?? process.env.AUTONOMOS_SESSION_ID;
const LOG = process.env.SL_LOG_DIR
  ? `${process.env.SL_LOG_DIR}/${sessionId}.jsonl`
  : null;
const cwd = process.cwd();
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const started = Date.now();
let cost = 0;
let ctx = 5;

function run(cmd, input, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ch = spawn("sh", ["-c", cmd], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    let exitMs = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ out, ms: exitMs ?? performance.now() - t0 });
    };
    const timer = setTimeout(() => ch.kill("SIGKILL"), timeoutMs);
    ch.stdout.on("data", (d) => {
      out += d;
    });
    ch.on("exit", () => {
      exitMs = performance.now() - t0;
      setTimeout(finish, 1000); // let trailing stdout drain
    });
    ch.on("close", finish);
    ch.on("error", finish);
    ch.stdin.end(input);
  });
}

// ── statusline ──
const sl = settings.statusLine;
let slBusy = false;
async function statusline() {
  if (!sl || slBusy) return;
  slBusy = true;
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    workspace: { current_dir: cwd, project_dir: cwd },
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
    cost: { total_cost_usd: cost, total_duration_ms: Date.now() - started },
    context_window: { used_percentage: ctx },
  });
  const r = await run(sl.command, payload, 10_000);
  slBusy = false;
  const [l1 = "", l2 = ""] = r.out.split("\n");
  if (LOG)
    appendFileSync(
      LOG,
      `${JSON.stringify({ t: Date.now(), ms: Math.round(r.ms), l1: plain(l1), l2: plain(l2) })}\n`,
    );
  process.stdout.write(`\x1b7\x1b[999;1H\x1b[2K${l1}\r\n\x1b[2K${l2}\x1b8`);
}
if (sl) setInterval(statusline, (sl.refreshInterval ?? 5) * 1000);

// ── hooks ──
async function hook(event, extra = {}) {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: event,
    transcript_path: "",
    ...extra,
  });
  const sync = [];
  for (const entry of settings.hooks?.[event] ?? [])
    for (const h of entry.hooks ?? []) {
      const p = run(h.command, payload, (h.timeout ?? 60) * 1000);
      if (!h.async) sync.push(p);
    }
  await Promise.all(sync);
}

// ── a modest Ink-like repaint ──
function paint() {
  let s = "\x1b[?2026h";
  for (let i = 0; i < 12; i++)
    s += `\x1b[${i + 1};1H\x1b[2K\x1b[38;5;${(i * 17) % 255}m${"·".repeat(80)}\x1b[0m`;
  process.stdout.write(`${s}\x1b[?2026l`);
}

// ── life: idle ↔ turns ──
const TOOLS = ["Bash", "Read", "Edit", "Grep"];
async function life() {
  await hook("SessionStart", { source: "startup" });
  await sleep(rnd(0, 3000)); // de-phase the fleet
  for (;;) {
    await sleep(rnd(2000, 8000));
    await hook("UserPromptSubmit", { prompt: "go" });
    const n = Math.floor(rnd(2, 8));
    for (let i = 0; i < n; i++) {
      const tool = TOOLS[i % TOOLS.length];
      await hook("PreToolUse", { tool_name: tool, tool_input: {} });
      paint();
      await sleep(rnd(150, 500));
      await hook("PostToolUse", { tool_name: tool, tool_input: {} });
      cost += 0.01;
      ctx = Math.min(95, ctx + 0.5);
      setTimeout(statusline, 300);
    }
    await hook("Stop", {});
  }
}
process.stdin.on("data", () => {});
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"])
  process.on(sig, () => process.exit(0));
life();
