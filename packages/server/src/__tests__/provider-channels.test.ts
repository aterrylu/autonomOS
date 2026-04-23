import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { claudeCodeProvider } from "../providers/claude-code.js";

/**
 * Regression coverage for the central question: can a single CC session
 * spawn with multiple channels including `server:autonomos`? The provider
 * splits by prefix into --dangerously-load-development-channels (for
 * `server:*`) and --channels (for everything else).
 *
 * Empirical validation lives in manual QA; this test guards the
 * argument-construction layer from regressing silently.
 */

let tmpDir: string;

function baseOptions(): ResolvedSpawnOptions {
  return {
    workingDirectory: "/tmp",
    cwd: "/tmp",
    sessionId: "test-session-id",
    agentName: "TestAgent",
    providerSessionId: "00000000-0000-4000-8000-000000000000",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "3101",
    capabilities: [],
  };
}

function writeSettings(channels: string[] | null): void {
  const body: Record<string, unknown> = {};
  if (channels !== null) body.channels = channels;
  writeFileSync(
    join(tmpDir, "settings.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe("claudeCodeProvider.buildArgs — channel flags", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-channels-"));
    _setConfigDirForTesting(tmpDir);
  });

  after(() => {
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeSettings([]);
  });

  afterEach(() => {
    writeSettings([]);
  });

  it("defaults to server:autonomos when settings omit the key", () => {
    // An omitted channels key falls back to DEFAULT_CHANNELS = ["server:autonomos"]
    writeSettings(null);
    const args = claudeCodeProvider.buildArgs(baseOptions());
    assert.ok(
      args.includes("--dangerously-load-development-channels"),
      "dev-channels flag should be present for default server:autonomos",
    );
    assert.ok(
      args.includes("server:autonomos"),
      "default server:autonomos should be in args",
    );
    assert.ok(
      !args.includes("--channels"),
      "no --channels flag when only server: channels configured",
    );
  });

  it("emits --channels only for official plugin entries", () => {
    writeSettings(["plugin:telegram@claude-plugins-official"]);
    const args = claudeCodeProvider.buildArgs(baseOptions());
    assert.ok(args.includes("--channels"));
    assert.ok(args.includes("plugin:telegram@claude-plugins-official"));
    assert.ok(!args.includes("--dangerously-load-development-channels"));
  });

  it("splits the mixed case: server:autonomos + telegram + discord", () => {
    // This is the triple-channel case Terry explicitly asked about.
    writeSettings([
      "server:autonomos",
      "plugin:telegram@claude-plugins-official",
      "plugin:discord@claude-plugins-official",
    ]);
    const args = claudeCodeProvider.buildArgs(baseOptions());

    const devIdx = args.indexOf("--dangerously-load-development-channels");
    const offIdx = args.indexOf("--channels");
    assert.ok(devIdx >= 0, "dev-channels flag must be present");
    assert.ok(offIdx >= 0, "official-channels flag must be present");

    // Dev flag followed by server:autonomos
    assert.equal(args[devIdx + 1], "server:autonomos");

    // Official flag followed by telegram and discord (variadic, in order)
    assert.deepEqual(args.slice(offIdx + 1, offIdx + 3), [
      "plugin:telegram@claude-plugins-official",
      "plugin:discord@claude-plugins-official",
    ]);
  });

  it("emits neither flag when channels is an explicit empty array", () => {
    writeSettings([]);
    const args = claudeCodeProvider.buildArgs(baseOptions());
    assert.ok(!args.includes("--channels"));
    assert.ok(!args.includes("--dangerously-load-development-channels"));
  });
});
