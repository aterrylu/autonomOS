import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../cli-args.js";

/**
 * L1 guard (ADR-158): autonomOS never takes a client's identity from a proxy
 * header. The tailscale serve mode that read X-Forwarded-For /
 * Tailscale-User-Login (ADR-140) was removed: any local process could forge
 * them. If a header-trust path comes back, this fails; bring it back only with
 * a new ADR (see #530 for the owner-only-socket design that was signed off).
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function serverSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...serverSources(p));
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

describe("no proxy-header identity (ADR-158)", () => {
  it("no server source reads X-Forwarded-For or Tailscale-User-Login", () => {
    const files = serverSources(SRC);
    assert.ok(
      files.length > 50,
      `scanned the server sources (${files.length})`,
    );
    const hits = files.filter((f) =>
      // A header is read by its name as a string literal; prose (a comment
      // stating this very rule) doesn't count.
      /["'`](x-forwarded-for|tailscale-user-login)["'`]/i.test(
        readFileSync(f, "utf8"),
      ),
    );
    assert.deepEqual(
      hits.map((f) => f.slice(SRC.length)),
      [],
      "a proxy identity header is read again; that needs a new ADR (see ADR-158)",
    );
  });

  it("the removed --trust-proxy flag is still PARSED, so boot can refuse it with a real message", () => {
    assert.equal(
      parseCliArgs(["--trust-proxy=tailscale"]).trustProxy,
      "tailscale",
    );
    // A bare flag is present, and never swallows the next argument.
    const bare = parseCliArgs(["--trust-proxy", "--host=127.0.0.1"]);
    assert.equal(bare.trustProxy, "(set)");
    assert.equal(bare.host, "127.0.0.1");
    assert.equal(parseCliArgs([]).trustProxy, undefined);
  });
});
