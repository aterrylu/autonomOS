// Pre-update state snapshots, code+state pairing inputs, post-update
// verification, and the no-irreversible-migrations guard (ADR-103 amendment).

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { _resetCacheForTesting, listAgents } from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { systemRouter } from "../routes/system.js";
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  SNAPSHOT_RETENTION,
  snapshotForVersion,
  snapshotsDir,
} from "../snapshots.js";
import { verifyAgainstBaseline } from "../upgradeVerify.js";

let cfg: string;
beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), "autonomos-snap-"));
  _setConfigDirForTesting(cfg);
  _resetCacheForTesting();
});
afterEach(() => {
  _resetCacheForTesting();
  _resetConfigDirForTesting();
  rmSync(cfg, { recursive: true, force: true });
});

function agentRecord(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    name: `agent-${id}`,
    workingDirectory: "/tmp",
    provider: "codex",
    permissionMode: "ask",
    status: "running",
    providerSessionId: `sess-${id}`,
    providerThreadId: `thread-${id}`,
    ...extra,
  };
}

function seedState() {
  mkdirSync(join(cfg, "agents"), { recursive: true });
  writeFileSync(
    join(cfg, "agents", "a1.json"),
    JSON.stringify(agentRecord("a1")),
  );
  mkdirSync(join(cfg, "env-presets"), { recursive: true });
  writeFileSync(
    join(cfg, "env-presets", "kimi.json"),
    '{"secrets":{"K":"v"}}',
    { mode: 0o600 },
  );
  writeFileSync(join(cfg, "token"), "tok", { mode: 0o600 });
  writeFileSync(join(cfg, "settings.json"), "{}");
  mkdirSync(join(cfg, "logs"), { recursive: true });
  writeFileSync(join(cfg, "logs", "autonomos.log"), "x".repeat(10_000));
  writeFileSync(join(cfg, "control.sock"), "");
}

describe("createSnapshot", () => {
  it("copies state, excludes logs/sockets, preserves 0600 secrets, records the agent baseline", () => {
    seedState();
    const m = createSnapshot("0.6.1", "0.7.0", cfg);
    const dir = join(snapshotsDir(cfg), m.id);
    assert.ok(existsSync(join(dir, "agents", "a1.json")));
    assert.ok(!existsSync(join(dir, "logs")), "logs are not state");
    assert.ok(!existsSync(join(dir, "control.sock")));
    assert.equal(
      statSync(join(dir, "env-presets", "kimi.json")).mode & 0o777,
      0o600,
    );
    assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
    assert.equal(statSync(snapshotsDir(cfg)).mode & 0o777, 0o700);
    assert.deepEqual(
      m.agents.map((a) => [a.id, a.providerThreadId]),
      [["a1", "thread-a1"]],
    );
    assert.ok(m.bytes < 5_000, "small: no logs");
    assert.ok(
      !readdirSync(snapshotsDir(cfg)).some((d) => d.startsWith(".")),
      "no staging debris after a completed snapshot",
    );
  });

  it(`creating never prunes; pruning keeps the last ${SNAPSHOT_RETENTION} plus protected ids`, () => {
    seedState();
    const made = [];
    for (let i = 0; i < SNAPSHOT_RETENTION + 2; i++) {
      made.push(
        createSnapshot(
          `0.6.${i}`,
          null,
          cfg,
          new Date(Date.UTC(2026, 0, 1, 0, i)),
        ),
      );
    }
    // A snapshot is taken before anyone knows the run will change anything;
    // pruning at creation evicted a real snapshot per no-op/failed attempt.
    assert.equal(listSnapshots(cfg).length, SNAPSHOT_RETENTION + 2);

    pruneSnapshots(cfg, SNAPSHOT_RETENTION, [made[0].id]);
    const kept = listSnapshots(cfg).map((s) => s.fromVersion);
    assert.equal(kept.length, SNAPSHOT_RETENTION + 1);
    assert.equal(kept[0], `0.6.${SNAPSHOT_RETENTION + 1}`, "newest first");
    assert.ok(kept.includes("0.6.0"), "the protected oldest survives");
    assert.ok(!kept.includes("0.6.1"), "the unprotected overflow is pruned");
  });

  it("a half-written (staging) snapshot is never listed or offered", () => {
    seedState();
    mkdirSync(join(snapshotsDir(cfg), ".staging-0.6.1-x"), { recursive: true });
    assert.equal(listSnapshots(cfg).length, 0);
    assert.equal(snapshotForVersion("0.6.1", cfg), null);
  });
});

