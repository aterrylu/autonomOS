import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Accept-and-discard migration for user-authored templates (ADR-045). The risk
 * being guarded: a template the user deliberately set to supervised
 * (autonomousMode:false) must NOT silently load as full-autonomy ("bypass").
 *
 * templates.ts reads CONFIG_DIR from the environment AT IMPORT, so we set it
 * before a dynamic import. node:test isolates each test file in its own
 * process, so this env mutation does not leak to other suites.
 */
const tmpDir = mkdtempSync(join(tmpdir(), "autonomos-tmpl-migrate-"));
process.env.AUTONOMOS_CONFIG_DIR = tmpDir;
const { getTemplate } = await import("../templates.js");

const TEMPLATES_DIR = join(tmpDir, "templates");

function writeRaw(name: string, obj: unknown): void {
  writeFileSync(join(TEMPLATES_DIR, `${name}.json`), JSON.stringify(obj));
}

const base = {
  role: "R",
  description: "",
  systemPrompt: "p",
  capabilities: [],
};

describe("template legacy autonomousMode migration (ADR-045)", () => {
  before(() => mkdirSync(TEMPLATES_DIR, { recursive: true }));
  after(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("maps legacy autonomousMode:false → 'default' (supervised intent preserved)", () => {
    writeRaw("legacy-supervised", { ...base, autonomousMode: false });
    const t = getTemplate("legacy-supervised");
    assert.equal(t?.permissionMode, "default");
    assert.ok(!("autonomousMode" in (t as object)), "old field scrubbed");
  });

  it("maps legacy autonomousMode:true → 'bypass'", () => {
    writeRaw("legacy-auto", { ...base, autonomousMode: true });
    assert.equal(getTemplate("legacy-auto")?.permissionMode, "bypass");
  });

  it("drops an invalid permissionMode so consumers apply the default", () => {
    writeRaw("bad", { ...base, permissionMode: "garbage" });
    assert.equal(getTemplate("bad")?.permissionMode, undefined);
  });

  it("leaves a valid permissionMode untouched", () => {
    writeRaw("good", { ...base, permissionMode: "plan" });
    assert.equal(getTemplate("good")?.permissionMode, "plan");
  });
});
