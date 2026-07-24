import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";

/**
 * Accept-and-discard handling for user-authored templates: legacy
 * `autonomousMode` (ADR-045) and deprecated `capabilities` (ADR-058).
 * Both guard the same class of risk — a template written by an older version
 * must keep loading, and must not silently change meaning on the way in.
 *
 * templates.ts reads CONFIG_DIR from the environment AT IMPORT, so we set the
 * env and dynamically import it inside before() — NOT at module top-level, so
 * no fs/env side effects run at import (which can crash the Linux e2e collector).
 * node:test isolates each file in its own process, so neither the env mutation
 * nor the fresh module import leaks to other suites.
 *
 * Setup is file-scoped rather than per-describe because the module caches
 * CONFIG_DIR at import: a second describe with its own tmpdir would silently
 * read the first one's.
 */
const base = {
  role: "R",
  description: "",
  systemPrompt: "p",
};

let tmpDir: string;
let templatesDir: string;
let getTemplate: typeof import("../templates.js").getTemplate;

function writeRaw(name: string, obj: unknown): void {
  writeFileSync(join(templatesDir, `${name}.json`), JSON.stringify(obj));
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "autonomos-tmpl-migrate-"));
  process.env.AUTONOMOS_CONFIG_DIR = tmpDir;
  ({ getTemplate } = await import("../templates.js"));
  templatesDir = join(tmpDir, "templates");
  mkdirSync(templatesDir, { recursive: true });
});
after(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("template legacy autonomousMode migration (ADR-045)", () => {
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

/**
 * `capabilities` filtered which MCP tools an agent's channel server registered.
 * Removed in ADR-058 (bypassable via the REST API every agent already has a
 * token for, and contradicted by the unfiltered tool list in the injected
 * system prompt). The risk being guarded here is the deprecation itself: real
 * templates on disk still carry the field, and a template that fails to load —
 * or that throws — takes its agents down with it.
 */
/** Run `body` with console.warn silenced; return only the ADR-058 notices. */
function captureCapabilityWarnings(body: () => void): string[] {
  const warn = mock.method(console, "warn", () => {});
  try {
    body();
    return warn.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.includes("deprecated 'capabilities'"));
  } finally {
    warn.mock.restore();
  }
}

describe("deprecated capabilities field (ADR-058)", () => {
  it("loads an old-shape template and scrubs the field", () => {
    writeRaw("legacy-caps", { ...base, capabilities: ["send"] });
    const t = getTemplate("legacy-caps");
    assert.ok(t, "template still loads — accept-and-ignore, never reject");
    assert.equal(t?.role, "R", "surviving fields are intact");
    assert.ok(
      !("capabilities" in (t as object)),
      "deprecated field scrubbed before reaching consumers",
    );
  });

  it("still migrates permissionMode when both legacy fields are present", () => {
    // The two accept-and-discard blocks run in sequence over one object;
    // this pins that neither clobbers the other.
    writeRaw("legacy-both", {
      ...base,
      capabilities: ["send"],
      autonomousMode: true,
    });
    const t = getTemplate("legacy-both");
    assert.equal(t?.permissionMode, "bypass", "ADR-045 migration survives");
    assert.ok(!("capabilities" in (t as object)));
    assert.ok(!("autonomousMode" in (t as object)));
  });

  it("warns once per template, not once per load", () => {
    // getTemplate() runs on every spawn. An unguarded warn would fill the
    // rotating server log with a line the operator cannot act on.
    // The warn-once map lives in the module, so it is shared by every test in
    // this file — "noisy" must not be loaded anywhere else, or the first warn
    // is spent before we start counting.
    writeRaw("noisy", { ...base, capabilities: ["send"] });
    const notices = captureCapabilityWarnings(() => {
      getTemplate("noisy");
      getTemplate("noisy");
      getTemplate("noisy");
    });
    assert.equal(notices.length, 1, "one notice across three loads");
    assert.match(
      notices[0],
      /noisy\.json/,
      "names the file to edit, not just the template",
    );
  });

  it("warns again after the file changes, so silence means fixed", () => {
    // The suppression is per file VERSION, not per name. An operator who edits
    // the wrong host's copy (the field lives on more than one machine) must not
    // read the resulting silence as confirmation — under name-keying they would.
    const file = join(templatesDir, "edited.json");
    writeRaw("edited", { ...base, capabilities: ["send"] });
    const first = captureCapabilityWarnings(() => getTemplate("edited"));
    assert.equal(first.length, 1, "warns on the original");

    // Rewrite with the field STILL present, stamping an explicit mtime —
    // two writes in the same millisecond would otherwise look unchanged.
    writeRaw("edited", { ...base, capabilities: ["send", "list_agents"] });
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const second = captureCapabilityWarnings(() => {
      getTemplate("edited");
      getTemplate("edited");
    });
    assert.equal(second.length, 1, "re-warns once for the new version");

    // Now actually fix it — silence here is meaningful.
    writeRaw("edited", { ...base, permissionMode: "plan" });
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    const third = captureCapabilityWarnings(() => getTemplate("edited"));
    assert.deepEqual(third, [], "no notice once the field is gone");
  });

  it("says nothing for a template that never had the field", () => {
    writeRaw("modern", { ...base, permissionMode: "plan" });
    const notices = captureCapabilityWarnings(() => {
      assert.equal(getTemplate("modern")?.permissionMode, "plan");
    });
    assert.deepEqual(notices, []);
  });
});
