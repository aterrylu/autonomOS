/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — a REAL `claude` resumes
 * across kill → attach when its cwd is a SYMLINK (ADR-111).
 *
 * Before the fix, CC filed the session under the realpath while the resume
 * probe looked at the unresolved path, so every reattach took the "no saved
 * session" branch and started fresh with the SAME --session-id → CC exited 1
 * ("Session ID … is already in use") → agent crashed. On macOS `/var` is a
 * symlink, so this hit every `os.tmpdir()` cwd. The unit tests pin the probe;
 * this pins the whole path with the real binary: after the first turn, two
 * kill → attach rounds must each `--resume` and stay running.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type MockAnthropic,
  startMockAnthropic,
} from "./helpers/mock-anthropic.js";
import {
  authedJson,
  type BootedServer,
  bootServer,
  RUN_INTEGRATION,
  sleep,
  waitFor,
} from "./helpers/test-server.js";

interface AgentRecord {
  id: string;
  status: "running" | "exited";
}

describe("CC resume on a symlinked cwd — real spawn", {
  skip: !RUN_INTEGRATION,
  timeout: 150_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const root = mkdtempSync(join(tmpdir(), "autonomos-symlink-cwd-"));
  const realDir = join(root, "real");
  const linkDir = join(root, "link");

  before(async () => {
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    mock = await startMockAnthropic({ mode: "text", text: "ok" });
    server = await bootServer({
      anthropicBaseUrl: mock.url,
      anthropicAuthToken: "sk-mock",
    });
  });

  after(async () => {
    if (server) {
      server.kill();
      rmSync(server.configDir, { recursive: true, force: true });
    }
    await mock?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const status = async (id: string): Promise<string | undefined> => {
    const r = await authedJson<AgentRecord[]>(server, "/api/agents");
    return r.body.find((a) => a.id === id)?.status;
  };

  it("kill → attach twice: each round --resumes and stays running", async () => {
    const created = await authedJson<AgentRecord>(server, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "symlink-resume",
        workingDirectory: linkDir,
        prompt: "Reply with just the word ok",
      }),
    });
    assert.equal(created.status, 201, server.logs());
    const id = created.body.id;

    // First turn lands → CC writes the JSONL (under the realpath).
    const turned = await waitFor(
      async () => mock.requests.some((r) => r.url.includes("/messages")),
      { timeoutMs: 60_000 },
    );
    assert.ok(
      turned,
      `the first turn never reached the mock\n${server.logs()}`,
    );
    await sleep(3000);

    for (let round = 1; round <= 2; round++) {
      await authedJson(server, `/api/agents/${id}/kill`, { method: "POST" });
      await waitFor(async () => (await status(id)) === "exited", {
        timeoutMs: 15_000,
      });
      const at = await authedJson(server, `/api/agents/${id}/attach`, {
        method: "POST",
      });
      assert.equal(at.status, 200, `attach round ${round}\n${server.logs()}`);
      // "already in use" dies in ~0.2s; give the process time to prove it lives.
      await sleep(5000);
      assert.equal(
        await status(id),
        "running",
        `round ${round}: agent did not survive the reattach\n${server.logs()}`,
      );
    }
    const resumes = server
      .logs()
      .split("\n")
      .filter((l) => l.includes("spawning:") && l.includes("--resume "));
    assert.ok(
      resumes.length >= 2,
      `expected both reattaches to --resume, saw ${resumes.length}\n${server.logs()}`,
    );
  });
});