describe("restoreSnapshot", () => {
  it("puts back exactly the snapshotted entries and leaves the rest alone", () => {
    seedState();
    const m = createSnapshot("0.6.1", "0.7.0", cfg);
    // The "new version" rewrites a record and adds a dir of its own.
    writeFileSync(
      join(cfg, "agents", "a1.json"),
      JSON.stringify(
        agentRecord("a1", { providerThreadId: undefined, schemaVersion: 2 }),
      ),
    );
    mkdirSync(join(cfg, "new-feature-dir"));
    const { saved } = restoreSnapshot(m.id, "0.7.0", cfg);
    const back = JSON.parse(
      readFileSync(join(cfg, "agents", "a1.json"), "utf-8"),
    );
    assert.equal(back.schemaVersion, 1);
    assert.equal(back.providerThreadId, "thread-a1", "the mapping is back");
    assert.ok(
      existsSync(join(cfg, "new-feature-dir")),
      "unrelated entries untouched",
    );
    assert.equal(statSync(join(cfg, "token")).mode & 0o777, 0o600);
    assert.ok(
      !readdirSync(cfg).some((d) => d.startsWith(".restore-")),
      "no debris",
    );

    // Nothing the newer version wrote is destroyed: it is saved as its own
    // snapshot, which is what rolling forward again pairs with.
    assert.equal(saved.fromVersion, "0.7.0");
    assert.equal(saved.toVersion, "0.6.1");
    assert.equal(snapshotForVersion("0.7.0", cfg)?.id, saved.id);
    const newer = JSON.parse(
      readFileSync(
        join(snapshotsDir(cfg), saved.id, "agents", "a1.json"),
        "utf-8",
      ),
    );
    assert.equal(
      newer.schemaVersion,
      2,
      "the newer record is kept, not deleted",
    );
  });

  it("a snapshot that can't be read leaves live state exactly as it was", () => {
    seedState();
    const m = createSnapshot("0.6.1", "0.7.0", cfg);
    writeFileSync(join(cfg, "settings.json"), '{"after":"update"}');
    writeFileSync(
      join(cfg, "agents", "a1.json"),
      JSON.stringify(agentRecord("a1", { schemaVersion: 2 })),
    );
    // Damage the snapshot: an entry the manifest lists (after "agents" in
    // entry order, so agents was already staged when this fails) is missing.
    rmSync(join(snapshotsDir(cfg), m.id, "token"), { force: true });
    assert.throws(
      () => restoreSnapshot(m.id, "0.7.0", cfg),
      /live state was left as it was/,
    );
    assert.equal(
      readFileSync(join(cfg, "settings.json"), "utf-8"),
      '{"after":"update"}',
      "nothing was swapped in",
    );
    assert.equal(
      JSON.parse(readFileSync(join(cfg, "agents", "a1.json"), "utf-8"))
        .schemaVersion,
      2,
      "the already-staged agents entry was NOT swapped in",
    );
    assert.equal(readFileSync(join(cfg, "token"), "utf-8"), "tok");
    assert.ok(
      !readdirSync(cfg).some((d) => d.startsWith(".restore-")),
      "no debris",
    );
  });

  it("snapshotForVersion pairs a version with the newest snapshot taken FROM it", () => {
    seedState();
    createSnapshot("0.6.1", "0.7.0", cfg, new Date(Date.UTC(2026, 0, 1)));
    const newer = createSnapshot(
      "0.6.1",
      "0.7.0",
      cfg,
      new Date(Date.UTC(2026, 0, 2)),
    );
    createSnapshot("0.7.0", "0.8.0", cfg, new Date(Date.UTC(2026, 0, 3)));
    assert.equal(snapshotForVersion("0.6.1", cfg)?.id, newer.id);
    deleteSnapshot(newer.id, cfg);
    assert.notEqual(snapshotForVersion("0.6.1", cfg)?.id, newer.id);
  });
});

