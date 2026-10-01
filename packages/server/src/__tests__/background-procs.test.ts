import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findBackgroundProcs,
  listProcesses,
  MIN_AGE_S,
  type ProcRow,
  parseEtime,
  parseProcessTable,
} from "../backgroundProcs.js";

/**
 * Process shapes captured on forge (CC 2.1.28x, codex 0.154) — a Claude Code
 * agent with MCP servers only, and one that backgrounded a Bash command.
 */
const CLAUDE = 100;
const PROBE = 200;
const APP_SERVER = 300;
const row = (
  pid: number,
  ppid: number,
  ageS: number,
  args: string,
): ProcRow => ({
  pid,
  ppid,
  ageS,
  args,
});
const table: ProcRow[] = [
  row(
    CLAUDE,
    1,
    200,
    "/home/u/.local/bin/claude --session-id s1 --name qa-claude",
  ),
  // MCP servers: their shells are GRANDchildren of the CLI.
  row(101, CLAUDE, 199, "npm exec @playwright/mcp@latest"),
  row(102, 101, 198, "sh -c playwright-mcp"),
  row(
    103,
    102,
    198,
    "node /home/u/.npm/_npx/x/node_modules/.bin/playwright-mcp",
  ),
  row(
    104,
    CLAUDE,
    199,
    "bun run --cwd /plugins/discord --shell=bun --silent start",
  ),
  row(
    105,
    CLAUDE,
    199,
    "node /tmp/aq/prefix/share/autonomos/channel-server/dist.mjs",
  ),
  // A backgrounded Bash-tool command: a DIRECT-child shell.
  row(
    PROBE,
    1,
    45,
    "/home/u/.local/bin/claude --session-id s2 --name bg-probe",
  ),
  row(
    201,
    PROBE,
    38,
    "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval 'tail -f /dev/null' < /dev/null",
  ),
  row(202, 201, 38, "tail -f /dev/null"),
  // A hook relay mid-flight: direct-child shell, milliseconds old.
  row(203, PROBE, 0, "/bin/sh -c curl -s -d @- $AUTONOMOS_SERVER/api/hooks/s2"),
  // Codex app-server running a command.
  row(
    APP_SERVER,
    1,
    90,
    "/home/u/.local/bin/codex app-server --listen ws://127.0.0.1:1",
  ),
  row(301, APP_SERVER, 60, "bash -lc npm run dev"),
  row(302, 301, 60, "node node_modules/.bin/vite"),
];

describe("findBackgroundProcs", () => {
  it("MCP servers are not background work (their shells are grandchildren)", () => {
    assert.deepEqual(findBackgroundProcs(table, [CLAUDE]), []);
  });

  it("a backgrounded Bash command is found and labelled by the real command", () => {
    assert.deepEqual(findBackgroundProcs(table, [PROBE]), [
      { pid: 201, command: "tail -f /dev/null" },
    ]);
  });

  it(`ignores shells younger than ${MIN_AGE_S}s (hook relays, statusline)`, () => {
    assert.ok(!findBackgroundProcs(table, [PROBE]).some((p) => p.pid === 203));
  });

  it("counts Codex work under its app-server root", () => {
    assert.deepEqual(findBackgroundProcs(table, [APP_SERVER]), [
      { pid: 301, command: "node node_modules/.bin/vite" },
    ]);
  });
});

describe("parseEtime", () => {
  it("parses ps elapsed-time forms", () => {
    assert.equal(parseEtime("00:38"), 38);
    assert.equal(parseEtime("03:24"), 204);
    assert.equal(parseEtime("01:02:03"), 3723);
    assert.equal(parseEtime("2-01:00:00"), 2 * 86_400 + 3600);
  });
});

describe("listProcesses never blocks the event loop", () => {
  // GET /api/system/upgrade (every dashboard load, and every ~2s while the
  // update dialog is open) lists processes. As a spawnSync, a slow `ps` on a
  // busy box froze the whole server (965ms measured), timing out every
  // agent's statusline at once.
  it("the loop keeps ticking while a slow `ps` runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slow-ps-"));
    const realPath = process.env.PATH;
    writeFileSync(
      join(dir, "ps"),
      "#!/bin/sh\nsleep 0.5\necho '  1     0 01:00 /sbin/launchd'\n",
    );
    chmodSync(join(dir, "ps"), 0o755);
    process.env.PATH = `${dir}:${realPath}`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      const rows = await listProcesses();
      assert.deepEqual(rows, [
        { pid: 1, ppid: 0, ageS: 60, args: "/sbin/launchd" },
      ]); // precondition: the slow shim is what ran
      assert.ok(ticks >= 10, `event loop froze during ps (${ticks} ticks)`);
    } finally {
      clearInterval(timer);
      process.env.PATH = realPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseProcessTable reads ps rows and skips junk", () => {
    assert.deepEqual(
      parseProcessTable("  42  1 1-02:03:04 node x.js\nnot a row\n"),
      [{ pid: 42, ppid: 1, ageS: 93_784, args: "node x.js" }],
    );
  });
});
