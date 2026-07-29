import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import * as scriptPaths from "../scriptPaths.js";
import {
  CHANNEL_SERVER_SCRIPT,
  RUNTIME_SCRIPTS,
  STATUSLINE_SCRIPT,
} from "../scriptPaths.js";

/**
 * Guards the runtime-script staging contract (desktop statusline outage,
 * see scriptPaths.ts). Three invariants:
 *
 *   1. Every RUNTIME_SCRIPTS entry exists in the source tree — build-binary's
 *      stageRuntimeScripts() copies exactly this list into the bundle.
 *   2. Every exported script-path constant is covered by RUNTIME_SCRIPTS —
 *      a new constant resolved at runtime but absent from the staging list
 *      would ship a bundle that silently lacks the file.
 *   3. The --settings statusLine.command the provider hands to spawned CC
 *      sessions points at a file that actually exists. CC swallows statusline
 *      command failures, so a dangling path here is invisible at runtime.
 *
 * The bundle side of the same contract is asserted by smoke-test-bundle.sh
 * against the staged .app resources.
 */

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("scriptPaths — runtime script staging contract", () => {
  it("every RUNTIME_SCRIPTS entry exists in the source tree", () => {
    for (const rel of RUNTIME_SCRIPTS) {
      assert.ok(
        existsSync(resolve(SRC_ROOT, rel)),
        `RUNTIME_SCRIPTS lists "${rel}" but src/${rel} does not exist — ` +
          `the staging list in scriptPaths.ts is out of sync with the tree`,
      );
    }
  });

  it("every exported script constant is covered by RUNTIME_SCRIPTS", () => {
    // Derive the constants from the module's exports rather than hand-listing
    // them — a new `FOO_SCRIPT` constant added without a RUNTIME_SCRIPTS entry
    // must fail HERE, not ship a bundle that silently lacks the file.
    const exportedScripts = Object.values(scriptPaths).filter(
      (v): v is string => typeof v === "string" && v.endsWith(".mjs"),
    );
    assert.ok(
      exportedScripts.length >= 2,
      "expected at least the statusline + channel-server script constants",
    );
    for (const script of exportedScripts) {
      const covered = RUNTIME_SCRIPTS.some((rel) => script.endsWith(`/${rel}`));
      assert.ok(
        covered,
        `${script} is not staged by any RUNTIME_SCRIPTS entry — ` +
          `the bundled server would resolve a path that was never copied in`,
      );
      assert.ok(existsSync(script), `${script} does not exist`);
    }
  });
});

describe("claudeCodeProvider.buildArgs — statusLine command path", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-statusline-path-"));
    _setConfigDirForTesting(tmpDir);
  });

  after(() => {
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildSettingsPayload(settingsJson: string): {
    statusLine?: { type: string; command: string };
  } {
    writeFileSync(join(tmpDir, "settings.json"), settingsJson, {
      mode: 0o600,
    });
    const options: ResolvedSpawnOptions = {
      workingDirectory: "/tmp",
      cwd: "/tmp",
      sessionId: "test-session-id",
      agentName: "Worker",
      providerSessionId: "00000000-0000-4000-8000-000000000000",
      injectChannelServer: false,
      channelServerScript: CHANNEL_SERVER_SCRIPT,
      serverPort: "3101",
      socketPath: "/tmp/aos-test/control.sock",
      apiUrl: "http://localhost:3101",
    };
    const args = claudeCodeProvider.buildArgs(options);
    const settingsIdx = args.indexOf("--settings");
    assert.ok(settingsIdx >= 0, "--settings flag must be present");
    return JSON.parse(args[settingsIdx + 1]);
  }

  it("emits a statusLine command pointing at an existing file", () => {
    // statusLine defaults to enabled when settings omit the key.
    const payload = buildSettingsPayload("{}\n");
    assert.ok(payload.statusLine, "statusLine should default to enabled");
    assert.equal(payload.statusLine.type, "command");

    // command is `node ${JSON.stringify(path)}` — recover the path losslessly.
    assert.ok(payload.statusLine.command.startsWith("node "));
    const scriptPath = JSON.parse(
      payload.statusLine.command.slice("node ".length),
    ) as string;
    assert.equal(scriptPath, STATUSLINE_SCRIPT);
    assert.ok(
      existsSync(scriptPath),
      `statusLine command points at missing file: ${scriptPath}`,
    );
  });

  it("omits statusLine when settings disable it", () => {
    const payload = buildSettingsPayload(
      '{ "statusLine": { "enabled": false } }\n',
    );
    assert.equal(
      payload.statusLine,
      undefined,
      "statusLine must not be injected when explicitly disabled",
    );
  });
});
