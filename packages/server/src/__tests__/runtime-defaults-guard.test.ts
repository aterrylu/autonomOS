/**
 * The operator's per-runtime default permissions decide what every
 * agent-spawned child runs, so a widening must never be silent (ADR-122):
 *  - a default that NEVER asks can't be saved without an explicit confirm;
 *  - every change is reported to the operator (bell) and logged — including
 *    an out-of-band edit of settings.json, noticed on the next read;
 *  - no MCP tool can write them at all.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

const CFG = mkdtempSync(join(tmpdir(), "aos-rdg-"));
process.env.AUTONOMOS_CONFIG_DIR = CFG;

const { settingsRouter } = await import("../routes/settings.js");
const {
  getNotifications,
  clearNotifications,
  SERVER_NOTICE_KEY,
  notificationsRouter,
} = await import("../routes/hooks.js");
const { _resetRuntimeDefaultsWatchForTesting } = await import(
  "../runtimeDefaultsWatch.js"
);
const { ALL_TOOLS } = await import("../mcp/tools.js");

const app = new Hono();
app.route("/api/settings", settingsRouter);
app.route("/api/notifications", notificationsRouter);

const put = async (body: unknown) => {
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
};
const get = async () =>
  (await (await app.request("/api/settings")).json()) as {
    runtimeDefaults: Record<string, { values: Record<string, string> }>;
    runtimeDefaultsLog?: Array<{
      runtime: string;
      to: string;
      source: string;
      neverAsks: boolean;
    }>;
  };
const notices = () =>
  getNotifications(SERVER_NOTICE_KEY).map((n) => n.message ?? "");

after(() => rmSync(CFG, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(CFG, "settings.json"), { force: true });
  rmSync(join(CFG, "runtime-defaults-seen.json"), { force: true });
  _resetRuntimeDefaultsWatchForTesting();
  clearNotifications(SERVER_NOTICE_KEY);
});

describe("a never-asks default needs an explicit confirm", () => {
  it("refused without confirmNeverAsks — and nothing is saved", async () => {
    await get(); // baseline
    const r = await put({
      runtimeDefaults: { codex: "approval_policy=never" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "CONFIRM_NEVER_ASKS");
    assert.deepEqual(r.json.runtimes, ["codex"]);
    assert.equal(
      (await get()).runtimeDefaults.codex.values.approval_policy,
      "on-request",
    );
    assert.deepEqual(notices(), [], "nothing changed, nothing reported");
  });

  it("saved with the confirm — and REPORTED to the operator", async () => {
    await get();
    const r = await put({
      runtimeDefaults: { "gemini-cli": "yolo" },
      confirmNeverAsks: true,
    });
    assert.equal(r.status, 200);
    const n = notices();
    assert.equal(n.length, 1);
    assert.match(
      n[0],
      /Gemini CLI's default permission changed: default → yolo\. New agents on it never ask/,
    );
    const log = (await get()).runtimeDefaultsLog ?? [];
    assert.equal(log.at(-1)?.to, "yolo");
    assert.equal(log.at(-1)?.source, "dashboard");
    assert.equal(log.at(-1)?.neverAsks, true);
  });

  it("only a WIDENING needs it: re-saving the same never-asks default, or narrowing, doesn't", async () => {
    await get();
    await put({
      runtimeDefaults: { "claude-code": "bypassPermissions" },
      confirmNeverAsks: true,
    });
    assert.equal(
      (await put({ runtimeDefaults: { "claude-code": "bypassPermissions" } }))
        .status,
      200,
    );
    assert.equal(
      (await put({ runtimeDefaults: { "claude-code": "manual" } })).status,
      200,
    );
  });

  it("a non-widening change is still reported (every change is said)", async () => {
    await get();
    await put({ runtimeDefaults: { "claude-code": "acceptEdits" } });
    assert.match(
      notices()[0] ?? "",
      /Claude Code's default permission changed: manual → acceptEdits\.$/,
    );
  });
});

describe("an OUT-OF-BAND change (settings.json edited directly) is noticed", () => {
  it("reported on the next read, marked as outside autonomOS, and logged", async () => {
    await get(); // baseline: built-in defaults
    const file = join(CFG, "settings.json");
    // A GET never writes settings.json — start from what's there, if anything.
    let cur: Record<string, unknown> = {};
    try {
      cur = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // no file yet
    }
    writeFileSync(
      file,
      JSON.stringify({
        ...cur,
        runtimeDefaults: { codex: { approval_policy: "never" } },
      }),
    );
    const s = await get();
    assert.equal(s.runtimeDefaults.codex.values.approval_policy, "never");
    assert.match(
      notices()[0] ?? "",
      /Codex's default permission changed outside autonomOS \(settings\.json was edited directly\): .*→ approval_policy=never.*never ask/,
    );
    assert.equal(s.runtimeDefaultsLog?.at(-1)?.source, "out-of-band");
    // …once: the next read has nothing new to say.
    await get();
    assert.equal(notices().length, 1);
  });

  it("the bell names the sender 'autonomOS', not a truncated key", async () => {
    await get();
    await put({ runtimeDefaults: { "claude-code": "plan" } });
    const feed = (await (await app.request("/api/notifications")).json()) as {
      notifications: Array<{ sessionName: string; message?: string }>;
    };
    const mine = feed.notifications.find((n) =>
      (n.message ?? "").includes("Claude Code's default"),
    );
    assert.equal(mine?.sessionName, "autonomOS");
  });
});

describe("no MCP tool can write the defaults", () => {
  it("no tool is a settings writer, and no tool schema has runtimeDefaults / confirmNeverAsks", () => {
    for (const t of ALL_TOOLS) {
      assert.doesNotMatch(t.name, /setting/i, t.name);
      const props = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {},
      );
      assert.ok(
        !props.includes("runtimeDefaults"),
        `${t.name} exposes runtimeDefaults`,
      );
      assert.ok(
        !props.includes("confirmNeverAsks"),
        `${t.name} exposes confirmNeverAsks`,
      );
    }
  });
});
