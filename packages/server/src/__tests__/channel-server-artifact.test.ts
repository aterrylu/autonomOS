// Staleness guard for the TRACKED channel-server build artifact.
//
// dist.mjs is committed and only `make prod`'s esbuild line regenerates it —
// the release workflow copies it verbatim (build-binary stageRuntimeScripts).
// A source-side fix in mcp/tools.ts that isn't followed by a rebuild ships
// nothing to the channel server every spawned agent talks to. That is not
// hypothetical: MCP_SERVER_INFO.version sat hand-frozen at "0.3.0" in the
// artifact for two minor releases, and the fix for THAT was itself nearly
// shipped without the rebuild (caught in review). This test pins the
// mechanism: the artifact must resolve its version at runtime, not carry a
// frozen literal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const artifactPath = resolve(import.meta.dirname, "../channel-server/dist.mjs");

describe("channel-server dist.mjs artifact", () => {
  it("resolves its MCP version at runtime (no frozen version literal)", () => {
    const artifact = readFileSync(artifactPath, "utf-8");
    assert.ok(
      artifact.includes("getServerVersion"),
      "dist.mjs does not reference getServerVersion — it was built before " +
        "the runtime-version fix, or the version mechanism changed without " +
        "updating this guard. Rebuild with the esbuild line in `make prod` " +
        "and commit the regenerated artifact.",
    );
    assert.doesNotMatch(
      artifact,
      /MCP_SERVER_INFO\s*=\s*\{[^}]*version:\s*"\d+\.\d+\.\d+"/,
      "dist.mjs carries a frozen MCP_SERVER_INFO version literal — rebuild " +
        "the artifact (make prod's esbuild line) so the runtime resolver ships.",
    );
  });
});
