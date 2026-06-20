import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const TEST_DIR = join(tmpdir(), `autonomos-test-harvest-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
delete process.env.CLAUDE_SESSION_KEY;
delete process.env.CLAUDE_SESSION_COOKIE;

const { claudeUsageRouter } = await import("../plugins/claude-usage/route.js");
const { resolveSessionKey } = await import(
  "../plugins/claude-usage/scanner.js"
);
const { setHarvestedSessionKey } = await import(
  "../plugins/claude-usage/sessionStore.js"
);
const { COOKIE_RELAY_CMD } = await import("../providers/shared.js");
const { isLoopbackBind } = await import("../run.js");

const SETTINGS_FILE = join(TEST_DIR, "settings.json");
const VALID = "sk-ant-sid02-abcdefghijklmnop";

function postSession(body: string) {
  return claudeUsageRouter.request("/session", {
    method: "POST",
    body,
  });
}

describe("claude-usage harvest endpoint", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify({}));
    setHarvestedSessionKey(null);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    setHarvestedSessionKey(null);
  });

  it("stores a relayed session cookie and resolves it as 'harvested'", async () => {
    const res = await postSession(VALID);
    assert.equal(res.status, 204);
    assert.deepEqual(resolveSessionKey(), { key: VALID, source: "harvested" });
  });

  it("ignores a payload that isn't a claude.ai session cookie", async () => {
    await postSession("sk-ant-oat01-not-a-session-cookie");
    assert.equal(resolveSessionKey(), null);
    await postSession("garbage");
    assert.equal(resolveSessionKey(), null);
  });

  it("rejects a cookie containing header-injection characters", async () => {
    // CR/LF or ';' would let a value smuggle extra Cookie-header content.
    await postSession("sk-ant-sid02-abc\r\nX-Injected: 1");
    assert.equal(resolveSessionKey(), null);
    await postSession("sk-ant-sid02-abc; evil=1");
    assert.equal(resolveSessionKey(), null);
  });

  it("does not store anything when auto-detect is disabled", async () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ autoDetectClaudeSession: false }),
    );
    const res = await postSession(VALID);
    assert.equal(res.status, 204);
    // Nothing held in memory, and resolution stays null.
    assert.equal(resolveSessionKey(), null);
  });

  it("auth exemption is gated on a loopback bind", () => {
    // The unauthenticated harvest endpoint is safe only on loopback; a remote
    // bind must NOT exempt it (it would be a credential-injection vector).
    assert.equal(isLoopbackBind(undefined), true); // defaults to localhost
    assert.equal(isLoopbackBind("localhost"), true);
    assert.equal(isLoopbackBind("127.0.0.1"), true);
    assert.equal(isLoopbackBind("::1"), true);
    assert.equal(isLoopbackBind("0.0.0.0"), false);
    assert.equal(isLoopbackBind("192.168.1.10"), false);
  });

  it("relay command targets the harvest endpoint and never names the value", () => {
    // The cookie is expanded by the shell and piped to curl — it must appear
    // only as the ${CLAUDE_SESSION_COOKIE} reference, never inlined.
    assert.match(COOKIE_RELAY_CMD, /api\/plugins\/claude-usage\/session/);
    assert.match(COOKIE_RELAY_CMD, /\$\{CLAUDE_SESSION_COOKIE\}/);
    assert.match(COOKIE_RELAY_CMD, /--data-binary @-/);
  });
});
