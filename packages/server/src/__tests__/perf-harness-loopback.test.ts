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

  // `--host` given an all-interfaces address, or with no value at all (vite
  // treats a bare --host as all interfaces). (The previous pattern ended in a
  // word boundary, which can never follow ":", so it never caught "::"; nox
  // on #476.)
  const ALL_INTERFACES =
    /--host(?:[ =](?:0\.0\.0\.0|::|\[::\])(?=\s|"|$)|(?=\s+--|\s*$))/m;

  it("the all-interfaces pattern catches what it claims to", () => {
    for (const bad of [
      "--host ::",
      "--host=::",
      "--host [::]",
      "--host 0.0.0.0 --port 1",
      "vite --host --port 5",
      "vite --host",
    ]) {
      assert.match(bad, ALL_INTERFACES, bad);
    }
    for (const ok of [
      "--host 127.0.0.1 --port 5",
      "--host=127.0.0.1",
      "--host ::1",
    ]) {
      assert.doesNotMatch(ok, ALL_INTERFACES, ok);
    }
  });

  it("nothing in the harness binds all interfaces", () => {
    assert.doesNotMatch(script, ALL_INTERFACES);
  });
});
