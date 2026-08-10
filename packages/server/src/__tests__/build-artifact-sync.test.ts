// Sync guard between BUILD_MUTATED_TRACKED_FILES and the Makefile `build`
// target. The list exempts specific tracked paths from the source-mode
// dirty-tree refusal BECAUSE the build regenerates them — if the build
// target changes (renamed output, new tracked artifact) without the list
// following, the dirty-forever refusal bug silently returns. This test ties
// the list to the Makefile text so a drift breaks CI instead of a
// production box.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { BUILD_MUTATED_TRACKED_FILES } from "../sourceUpgrade.js";

const makefile = readFileSync(
  resolve(import.meta.dirname, "../../../../Makefile"),
  "utf-8",
);

describe("BUILD_MUTATED_TRACKED_FILES ↔ Makefile build target", () => {
  it("every exempted path is still produced by the build", () => {
    // dist.mjs must appear as an esbuild outfile; bun.lock is implied by
    // `bun install` (which rewrites the lockfile on resolution drift).
    assert.ok(
      makefile.includes("packages/server/src/channel-server/dist.mjs"),
      "Makefile no longer writes channel-server/dist.mjs — remove it from " +
        "BUILD_MUTATED_TRACKED_FILES (a stale exemption silently discards " +
        "tracked edits).",
    );
    assert.ok(
      /\bbun(x)? install\b|\$\(BUN\) install/.test(makefile),
      "Makefile no longer runs bun install — remove bun.lock from " +
        "BUILD_MUTATED_TRACKED_FILES.",
    );
    // The list itself should stay exactly the audited pair; growing it
    // means new tracked build outputs, which deserve a fresh review of
    // whether they should be tracked at all.
    assert.deepEqual(
      [...BUILD_MUTATED_TRACKED_FILES],
      ["packages/server/src/channel-server/dist.mjs", "bun.lock"],
    );
  });
});
