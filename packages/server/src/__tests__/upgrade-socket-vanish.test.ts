/**
 * A WebSocket client that vanishes mid-handshake must not crash the server.
 *
 * Found by OrgChart on an isolated server: ~7 rapid agent kills with a
 * dashboard open crashed the process with an unhandled EPIPE from
 * @hono/node-ws's upgrade handler (`socket.end()` on a refused upgrade whose
 * peer was already gone), taking every live agent's PTY with it. See
 * upgradeSockets.ts. Runs in a CHILD process because, unfixed, it really does
 * crash the process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "upgrade-vanish-child.ts");

function run(mode: "raw" | "guarded") {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      // tsx resolves from the server package, not the repo root.
      cwd: join(HERE, "..", ".."),
      env: { PATH: process.env.PATH, MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
    });
    c.stderr.on("data", (d) => {
      out += d;
    });
    const kill = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
  });
}

describe("upgrade socket: a client that vanishes mid-handshake", () => {
  it("the fixture reproduces the crash when node-ws is wired directly (the bug)", async () => {
    const { code, out } = await run("raw");
    assert.ok(out.includes("READY"), out);
    assert.notEqual(code, 0, "unguarded: the process crashes");
    assert.ok(!out.includes("ALIVE"), out);
    assert.match(out, /EPIPE|ECONNRESET/, "the crash is the peer-gone write");
  });

  it("through attachWebSockets the server stays alive", async () => {
    const { code, out } = await run("guarded");
    assert.equal(code, 0, out);
    assert.ok(out.includes("ALIVE"), out);
  });

  it("run.ts gives every listener WebSockets through attachWebSockets (no bare injectWebSocket)", () => {
    const src = readFileSync(join(HERE, "..", "run.ts"), "utf8");
    // node-ws's inject functions may only ever be passed to attachWebSockets.
    const bare = src.match(/\b(?:injectWebSocket|iInject)\(/g) ?? [];
    assert.deepEqual(bare, [], "a listener bypasses the upgrade-socket guard");
    assert.equal(
      (src.match(/attachWebSockets\(/g) ?? []).length,
      3,
      "public, --host extras, internal",
    );
  });
});
