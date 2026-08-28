import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Config-dir isolation (the test-escape guard refuses the production dir).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-lastact-"));

const {
  _resetCacheForTesting,
  buildAgent,
  getAgent,
  insertAgent,
  markActivity,
  patchAgent,
} = await import("../agents/store.js");

const DIR = join(process.env.AUTONOMOS_CONFIG_DIR, "agents");
const fix = (id: string) =>
  buildAgent({
    id: id as never,
    name: `lastact-${id.slice(-2)}`,
    workingDirectory: "/tmp",
    provider: "claude-code",
    providerSessionId: id,
    permissionMode: "ask",
  });
const onDisk = (id: string) =>
  JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));

describe("lastActivityAt — genuine activity only, upgrade-proof (v0.7.0 item 3)", () => {
  beforeEach(() => _resetCacheForTesting());

  it("markActivity sets the field in-memory immediately; unknown id no-ops", () => {
    const a = insertAgent(fix("0000a111-0000-4000-8000-000000000001"));
    assert.equal(a.lastActivityAt, undefined);
    markActivity(a.id, 1111);
    assert.equal(getAgent(a.id)?.lastActivityAt, 1111);
    markActivity("0000a111-0000-4000-8000-00000000dead", 2222); // no throw
  });

  it("debounces disk writes; flush:true forces; version/updatedAt NEVER bump", () => {
    const a = insertAgent(fix("0000a111-0000-4000-8000-000000000002"));
    const { version, updatedAt } = onDisk(a.id);
    markActivity(a.id, Date.now()); // first mark → flushes (no prior flush)
    const d1 = onDisk(a.id);
    assert.ok(d1.lastActivityAt, "first mark persisted");
    assert.equal(d1.version, version, "activity is not a record mutation");
    assert.equal(d1.updatedAt, updatedAt, "lifecycle timestamp untouched");
    markActivity(a.id, Date.now() + 1); // within debounce window → cache only
    assert.equal(onDisk(a.id).lastActivityAt, d1.lastActivityAt, "debounced");
    markActivity(a.id, Date.now() + 2, { flush: true }); // turn boundary
    assert.ok(onDisk(a.id).lastActivityAt > d1.lastActivityAt, "flush forced");
  });

  it("a stale timestamp never regresses the value", () => {
    const a = insertAgent(fix("0000a111-0000-4000-8000-000000000003"));
    markActivity(a.id, 5000);
    markActivity(a.id, 4000);
    assert.equal(getAgent(a.id)?.lastActivityAt, 5000);
  });

  it("LIFECYCLE writes never create the field — the upgrade-bump bug stays dead", () => {
    // A pre-field record (fresh insert has no lastActivityAt). Everything a
    // boot-resume/respawn does to a record — status patches via patchAgent —
    // must leave the field ABSENT. Initializing it at boot would recreate
    // the exact everything-shows-1m bug this field exists to fix.
    const a = insertAgent(fix("0000a111-0000-4000-8000-000000000004"));
    patchAgent(a.id, { name: "renamed-by-lifecycle" });
    const d = onDisk(a.id);
    assert.equal(
      "lastActivityAt" in d,
      false,
      "field absent after lifecycle writes",
    );
  });

  it("BACKWARD compat: a record WITHOUT the field loads cleanly (no behavior change)", () => {
    mkdirSync(DIR, { recursive: true });
    const id = "0000a111-0000-4000-8000-000000000005";
    const legacy = { ...fix(id), version: 1 };
    assert.equal("lastActivityAt" in legacy, false);
    writeFileSync(join(DIR, `${id}.json`), JSON.stringify(legacy));
    _resetCacheForTesting();
    assert.equal(getAgent(id)?.lastActivityAt, undefined);
    assert.equal(getAgent(id)?.name, legacy.name);
  });

  it("DOWNGRADE compat evidence: the loader tolerates unknown extra fields", () => {
    // An older build reading a record that carries lastActivityAt is the
    // same class as this: unknown keys must be ignored, not fatal.
    mkdirSync(DIR, { recursive: true });
    const id = "0000a111-0000-4000-8000-000000000006";
    writeFileSync(
      join(DIR, `${id}.json`),
      JSON.stringify({ ...fix(id), version: 1, someFutureField: 42 }),
    );
    _resetCacheForTesting();
    assert.equal(getAgent(id)?.name, fix(id).name);
  });
});

describe("lastActivityAt — hook-event feed through the real ingest route", () => {
  beforeEach(() => _resetCacheForTesting());

  const post = async (sid: string, event: string) => {
    const { hooksIngestRouter } = await import("../routes/hooks.js");
    const { mintAgentToken } = await import("../agentCredentials.js");
    return hooksIngestRouter.request(`/${sid}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": mintAgentToken(sid),
      },
      body: JSON.stringify({ hook_event_name: event }),
    });
  };

  it("SessionStart (lifecycle) does NOT bump; UserPromptSubmit (activity) does; Stop force-flushes", async () => {
    const id = "0000a111-0000-4000-8000-000000000007";
    insertAgent(fix(id));
    assert.equal((await post(id, "SessionStart")).status, 200);
    assert.equal(
      getAgent(id as never)?.lastActivityAt,
      undefined,
      "lifecycle must not bump",
    );
    const before = Date.now();
    assert.equal((await post(id, "UserPromptSubmit")).status, 200);
    const bumped = getAgent(id as never)?.lastActivityAt;
    assert.ok(bumped && bumped >= before, "activity bumps");
    assert.equal((await post(id, "Stop")).status, 200);
    assert.ok(
      onDisk(id).lastActivityAt >= bumped,
      "Stop force-flushed to disk",
    );
  });
});
