/**
 * Statusline under an N-agent load — the CI guard for "the statusline flips
 * to [autonomos · offline] and the branch keeps disappearing" (Terry,
 * 30-50 agents). Opt-in: AUTONOMOS_LOAD_TEST=1 (the nightly `load` workflow
 * runs it; ~3 min). Skips otherwise, so `make check` stays fast.
 *
 * A REAL server spawns N agents. Each is a stub `claude`
 * (perf/statusline-load/fake-claude.mjs) that runs the REAL statusline and
 * hook commands from the server's --settings on Claude Code's cadence, while
 * this test plays the dashboard (Projects poll, the update dialog's poll).
 *
 * The conditions measured on a busy box are recreated deterministically, so
 * the guard fails for the real reason on any runner:
 *   - `git` takes 300ms (shim): the old 100ms `git branch` budget dropped the
 *     branch on 96-100% of ticks.
 *   - `ps` takes 600ms (shim): the old spawnSync `ps -A` behind
 *     GET /api/system/upgrade blocked the server ~1s per dashboard load.
 *   - many untitled transcripts: the Projects poll re-read every one of them.
 *   - phase 2 injects 900ms server stalls 600ms apart (/api/perf/stall),
 *     far past the old 200ms statusline budget — a transient stall must not
 *     read "offline".
 *
 * Failure messages name the symptom.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cwdToDirName } from "../titleCache";
import { gitEnv } from "./helpers/git-env";
import { type BootedServer, bootServer } from "./helpers/test-server";

const ENABLED = process.env.AUTONOMOS_LOAD_TEST === "1";
const N = Number(process.env.LOAD_AGENTS ?? 20);
const PHASE_MS = Number(process.env.LOAD_PHASE_MS ?? 60_000);
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "../../perf/statusline-load/fake-claude.mjs");

// Bounds. The server is ~1-2% busy at this load; a request should never wait
// on a block anywhere near the statusline's budget.
const PROBE_MAX_MS = 300;
const PROBE_P99_MS = 100;

type SlRow = { t: number; ms: number; l1: string; l2: string; agent: string };

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("statusline under N-agent load", { skip: !ENABLED }, () => {
  let srv: BootedServer;
  let shimDir: string;
  let logDir: string;
  const prevEnv = { ...process.env };
  const ids: string[] = [];
  const probes: { t: number; ms: number; status: number }[] = [];
  let stopTraffic = false;
  let traffic: Promise<unknown> = Promise.resolve();
  const phases: Record<string, [number, number]> = {};

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${srv.port}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${srv.token}`, ...init.headers },
    });

  before(async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const realPs = execFileSync("sh", ["-c", "command -v ps"], {
      encoding: "utf8",
    }).trim();
    // The server's own PATH gets the slow `ps`.
    shimDir = join(
      execFileSync("mktemp", ["-d", "/tmp/aos-load.XXXXXX"], {
        encoding: "utf8",
      }).trim(),
    );
    writeFileSync(
      join(shimDir, "ps"),
      `#!/bin/sh\nsleep 0.6\nexec ${realPs} "$@"\n`,
    );
    chmodSync(join(shimDir, "ps"), 0o755);
    logDir = join(shimDir, "sl");
    mkdirSync(logDir);
    process.env.PATH = `${shimDir}:${process.env.PATH}`;
    // Perf mode (→ /api/perf/stall) engages ONLY on a loopback bind.
    process.env.AUTONOMOS_PERF = "1";
    process.env.AUTONOMOS_HOST = "127.0.0.1";
    process.env.SL_LOG_DIR = logDir; // inherited by agents → fake-claude logs

    srv = await bootServer({
      prepareConfigDir: (cfg) => {
        const bin = join(cfg, "home", ".local", "bin");
        mkdirSync(bin, { recursive: true });
        // Agents' PATH starts with ~/.local/bin: the stub claude, and a git
        // that is as slow as a loaded box makes it.
        writeFileSync(
          join(bin, "claude"),
          `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`,
        );
        writeFileSync(
          join(bin, "git"),
          `#!/bin/sh\nsleep 0.3\nexec ${realGit} "$@"\n`,
        );
        chmodSync(join(bin, "claude"), 0o755);
        chmodSync(join(bin, "git"), 0o755);
        // Repos for the agents, a third of them linked worktrees.
        for (let i = 0; i < 6; i++) {
          const repo = join(cfg, "repos", `r${i}`);
          execFileSync(realGit, ["init", "-q", "-b", `feat/r${i}`, repo], {
            env: gitEnv(),
          });
          execFileSync(
            realGit,
            [
              "-C",
              repo,
              "-c",
              "user.email=t@t",
              "-c",
              "user.name=t",
              "commit",
              "-q",
              "--allow-empty",
              "-m",
              "i",
            ],
            { env: gitEnv() },
          );
          if (i % 3 === 0)
            execFileSync(
              realGit,
              [
                "-C",
                repo,
                "worktree",
                "add",
                "-q",
                "-b",
                `wt/r${i}`,
                join(cfg, "repos", `w${i}`),
              ],
              { env: gitEnv() },
            );
        }
        // Untitled transcripts for the Projects poll to scan (~600KB each, so
        // a rescan reads head, tail AND the middle).
        const line = (sid: string, cwd: string, i: number) =>
          `${JSON.stringify({ type: i % 2 ? "assistant" : "user", sessionId: sid, cwd, uuid: `${sid}-${i}`, timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { role: i % 2 ? "assistant" : "user", content: "x".repeat(2000) } })}\n`;
        for (let p = 0; p < 4; p++) {
          const cwd = join(cfg, "repos", `r${p}`);
          const dir = join(
            cfg,
            "home",
            ".claude",
            "projects",
            cwdToDirName(cwd),
          );
          mkdirSync(dir, { recursive: true });
          for (let s = 0; s < 30; s++) {
            const sid = `00000000-0000-4000-8000-${String(p * 100 + s).padStart(12, "0")}`;
            let body = "";
            for (let i = 0; i < 280; i++) body += line(sid, cwd, i);
            writeFileSync(join(dir, `${sid}.jsonl`), body);
          }
        }
      },
    });

    // Precondition: the stall injector is really mounted and really stalls,
    // or phase 2 would pass vacuously.
    const s0 = performance.now();
    const stall = await api("/api/perf/stall?ms=300", { method: "POST" });
    assert.equal(stall.status, 200, "perf-mode stall route not mounted");
    assert.ok(performance.now() - s0 >= 300, "stall route did not block");

    // Precondition: the Projects listing really sees the seeded transcripts,
    // or the "Projects poll" pressure below would be imaginary.
    const projects = JSON.stringify(await (await api("/api/projects")).json());
    const seen = (projects.match(/00000000-0000-4000-8000-/g) ?? []).length;
    assert.ok(seen >= 100, `seeded transcripts not listed (saw ${seen})`);

    const dirs = readdirSync(join(srv.configDir, "repos")).map((d) =>
      join(srv.configDir, "repos", d),
    );
    for (let i = 0; i < N; i++) {
      const res = await api("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Load${i}@load`,
          provider: "claude-code",
          workingDirectory: dirs[i % dirs.length],
          ...(i % 5 ? { manager: `Load${i - (i % 5)}@load` } : {}),
        }),
      });
      const body = (await res.json()) as { id?: string };
      assert.ok(
        res.ok && body.id,
        `spawn ${i} failed: ${JSON.stringify(body)}`,
      );
      ids.push(body.id);
    }

    // The dashboard + an always-on keep-alive /self prober.
    const tokenOf = (id: string) =>
      readFileSync(join(srv.configDir, "agent-tokens", id), "utf8").trim();
    const prober = (async () => {
      let k = 0;
      while (!stopTraffic) {
        const id = ids[k++ % ids.length];
        const t0 = performance.now();
        let status = 0;
        try {
          const r = await fetch(
            `http://127.0.0.1:${srv.port}/api/agents/${id}/self`,
            { headers: { "X-Agent-Token": tokenOf(id) } },
          );
          status = r.status;
          await r.text();
        } catch {
          status = -1;
        }
        probes.push({ t: Date.now(), ms: performance.now() - t0, status });
        await sleep(50);
      }
    })();
    const dashboard = (async () => {
      let tick = 0;
      while (!stopTraffic) {
        await api("/api/system/upgrade")
          .then((r) => r.text())
          .catch(() => {});
        if (tick++ % 3 === 0)
          await api("/api/projects")
            .then((r) => r.text())
            .catch(() => {});
        await sleep(2000);
      }
    })();
    traffic = Promise.all([prober, dashboard]);

    // Warm-up: every agent renders once (its cache fills), then measure.
    const warmDeadline = Date.now() + 60_000;
    while (Date.now() < warmDeadline) {
      const rows = readRows();
      if (new Set(rows.filter((r) => r.l1).map((r) => r.agent)).size >= N)
        break;
      await sleep(1000);
    }

    phases.steady = [Date.now(), Date.now() + PHASE_MS];
    await sleep(PHASE_MS);

    // Phase 2: transient server stalls longer than the old 200ms budget.
    phases.stalls = [Date.now(), Date.now() + PHASE_MS];
    const stallEnd = Date.now() + PHASE_MS;
    while (Date.now() < stallEnd) {
      // Stalled 60% of the time: 900ms blocks, 600ms apart. Any tick of the
      // old 200ms-budget statusline lands in one; the new one rides through.
      const r = await api("/api/perf/stall?ms=900", { method: "POST" });
      assert.equal(r.status, 200, "stall injection failed mid-phase");
      await sleep(600);
    }
    stopTraffic = true;
    await traffic;
  });

  after(async () => {
    stopTraffic = true;
    await traffic.catch(() => {});
    await srv?.kill();
    process.env = prevEnv;
    if (srv) rmSync(srv.configDir, { recursive: true, force: true });
    if (shimDir && process.env.LOAD_KEEP !== "1")
      rmSync(shimDir, { recursive: true, force: true });
  });

  function readRows(): SlRow[] {
    return readdirSync(logDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(join(logDir, f), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ ...(JSON.parse(l) as SlRow), agent: f })),
      );
  }
  const rowsIn = ([a, b]: [number, number]) =>
    readRows().filter((r) => r.t >= a && r.t <= b);
  const summary = (rows: SlRow[]) => {
    const perAgent: Record<string, number> = {};
    for (const r of rows) perAgent[r.agent] = (perAgent[r.agent] ?? 0) + 1;
    return `${rows.length} runs across ${Object.keys(perAgent).length} agents ${JSON.stringify(perAgent)}; e.g. ${JSON.stringify(rows.slice(0, 2))}`;
  };

  it("the server stays responsive: /self never waits on a long block", () => {
    const [a, b] = phases.steady;
    const ms = probes.filter((p) => p.t >= a && p.t <= b).map((p) => p.ms);
    assert.ok(ms.length > 100, `too few probes (${ms.length})`);
    const max = Math.max(...ms);
    assert.ok(
      max < PROBE_MAX_MS,
      `server stalled: /self waited ${max.toFixed(0)}ms (bound ${PROBE_MAX_MS}ms) under ${N} agents + dashboard polling`,
    );
    assert.ok(
      pct(ms, 99) < PROBE_P99_MS,
      `server slow: /self p99 ${pct(ms, 99).toFixed(0)}ms (bound ${PROBE_P99_MS}ms)`,
    );
  });

  for (const phase of ["steady", "stalls"] as const) {
    it(`[${phase}] every statusline run renders (no empty output)`, () => {
      const rows = rowsIn(phases[phase]);
      assert.ok(rows.length >= N, `too few statusline runs: ${rows.length}`);
      const empty = rows.filter((r) => !r.l1);
      assert.equal(
        empty.length,
        0,
        `statusline produced no output in 10s: ${summary(empty)}`,
      );
    });

    it(`[${phase}] the statusline never shows "offline" while the server is up`, () => {
      const offline = rowsIn(phases[phase]).filter((r) =>
        r.l1.includes("offline"),
      );
      assert.equal(
        offline.length,
        0,
        `statusline showed [autonomos · offline]: ${summary(offline)}`,
      );
    });

    it(`[${phase}] the branch never disappears`, () => {
      const missing = rowsIn(phases[phase]).filter(
        (r) => r.l1 && !r.l2.includes("🌿"),
      );
      assert.equal(
        missing.length,
        0,
        `statusline dropped the branch: ${summary(missing)}`,
      );
    });
  }
});
