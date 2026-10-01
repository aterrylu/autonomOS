import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Security audit V9: the L2 perf harness (`perf/run-l2.sh`) runs the server
 * with AUTONOMOS_PERF=1, which DROPS auth on the public listener (loopback
 * bind enforced by the server). But it started vite with no `--host`, so vite
 * fell back to dashboard/vite.config.ts's `host: "0.0.0.0"` and proxied /api
 * and /ws, unauthenticated, to anyone on the contributor's LAN for as long as
 * the harness ran (the audit's PoC: an unauthenticated POST through the proxy
 * spawned an agent).
 *
 * The guard: every vite the harness starts binds 127.0.0.1. A CLI `--host`
 * overrides the config file's host (verified live for this fix with lsof).
 */

const SCRIPT = join(import.meta.dirname, "..", "..", "perf", "run-l2.sh");

/** The script's vite command lines, with `\`-continued lines joined. */
function viteInvocations(script: string): string[] {
  const joined = script.replace(/\\\n\s*/g, " ");
  return joined
    .split("\n")
    .filter(
      (l) =>
        !l.trim().startsWith("#") && /\bvite\b/.test(l) && /--port\b/.test(l),
    );
}

describe("perf harness: vite never binds beyond loopback (audit V9)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const vites = viteInvocations(script);

  it("finds the harness's vite invocation (precondition)", () => {
    assert.ok(vites.length >= 1, "no vite invocation found in run-l2.sh");
  });

  it("every vite invocation binds 127.0.0.1", () => {
    for (const line of vites) {
      assert.match(
        line,
        /--host[ =]127\.0\.0\.1\b/,
        `vite would bind the config's 0.0.0.0 and proxy the auth-free API to the LAN: ${line.trim()}`,
      );
    }
  });

  it("nothing in the harness binds all interfaces", () => {
    assert.doesNotMatch(script, /--host[ =](0\.0\.0\.0|::)\b/);
  });
});
