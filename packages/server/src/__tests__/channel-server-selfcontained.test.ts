// Self-containment contract for the COMMITTED channel-server artifact.
//
// Issue #376 (external report, v0.6.1): dist.mjs shipped with EXTERNAL dep
// imports (@modelcontextprotocol/sdk, ws) and the release tarball carries no
// resolvable node_modules — the bridge died with ERR_MODULE_NOT_FOUND before
// the MCP initialize response, killing every agent's autonomos MCP fleet-wide
// on bundle installs while the daemon (whose own bundle inlines the same
// deps) looked healthy. Source-mode installs never see it because externals
// resolve against the repo — which is exactly why no internal install ever
// caught it, and why this test EXECUTES the committed artifact from a
// node_modules-free directory instead of trusting any resolution context the
// repo provides. If this fails, the artifact cannot survive a release
// tarball: rebuild via the Makefile esbuild line (deps inlined + the
// createRequire banner) and commit the regenerated dist.mjs.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const ARTIFACT = resolve(import.meta.dirname, "../channel-server/dist.mjs");

function runInitialize(
  cwd: string,
  artifact: string,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(process.execPath, [artifact], {
      cwd,
      env: {
        // Minimal env only — no inherited PATH-side node_modules tricks. The
        // gateway socket is deliberately nonexistent: initialize must answer
        // WITHOUT the gateway (the daemon may be briefly unreachable at
        // session start; the bridge reconnects in the background).
        PATH: process.env.PATH ?? "",
        AUTONOMOS_SERVER_URL:
          "ws+unix:///nonexistent-selfcontained.sock:/ws/gateway",
        AUTONOMOS_API_URL: "http://127.0.0.1:1",
        AUTONOMOS_SESSION_ID: "selfcontained-test",
        AUTONOMOS_AGENT_NAME: "selfcontained-test",
        AUTONOMOS_CONFIG_DIR: cwd,
        AUTONOMOS_TOKEN: "selfcontained-test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      // One full JSON-RPC response line is all we need.
      if (stdout.includes('"jsonrpc"') && stdout.includes("\n")) {
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "selfcontained-test", version: "1.0" },
        },
      })}\n`,
    );
  });
}

describe("channel-server artifact is self-contained (#376)", () => {
  it("the committed dist.mjs answers MCP initialize from a node_modules-free dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-selfcontained-"));
    const copied = join(dir, "dist.mjs");
    copyFileSync(ARTIFACT, copied);

    const { stdout, stderr } = await runInitialize(dir, copied);

    assert.ok(
      !stderr.includes("ERR_MODULE_NOT_FOUND"),
      `the #376 failure is back — the artifact imports an unbundled dep:\n${stderr.slice(0, 500)}`,
    );
    assert.ok(
      !stderr.includes("Dynamic require"),
      `esbuild ESM require-shim crash — the createRequire banner is missing:\n${stderr.slice(0, 500)}`,
    );
    const line = stdout.split("\n").find((l) => l.includes('"jsonrpc"'));
    assert.ok(
      line,
      `no JSON-RPC response line on stdout.\nstdout: ${stdout.slice(0, 300)}\nstderr: ${stderr.slice(0, 500)}`,
    );
    const resp = JSON.parse(line as string);
    assert.equal(resp.id, 1);
    assert.ok(resp.result, "initialize returned no result");
    assert.equal(resp.result.serverInfo?.name, "autonomos");
  });
});
