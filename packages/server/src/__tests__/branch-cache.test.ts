import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetBranchCacheForTesting,
  _setBranchResolverForTesting,
  getCachedBranch,
} from "../agents/branchCache.js";

/**
 * branchCache resolves an agent's git branch for the dashboard statusline. It's
 * async + cached (never blocks the /api/agents response), so the first read is a
 * cold miss (null) and the value appears on a later read once the background
 * resolve lands.
 *
 * The tests inject a fake resolver rather than spawn real `git`: a subprocess
 * under the shared test runner adds CPU contention that flakes timing-sensitive
 * sibling suites (e.g. promptDelivery's 50ms windows). The real git command is a
 * fixed, shell-free execFile mirroring the proven providers/statusline.mjs.
 */

/** Let the resolver's microtask settle before re-reading the cache. */
const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  _resetBranchCacheForTesting();
  _setBranchResolverForTesting(); // restore the real git resolver
});

describe("branchCache", () => {
  it("returns null on the cold read, then the resolved branch (non-blocking)", async () => {
    _setBranchResolverForTesting(async () => ({ ok: true, branch: "main" }));
    // Cold read must return immediately (null) — never block on resolution.
    assert.equal(getCachedBranch("/repo"), null);
    await tick();
    assert.equal(getCachedBranch("/repo"), "main");
  });

  it("serves from cache without re-resolving while fresh", async () => {
    let calls = 0;
    _setBranchResolverForTesting(async () => {
      calls++;
      return { ok: true, branch: "main" };
    });
    getCachedBranch("/repo"); // cold → one resolve
    await tick();
    assert.equal(getCachedBranch("/repo"), "main");
    assert.equal(getCachedBranch("/repo"), "main");
    assert.equal(calls, 1); // fresh entries are served from cache, not re-resolved
  });

  it("stays null when the resolver reports failure (not a repo / git error)", async () => {
    _setBranchResolverForTesting(async () => ({ ok: false }));
    getCachedBranch("/plain");
    await tick();
    assert.equal(getCachedBranch("/plain"), null);
  });

  it("only starts one in-flight resolve per cwd", async () => {
    let calls = 0;
    _setBranchResolverForTesting(async () => {
      calls++;
      return { ok: true, branch: "main" };
    });
    // Three synchronous cold reads before the first resolve settles → still one
    // resolve (the refreshing guard blocks concurrent kicks).
    getCachedBranch("/repo");
    getCachedBranch("/repo");
    getCachedBranch("/repo");
    await tick();
    assert.equal(calls, 1);
  });
});
