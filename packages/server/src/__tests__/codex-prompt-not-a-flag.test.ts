import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { codexProvider } from "../providers/codex.js";
import {
  _resetServerStateForTesting,
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "../serverState.js";

/**
 * Security audit V11: a Codex agent's starting prompt was pushed onto argv with
 * no `--` before it, so codex parsed a prompt that looks like a flag AS a flag.
 * Measured on codex-cli 0.157.1: a prompt of `--help` printed help and
 * `--bogus-flag` was rejected as an unexpected argument. So a prompt of
 * `--dangerously-bypass-approvals-and-sandbox` would run the child with no
 * approvals or sandbox while its record, pill and approval UI still said
 * "ask". Benign prompts such as "- fix X" also broke spawns.
 *
 * The guard: on every argv path, the prompt comes after a `--`, so codex (clap)
 * treats it as the positional prompt whatever it starts with. Asserted on the
 * real buildArgs.
 */

const BYPASS = "--dangerously-bypass-approvals-and-sandbox";
let dir: string;

function options(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
  return {
    workingDirectory: "/tmp",
    cwd: "/tmp",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "V11",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    permissionMode: "ask",
    prompt: BYPASS,
    // The rest of ResolvedSpawnOptions' required shape (as in
    // provider-url-token.test.ts); none of it touches the prompt.
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "53917",
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:53917",
    ...overrides,
  };
}

/** The flags codex would parse: everything before the first `--`. */
function flagRegion(args: string[]): string[] {
  const i = args.indexOf("--");
  return i === -1 ? args : args.slice(0, i);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aos-v11-"));
  _setConfigDirForTesting(dir);
  setServerPort(53917);
  setAuthToken("v11-test-token");
  setInternalSocketPath("/tmp/aos-test/control.sock");
});

after(() => {
  _resetConfigDirForTesting();
  _resetServerStateForTesting();
  rmSync(dir, { recursive: true, force: true });
});

const PATHS: Array<[string, Partial<ResolvedSpawnOptions>]> = [
  [
    "fresh spawn (TUI --remote the daemon)",
    { sidecarEndpoint: "unix:///tmp/x.sock" },
  ],
  [
    "resume (codex resume <thread> --remote)",
    {
      sidecarEndpoint: "unix:///tmp/x.sock",
      providerThreadId: "01a0f000-0000-7000-8000-000000000000",
    },
  ],
  ["legacy (no daemon)", {}],
];

describe("a Codex prompt is never parsed as a flag (audit V11)", () => {
  for (const [label, extra] of PATHS) {
    it(`${label}: an ask agent's flag-shaped prompt can't grant bypass`, () => {
      const args = codexProvider.buildArgs(options(extra));
      assert.ok(
        !flagRegion(args).includes(BYPASS),
        `bypass would be PARSED AS A FLAG: ${JSON.stringify(args)}`,
      );
      // It is still delivered, as the positional prompt after `--`.
      assert.deepEqual(args.slice(-2), ["--", BYPASS]);
    });

    it(`${label}: a prompt starting with "-" reaches codex as text`, () => {
      const prompt = "- fix the failing test";
      const args = codexProvider.buildArgs(options({ ...extra, prompt }));
      assert.deepEqual(args.slice(-2), ["--", prompt]);
    });

    it(`${label}: no prompt means no stray "--"`, () => {
      const args = codexProvider.buildArgs(
        options({ ...extra, prompt: undefined }),
      );
      assert.ok(!args.includes("--"), JSON.stringify(args));
    });
  }

  it("a real bypass agent still gets the flag, in the flag region", () => {
    const args = codexProvider.buildArgs(
      options({
        sidecarEndpoint: "unix:///tmp/x.sock",
        permissionMode: "bypass",
        prompt: "hello",
      }),
    );
    assert.ok(flagRegion(args).includes(BYPASS), JSON.stringify(args));
  });
});
