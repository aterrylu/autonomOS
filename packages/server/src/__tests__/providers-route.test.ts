/**
 * GET /api/providers carries each installed CLI's version and the drift
 * probe's verdict on its permission options. Before the probe, `version` was
 * always null.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider, ProviderInfo } from "@autonomos/core";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { _setProviderForTesting } from "../providers/index.js";
import { providerRouter } from "../routes/providers.js";
import { _resetRuntimeProbeCacheForTesting } from "../runtimeProbe.js";

let dir: string | undefined;
after(() => {
  _setProviderForTesting("claude-code", null);
  _resetRuntimeProbeCacheForTesting();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/providers", () => {
  it("reports the installed CLI's version and a clean permission check", async () => {
    dir = mkdtempSync(join(tmpdir(), "aos-providers-route-"));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.282 (Claude Code)"; exit 0; fi
echo "error: option '--permission-mode <mode>' argument '__probe__' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan." >&2
exit 1
`,
    );
    chmodSync(bin, 0o755);
    const fake: AgentProvider = {
      ...claudeCodeProvider,
      resolveBinary: () => bin,
    };
    _setProviderForTesting("claude-code", fake);

    const res = await providerRouter.request("/");
    assert.equal(res.status, 200);
    const cc = ((await res.json()) as ProviderInfo[]).find(
      (p) => p.name === "claude-code",
    );
    assert.ok(cc, "claude-code listed");
    assert.equal(cc.installed, true);
    assert.equal(cc.version, "2.1.282");
    assert.equal(cc.permissionCheck?.error, undefined);
    assert.deepEqual(
      cc.permissionCheck?.axes.map((a) => a.rejected),
      [[]],
    );
  });
});
