/**
 * END-TO-END through the real spawnAgent reattach path (ADR-111), with a fake
 * Claude-like provider (a real PTY running `/bin/sh -c sleep`). Pins what
 * spawnAgent DOES when the resume pre-flight says "no saved session": it must
 * start fresh under a NEW providerSessionId — never reuse the old one, because
 * CC may still know it (e.g. filed under a path the probe missed) and a fresh
 * `--session-id <known id>` dies with "Session ID … is already in use".
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type {
  AgentProvider,
  ResolvedSpawnOptions,
  UUID,
} from "@autonomos/core";
import { isolateHome } from "./helpers/isolate-home.js";

// The fake provider spreads claudeCodeProvider, so every spawn runs the REAL
// prepareSpawn pre-trust. Isolate BEFORE any server import, or it writes this
// suite's temp cwd into the operator's real ~/.claude.json on every run.
const isolated = isolateHome("aos-cc-regen");
const CONFIG_DIR = `/tmp/aos-cc-regen-${randomUUID()}`;
process.env.AUTONOMOS_CONFIG_DIR = CONFIG_DIR;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53922);
setAuthToken("test-token-cc-regen-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-rg-${randomUUID().slice(0, 8)}.sock`),
);
const { spawnAgent, killAttachment } = await import("../agents/runtime.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { claudeCodeProvider } = await import("../providers/claude-code.js");
const {
  buildAgent,
  insertAgent,
  getAgent,
  markExited,
  getAgentByProviderSessionId,
  _resetCacheForTesting,
} = await import("../agents/store.js");
const { getNotifications, clearNotifications } = await import(
  "../routes/hooks.js"
);

const NAME = "fakeclaude";
const cwd = mkdtempSync(join(tmpdir(), "aos-cc-regen-"));
let seen: ResolvedSpawnOptions[] = [];
let probeEnvs: Array<Record<string, string | undefined> | undefined> = [];
let resumable = true;

const fake: AgentProvider = {
  ...claudeCodeProvider,
  name: NAME as never,
  displayName: "FakeClaude",
  resolveBinary: () => "/bin/sh",
  buildArgs: (r: ResolvedSpawnOptions) => {
    seen.push({ ...r });
    return ["-c", "sleep 30"];
  },
  attachStartupWatcher: undefined,
  hasResumableSession: (_opts, env) => {
    probeEnvs.push(env);
    return resumable;
  },
};

const ids: string[] = [];
function seed(): UUID {
  const id = randomUUID() as UUID;
  ids.push(id);
  insertAgent(
    buildAgent({
      id,
      name: `fcl-${id.slice(0, 4)}`,
      workingDirectory: cwd,
      provider: NAME as never,
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  markExited(id, "user_killed");
  return id;
}

beforeEach(() => {
  _setProviderForTesting(NAME, fake);
  seen = [];
  probeEnvs = [];
  resumable = true;
});
afterEach(() => {
  for (const id of ids.splice(0)) {
    killAttachment(id as UUID);
    clearNotifications(id);
  }
});
after(() => {
  _resetCacheForTesting();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  isolated.restore();
});

describe("CC reattach pre-flight (ADR-111)", () => {
  it("NOT resumable → fresh under a NEW providerSessionId (never the old one)", async () => {
    const id = seed();
    const old = getAgent(id)?.providerSessionId;
    resumable = false;
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });

    const argv = seen.at(-1);
    assert.ok(argv, "buildArgs ran");
    assert.equal(argv.resumeSessionId, undefined, "no --resume");
    assert.notEqual(
      argv.providerSessionId,
      old,
      "fresh spawn must not reuse the old id",
    );
    // The record follows the process (same channel as the onExit net's regen)…
    const rec = getAgent(id);
    assert.equal(rec?.providerSessionId, argv.providerSessionId);
    // …so consumers that resolve by providerSessionId find the agent by the NEW id.
    assert.equal(getAgentByProviderSessionId(argv.providerSessionId)?.id, id);
    assert.equal(getAgentByProviderSessionId(old as string), undefined);
    // User-visible notice still says what happened.
    assert.ok(
      getNotifications(id).some((n) =>
        /no saved FakeClaude session to resume/.test(n.message ?? ""),
      ),
      "fresh-start notice pushed",
    );
  });

  it("resumable → --resume with the SAME id (unchanged)", async () => {
    const id = seed();
    const old = getAgent(id)?.providerSessionId;
    resumable = true;
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    const argv = seen.at(-1);
    assert.equal(argv?.resumeSessionId, old);
    assert.equal(argv?.providerSessionId, old);
    assert.equal(getAgent(id)?.providerSessionId, old);
  });

  it("the probe receives the CHILD's final env (so a preset-relocated CLAUDE_CONFIG_DIR is honored)", async () => {
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    const env = probeEnvs.at(-1);
    assert.ok(env, "probe was called with an env");
    assert.equal(
      typeof env.PATH,
      "string",
      "it is the built child env, not undefined",
    );
  });

  it("pre-trusts into the throwaway config, NEVER the operator's real ~/.claude.json", async () => {
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    const key = realpathSync(cwd);
    // Precondition: the pre-trust ran, and landed where isolation points it —
    // without this, "absent from the real file" could pass because nothing ran.
    assert.ok(
      isolated.fakeTrustKeys().has(key),
      "spawn pre-trusted its cwd in the isolated .claude.json",
    );
    assert.ok(
      !isolated.realTrustKeys().has(key),
      `leaked a trust entry for ${key} into the real .claude.json`,
    );
  });
});