describe("verifyAgainstBaseline", () => {
  const base = [
    {
      id: "a",
      name: "api",
      provider: "claude-code",
      status: "running",
      providerSessionId: "s-a",
    },
    {
      id: "c",
      name: "codex-tests",
      provider: "codex",
      status: "running",
      providerSessionId: "s-c",
      providerThreadId: "t-c",
    },
    {
      id: "d",
      name: "docs",
      provider: "claude-code",
      status: "exited",
      providerSessionId: "s-d",
    },
  ];
  const live = (over: Record<string, Record<string, unknown>> = {}) =>
    base.map((b) => ({ ...b, ...(over[b.id] ?? {}) })) as never;

  it("all intact → no problems", () => {
    assert.deepEqual(verifyAgainstBaseline(base, live()), []);
  });
  it("the Codex-incident shape (thread id gone) is caught by name", () => {
    const p = verifyAgainstBaseline(
      base,
      live({ c: { providerThreadId: undefined } }),
    );
    assert.deepEqual(
      p.map((x) => [x.name, x.issue]),
      [["codex-tests", "Its Codex thread id is missing from its record"]],
    );
  });
  it("missing record, changed session id, and didn't-come-back are each reported", () => {
    const l = (
      live({ a: { providerSessionId: "other" } }) as unknown as typeof base
    ).filter((x) => x.id !== "c");
    const p = verifyAgainstBaseline(base, [...l] as never);
    assert.equal(p.length, 2);
    assert.match(
      p.find((x) => x.id === "a")?.issue ?? "",
      /conversation id changed/,
    );
    assert.match(
      p.find((x) => x.id === "c")?.issue ?? "",
      /missing or couldn't be read/,
    );
    const p2 = verifyAgainstBaseline(
      base,
      live({ a: { status: "exited", exitReason: "resume-failed" } }),
    );
    assert.match(p2[0].issue, /didn't come back.*resume-failed/);
  });
  it("an agent that was already exited before the update isn't expected to be running", () => {
    assert.deepEqual(
      verifyAgainstBaseline(base, live({ d: { status: "exited" } })),
      [],
    );
  });
});

describe("no-irreversible-migrations guard", () => {
  it("a record written by a NEWER schema is refused loudly and left untouched on disk", () => {
    mkdirSync(join(cfg, "agents"), { recursive: true });
    writeFileSync(
      join(cfg, "agents", "ok.json"),
      JSON.stringify(agentRecord("ok")),
    );
    const future = JSON.stringify(agentRecord("future", { schemaVersion: 99 }));
    writeFileSync(join(cfg, "agents", "future.json"), future);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      const ids = listAgents().map((a) => a.id);
      assert.deepEqual(ids, ["ok"]);
    } finally {
      console.error = orig;
    }
    assert.ok(
      errors.some(
        (e) => /newer autonomOS/.test(e) && /autonomos rollback/.test(e),
      ),
    );
    assert.equal(
      readFileSync(join(cfg, "agents", "future.json"), "utf-8"),
      future,
      "never rewritten",
    );
  });
});

describe("in-app Restore route", () => {
  const app = new Hono();
  app.route("/api/system", systemRouter);
  it("POST /rollback is operator-only (agent token → 403)", async () => {
    const res = await app.request("/api/system/rollback", {
      method: "POST",
      headers: { "X-Agent-Token": "t", Cookie: "autonomos_token=x" },
    });
    assert.equal(res.status, 403);
  });
  it("GET /snapshots never exposes the per-agent baseline", async () => {
    seedState();
    createSnapshot("0.6.1", "0.7.0", cfg);
    const res = await app.request("/api/system/snapshots");
    const body = await res.json();
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].agents, undefined);
    assert.equal(body.snapshots[0].agentCount, 1);
  });
});
