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
 * Regression coverage for channel flag construction: `server:*` channels
 * are emitted via --dangerously-load-development-channels, and nothing
 * else can ever reach argv (plugin channels were removed; stale entries
 * in old settings.json files are dropped by the settings sanitizer).
 *
 * Empirical validation lives in manual QA; this test guards the
 * argument-construction layer from regressing silently.
 */

let tmpDir: string;

function baseOptions(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
  return {
    workingDirectory: "/tmp",
    cwd: "/tmp",
    sessionId: "test-session-id",
    agentName: "Dispatcher",
    providerSessionId: "00000000-0000-4000-8000-000000000000",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "3101",
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:3101",

    ...overrides,
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

  it("never emits --channels or plugin entries, even from stale settings", () => {
    // Simulates an old settings.json written before plugin channels were
    // removed. The settings sanitizer drops the stale entry, and the
    // provider's defensive filter guarantees it can't reach argv.
    writeSettings([
      "server:autonomos",
      "plugin:telegram@claude-plugins-official",
      "plugin:discord@claude-plugins-official",
    ]);
    const args = claudeCodeProvider.buildArgs(baseOptions());
    assert.ok(!args.includes("--channels"));
    assert.ok(!args.includes("plugin:telegram@claude-plugins-official"));
    assert.ok(!args.includes("plugin:discord@claude-plugins-official"));
    // server:* still goes through.
    assert.ok(args.includes("--dangerously-load-development-channels"));
    assert.ok(args.includes("server:autonomos"));
  });

  it("emits neither flag when channels is an explicit empty array", () => {
    writeSettings([]);
    const args = claudeCodeProvider.buildArgs(baseOptions());
    assert.ok(!args.includes("--channels"));
    assert.ok(!args.includes("--dangerously-load-development-channels"));
  });
});
