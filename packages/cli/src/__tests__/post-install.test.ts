import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Isolate BOTH the config dir AND $HOME before importing modules that read them
// at load time. HOME isolation matters because readToken()'s legacy fallback
// reads $HOME/.autonomos/token — without this the test would read (and leak) the
// maintainer's real production token on a machine that has autonomOS installed.
const TEST_DIR = join(tmpdir(), `autonomos-postinstall-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
process.env.HOME = TEST_DIR;
process.env.CI = "1"; // never actually open a browser during tests

const { writePidFile } = await import("@autonomos/server/pid-file.js");
const { verifyAndReportInstall } = await import("../lib/post-install.js");

let server: Server | null = null;
let logs: string[] = [];
const origLog = console.log;
const origWarn = console.warn;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  logs = [];
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.join(" "));
});

afterEach(async () => {
  console.log = origLog;
  console.warn = origWarn;
  if (server) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

describe("verifyAndReportInstall", () => {
  it("prints the connect panel (url + token) once the daemon responds", async () => {
    const port = await startServer();
    writePidFile({
      pid: process.pid,
      port,
      version: "test",
      startedAt: new Date().toISOString(),
    });
    writeFileSync(join(TEST_DIR, "token"), "secret-tok-123\n");

    const ok = await verifyAndReportInstall(
      { open: false },
      { timeoutMs: 4000, pollMs: 50 },
    );

    assert.equal(ok, true, "returns true when the daemon is responsive");
    const out = logs.join("\n");
    assert.match(out, /autonomOS is running/);
    assert.ok(out.includes(`http://localhost:${port}`), "shows the bound port");
    assert.ok(out.includes("secret-tok-123"), "shows the token on stdout");
    // SECURITY: the token must NOT appear in any URL — no `?token=` anywhere
    // (it would leak to shell scrollback, `ps` args, and browser history, and
    // the dashboard ignores the query param anyway). See ADR-052 security note.
    assert.ok(!out.includes("?token="), "must not put the token in a URL");
  });

  it("notes the token comes from env when no token file exists", async () => {
    const port = await startServer();
    writePidFile({
      pid: process.pid,
      port,
      version: "test",
      startedAt: new Date().toISOString(),
    });
    // no token file written

    await verifyAndReportInstall(
      { open: false },
      { timeoutMs: 4000, pollMs: 50 },
    );

    const out = logs.join("\n");
    assert.match(out, /autonomOS is running/);
    assert.match(out, /AUTONOMOS_TOKEN/);
  });

  it("falls back to ~/.autonomos/token when the config dir has none", async () => {
    const port = await startServer();
    writePidFile({
      pid: process.pid,
      port,
      version: "test",
      startedAt: new Date().toISOString(),
    });
    // No $configDir/token, but the legacy $HOME/.autonomos/token exists (HOME is
    // isolated to TEST_DIR, so this never touches a real home).
    mkdirSync(join(TEST_DIR, ".autonomos"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".autonomos", "token"), "legacy-tok-456\n");

    const ok = await verifyAndReportInstall(
      { open: false },
      { timeoutMs: 4000, pollMs: 50 },
    );

    assert.equal(ok, true);
    assert.ok(
      logs.join("\n").includes("legacy-tok-456"),
      "surfaces the legacy ~/.autonomos/token",
    );
  });

  it("returns false + warns (does not throw) when the daemon never comes up", async () => {
    // No pid file → never responsive. Short timeout so the test is fast.
    const ok = await verifyAndReportInstall(
      { open: false },
      { timeoutMs: 300, pollMs: 50 },
    );
    assert.equal(ok, false, "returns false on timeout so the caller can fail");
    const out = logs.join("\n");
    assert.match(out, /didn't become responsive/);
    assert.match(out, /autonomos logs/);
  });
});
