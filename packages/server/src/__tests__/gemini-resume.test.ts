/**
 * Gemini keeps its conversation across a restart (measured on 0.46): a fresh
 * spawn names the session with OUR id (`--session-id`), a respawn resumes it
 * (`--resume <id>`), and the pre-flight looks where the CHILD's Gemini will.
 * Before this, every Gemini restart silently started a brand-new chat.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";

process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-gemres-"));
const { geminiCliProvider } = await import("../providers/gemini-cli.js");

const ID = "6579618b-70f4-4830-9c63-646b23b7f3d9";
const opts = (o: Partial<ResolvedSpawnOptions> = {}) =>
  ({
    workingDirectory: "/w/g",
    cwd: "/w/g",
    sessionId: ID,
    agentName: "g",
    providerSessionId: ID,
    injectChannelServer: false,
    channelServerScript: "/x",
    serverPort: "1",
    socketPath: "/x",
    apiUrl: "http://x",
    ...o,
  }) as ResolvedSpawnOptions;

const home = mkdtempSync(join(tmpdir(), "aos-gemres-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

describe("gemini-cli conversation identity", () => {
  it("a fresh spawn names the session with the agent's id", () => {
    const args = geminiCliProvider.buildArgs(opts());
    assert.equal(args[args.indexOf("--session-id") + 1], ID);
    assert.ok(!args.includes("--resume"));
  });
  it("a respawn resumes that exact session (and never also names a new one)", () => {
    const args = geminiCliProvider.buildArgs(opts({ resumeSessionId: ID }));
    assert.equal(args[args.indexOf("--resume") + 1], ID);
    assert.ok(!args.includes("--session-id"));
  });
  it("the pre-flight reads the CHILD's GEMINI_CLI_HOME", () => {
    const has = (env: Record<string, string>) =>
      geminiCliProvider.hasResumableSession?.(
        opts({ resumeSessionId: ID }),
        env,
      );
    assert.equal(has({ GEMINI_CLI_HOME: home }), false, "positively absent");
    const dir = join(home, ".gemini", "tmp", "g");
    mkdirSync(join(dir, "chats"), { recursive: true });
    writeFileSync(join(dir, ".project_root"), "/w/g");
    writeFileSync(
      join(dir, "chats", `session-2026-09-26T00-00-${ID.slice(0, 8)}.jsonl`),
      `${JSON.stringify({ sessionId: ID, kind: "main" })}\n`,
    );
    assert.equal(has({ GEMINI_CLI_HOME: home }), true);
  });
});
