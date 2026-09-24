import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findBackgroundProcs,
  MIN_AGE_S,
  type ProcRow,
  parseEtime,
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
