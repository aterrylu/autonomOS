/**
 * The API surfaces of the per-runtime permission model (ADR-115): the shared
 * input parser, the operator's server-side per-runtime default (settings), the
 * template map, the create-agent 400s, and the load-time migration of legacy
 * agent records.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

const TEST_DIR = join(tmpdir(), `aos-rp-api-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
mkdirSync(TEST_DIR, { recursive: true });

const { parsePermissionInput, parseTemplatePermissions } = await import(
  "../agents/permissionInput.js"
);
const { runtimeDefaultPermission, updateSettings } = await import(
  "../settings.js"
);
const { settingsRouter } = await import("../routes/settings.js");
const { templateRouter } = await import("../routes/templates.js");
const { agentsRouter } = await import("../routes/agents.js");
const { _resetCacheForTesting, getAgent } = await import("../agents/store.js");

const app = new Hono();
app.route("/api/settings", settingsRouter);
app.route("/api/templates", templateRouter);
app.route("/api/agents", agentsRouter);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("parsePermissionInput — the create_agent boundary", () => {
  it("nothing given = undefined (the caller said nothing; never a default)", () => {
    assert.deepEqual(parsePermissionInput(undefined, undefined), {
      ok: true,
      permission: undefined,
    });
  });
  it("requires provider, and then lists every runtime's values", () => {
    const r = parsePermissionInput(undefined, "acceptEdits");
    assert.equal(r.ok, false);
    const err = r.ok ? "" : r.error;
    assert.match(err, /`provider` is required/);
    for (const runtime of ["claude-code", "codex", "gemini-cli"])
      assert.match(err, new RegExp(`for ${runtime}:`));
  });
  it("a wrong value lists THAT runtime's values", () => {
    const r = parsePermissionInput("gemini-cli", "acceptEdits");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /gemini-cli: default\|auto_edit/);
  });
  it("Codex takes its own key=value spelling or an object", () => {
    for (const input of [
      "approval_policy=never",
      { approval_policy: "never" },
    ]) {
      const r = parsePermissionInput("codex", input);
      assert.ok(r.ok && r.permission);
      assert.equal(r.permission.values.approval_policy, "never");
      assert.equal(r.permission.values.sandbox_mode, "danger-full-access");
    }
  });
  it("a non-string/non-object is refused, not coerced", () => {
    assert.equal(parsePermissionInput("codex", 42).ok, false);
    assert.equal(parsePermissionInput("codex", ["never"]).ok, false);
  });
});

describe("parseTemplatePermissions — stores COMPLETE canonical values", () => {
  it("fills every axis, so a later default change can't shift the template", () => {
    const r = parseTemplatePermissions({ codex: "approval_policy=never" });
    assert.ok(r.ok);
    assert.deepEqual(r.permissions?.codex, {
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
      approvals_reviewer: "user",
      collaboration_mode: "default",
    });
  });
  it("an unknown runtime or value is refused", () => {
    assert.equal(parseTemplatePermissions({ cursor: "x" }).ok, false);
    assert.equal(parseTemplatePermissions({ "claude-code": "yolo" }).ok, false);
  });
});

describe("the operator's per-runtime default (server-side setting)", () => {
  beforeEach(() => updateSettings({ runtimeDefaults: undefined }));

  it("GET reports an EFFECTIVE default for every runtime — the built-in one when unset", async () => {
    const { json } = await call("GET", "/api/settings");
    const d = json.runtimeDefaults as Record<
      string,
      { values: Record<string, string> }
    >;
    assert.equal(d["claude-code"].values["permission-mode"], "manual");
    assert.equal(d.codex.values.approval_policy, "on-request");
    assert.equal(d["gemini-cli"].values["approval-mode"], "default");
  });

  it("PUT one runtime leaves the others alone; null resets it", async () => {
    let r = await call("PUT", "/api/settings", {
      runtimeDefaults: { "claude-code": "acceptEdits" },
    });
    assert.equal(r.status, 200);
    r = await call("PUT", "/api/settings", {
      runtimeDefaults: { codex: "approval_policy=never" },
    });
    assert.equal(
      runtimeDefaultPermission("claude-code").values["permission-mode"],
      "acceptEdits",
    );
    assert.equal(
      runtimeDefaultPermission("codex").values.approval_policy,
      "never",
    );
    await call("PUT", "/api/settings", { runtimeDefaults: { codex: null } });
    assert.equal(
      runtimeDefaultPermission("codex").values.approval_policy,
      "on-request",
    );
    assert.equal(
      runtimeDefaultPermission("claude-code").values["permission-mode"],
      "acceptEdits",
    );
  });

  it("an invalid value is a 400 naming the valid ones — and nothing is saved", async () => {
    const r = await call("PUT", "/api/settings", {
      runtimeDefaults: { "gemini-cli": "bypassPermissions" },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /gemini-cli: default\|auto_edit/);
    assert.equal(
      runtimeDefaultPermission("gemini-cli").values["approval-mode"],
      "default",
    );
  });

  it("a saved value that no longer parses falls back to the built-in default, never wider", () => {
    updateSettings({
      runtimeDefaults: { codex: { approval_policy: "untrusted" } },
    });
    assert.equal(
      runtimeDefaultPermission("codex").values.approval_policy,
      "on-request",
    );
  });
});

describe("templates: the per-runtime permission map", () => {
  it("POST stores complete canonical values per runtime", async () => {
    const r = await call("POST", "/api/templates", {
      name: "rp-tmpl",
      role: "Worker",
      description: "d",
      systemPrompt: "s",
      permissions: { "gemini-cli": "auto_edit" },
    });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(
      readFileSync(join(TEST_DIR, "templates", "rp-tmpl.json"), "utf8"),
    );
    assert.deepEqual(onDisk.permissions, {
      "gemini-cli": { "approval-mode": "auto_edit" },
    });
    assert.equal(onDisk.permissionMode, undefined, "no implicit ask");
  });
  it("POST with an invalid canonical value is a 400", async () => {
    const r = await call("POST", "/api/templates", {
      name: "rp-bad",
      role: "Worker",
      description: "d",
      systemPrompt: "s",
      permissions: { codex: "never" },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /approval_policy=on-request\|never/);
  });
});

describe("POST /api/agents: a bad permission 400s BEFORE anything spawns", () => {
  it("permission without provider", async () => {
    const r = await call("POST", "/api/agents", {
      workingDirectory: TEST_DIR,
      permission: "acceptEdits",
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /`provider` is required/);
  });
  it("another runtime's value", async () => {
    const r = await call("POST", "/api/agents", {
      workingDirectory: TEST_DIR,
      provider: "codex",
      permission: "bypassPermissions",
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /Valid permission values for codex/);
  });
});

describe("load-time migration of legacy agent records (keeps exact behavior)", () => {
  function writeRecord(
    id: string,
    provider: string,
    extra: Record<string, unknown>,
  ): void {
    const dir = join(TEST_DIR, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: `rec-${id.slice(0, 4)}`,
        managerId: null,
        workingDirectory: "/tmp",
        status: "exited",
        provider,
        providerSessionId: id,
        startedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
        ...extra,
      }),
    );
  }
  const load = (id: string) => {
    _resetCacheForTesting();
    return getAgent(id);
  };

  it("claude bypass → bypassPermissions; gemini auto → auto_edit", () => {
    const a = randomUUID();
    const b = randomUUID();
    writeRecord(a, "claude-code", { permissionMode: "bypass" });
    writeRecord(b, "gemini-cli", { permissionMode: "auto" });
    assert.equal(
      load(a)?.permission?.values["permission-mode"],
      "bypassPermissions",
    );
    assert.equal(load(b)?.permission?.values["approval-mode"], "auto_edit");
    assert.equal(load(a)?.permissionMigratedFrom, undefined);
  });

  it("Codex auto → what it always ran (on-request, no sandbox), flagged for the one-time notice", () => {
    const id = randomUUID();
    writeRecord(id, "codex", { permissionMode: "auto" });
    const a = load(id);
    assert.equal(a?.permission?.values.approval_policy, "on-request");
    assert.equal(a?.permission?.values.sandbox_mode, "danger-full-access");
    assert.equal(a?.permissionMigratedFrom, "auto");
    assert.equal(a?.permissionMode, "ask", "the legacy projection follows");
  });

  it("a stored permission from another runtime is rebuilt from the legacy mode", () => {
    const id = randomUUID();
    writeRecord(id, "codex", {
      permissionMode: "bypass",
      permission: {
        runtime: "claude-code",
        values: { "permission-mode": "plan" },
      },
    });
    assert.equal(load(id)?.permission?.runtime, "codex");
    assert.equal(load(id)?.permission?.values.approval_policy, "never");
  });

  it("a record whose provider has no permission table still LOADS (never skipped)", () => {
    // Regression: the load migration indexed the table unguarded, threw, and
    // the store skipped the whole record — an agent silently dropped.
    const id = randomUUID();
    writeRecord(id, "some-removed-cli", {
      permissionMode: "bypass",
      permission: { runtime: "some-removed-cli", values: { x: "y" } },
    });
    const a = load(id);
    assert.ok(a, "the record must load");
    assert.equal(a.permissionMode, "bypass", "never relabeled");
  });

  it("a well-formed stored permission is kept as-is (legacy mode re-derived from it)", () => {
    const id = randomUUID();
    writeRecord(id, "claude-code", {
      permissionMode: "ask",
      permission: {
        runtime: "claude-code",
        values: { "permission-mode": "dontAsk" },
      },
    });
    assert.equal(load(id)?.permission?.values["permission-mode"], "dontAsk");
  });
});
