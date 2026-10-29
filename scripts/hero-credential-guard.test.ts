import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertNoCredentials, findCredentials } from "./hero-credential-guard.js";

/**
 * The README hero capture must run on NO real login (#551). Two guards:
 *  1. its throwaway HOME is checked for credentials (by name and contents);
 *  2. the capture script's source never names the real credential paths or
 *     the keychain read, so the copy can't quietly come back.
 */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hero-guard-"));
  dirs.push(d);
  return d;
};

describe("hero credential guard", () => {
  it("a clean fake HOME passes (onboarding flags, empty dirs, a transcript)", () => {
    const h = home();
    mkdirSync(join(h, ".claude", "projects"), { recursive: true });
    writeFileSync(join(h, ".claude.json"), '{"hasCompletedOnboarding":true}');
    writeFileSync(join(h, "notes.txt"), "a turn that mentions auth and tokens");
    assert.deepEqual(findCredentials(h), []);
    assert.doesNotThrow(() => assertNoCredentials(h, "fake HOME"));
  });

  it("fails on each CLI's credential file, wherever it lands", () => {
    for (const rel of [
      ".codex/auth.json",
      ".claude/.credentials.json",
      ".gemini/oauth_creds.json",
      ".gemini/google_accounts.json",
      "Library/Keychains/login.keychain-db",
    ]) {
      const h = home();
      mkdirSync(join(h, rel, ".."), { recursive: true });
      writeFileSync(join(h, rel), "{}");
      assert.throws(() => assertNoCredentials(h, "fake HOME"), /credential/, rel);
    }
  });

  it("fails on credential CONTENTS under any name (a renamed copy)", () => {
    for (const body of [
      '{"tokens":{"refresh_token":"x"}}',
      '{"claudeAiOauth":{"accessToken":"y"}}',
      `{"access_token":"${"a".repeat(40)}"}`,
      `token=sk-ant-oat01-${"b".repeat(40)}`,
    ]) {
      const h = home();
      writeFileSync(join(h, "copy.json"), body);
      assert.equal(findCredentials(h).length, 1, body);
    }
  });

  it("doesn't follow symlinks out of the fake HOME (the claude binary link)", () => {
    const h = home();
    const outside = home();
    writeFileSync(join(outside, "auth.json"), '{"refresh_token":"x"}');
    symlinkSync(outside, join(h, "linked"));
    assert.deepEqual(findCredentials(h), []);
  });
});

describe("capture-hero.ts never reads or copies a real credential (#551)", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../packages/dashboard/scripts/capture-hero.ts", import.meta.url),
    ),
    "utf8",
  );
  it("names no real credential path and no keychain read", () => {
    for (const forbidden of [
      /find-generic-password/,
      /["'`]\.credentials\.json["'`]/,
      /["'`]auth\.json["'`]/,
      /["'`]oauth_creds\.json["'`]/,
      /REAL_CODEX_DIR|REAL_GEMINI_DIR|REAL_CLAUDE_CREDS/,
      /homedir\(\)/,
    ])
      assert.ok(!forbidden.test(source), `capture-hero.ts matches ${forbidden}`);
  });
  it("runs the guard on its fake HOME after boot AND right before the screenshot", () => {
    // Two different moments: what boot seeded, and anything the agents pulled
    // in while the scene ran.
    assert.match(source, /assertNoCredentials\(server\.fakeHome, "[^"]*\(after boot\)"\)/);
    assert.match(
      source,
      /assertNoCredentials\(server\.fakeHome, "[^"]*\(before capture\)"\)[\s\S]*?captureWeb\(/,
    );
  });
});

describe("make hero runs the capture sandboxed away from real credentials on macOS (#551)", () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("the hero target wraps the capture in the no-credentials profile", () => {
    const mk = read("../Makefile");
    const at = mk.search(/^hero:/m);
    assert.ok(at >= 0, "the Makefile has a hero target");
    // The target runs to the next line that isn't a recipe or continuation.
    const rest = mk.slice(at);
    const end = rest.search(/\n\S/);
    const hero = end < 0 ? rest : rest.slice(0, end);
    assert.match(
      hero,
      /sandbox-exec -D HOME="\$\$HOME" -f scripts\/hero-no-credentials\.sb \$\(BUN\) run capture-hero/,
    );
  });
  it("the profile denies every real credential store and the keychain CLI", () => {
    const sb = read("../packages/dashboard/scripts/hero-no-credentials.sb");
    for (const store of [
      '"/.codex"',
      '"/.gemini"',
      '"/.claude/.credentials.json"',
      '"/Library/Keychains"',
    ])
      assert.ok(sb.includes(store), `profile denies ${store}`);
    assert.match(sb, /\(deny file-read\* file-write\*/);
    assert.match(sb, /\(deny process-exec \(literal "\/usr\/bin\/security"\)\)/);
  });
  it("its one exception is READ-only, to codex's installed binaries; the keychain service is closed", () => {
    const sb = read("../packages/dashboard/scripts/hero-no-credentials.sb");
    const code = sb.replace(/;;.*$/gm, "");
    // Every allow rule, as written. Anything wider than read access to
    // ~/.codex/packages (all of ~/.codex, or any write) reopens the login.
    const allows: string[] = [];
    for (let i = code.indexOf("(allow"); i >= 0; i = code.indexOf("(allow", i + 1)) {
      let depth = 0;
      let j = i;
      do depth += code[j] === "(" ? 1 : code[j] === ")" ? -1 : 0;
      while (depth > 0 && ++j < code.length);
      allows.push(code.slice(i, j + 1).replace(/\s+/g, " "));
    }
    assert.deepEqual(allows, [
      "(allow default)",
      '(allow file-read* (subpath (string-append (param "HOME") "/.codex/packages")))',
    ]);
    // The allow must come AFTER the deny it narrows (the later rule wins).
    assert.ok(code.indexOf("(allow file-read*") > code.indexOf("(deny file-read* file-write*"));
    assert.match(code, /\(deny mach-lookup[^)]*"com\.apple\.securityd"/);
  });
  it(
    "on macOS, the profile really denies a login in ~/.codex while the binaries stay readable",
    { skip: process.platform !== "darwin" && "sandbox-exec is macOS only" },
    () => {
      // The sandbox matches resolved paths: tmpdir() is under the /var symlink.
      const h = realpathSync(home());
      mkdirSync(join(h, ".codex", "packages"), { recursive: true });
      writeFileSync(join(h, ".codex", "login.json"), "secret");
      writeFileSync(join(h, ".codex", "packages", "codex"), "binary");
      const profile = fileURLToPath(
        new URL("../packages/dashboard/scripts/hero-no-credentials.sb", import.meta.url),
      );
      const sandboxed = (cmd: string) =>
        spawnSync("sandbox-exec", ["-D", `HOME=${h}`, "-f", profile, "/bin/sh", "-c", cmd], {
          encoding: "utf8",
        });
      assert.equal(sandboxed(`cat "${h}/.codex/packages/codex"`).stdout, "binary");
      assert.notEqual(sandboxed(`cat "${h}/.codex/login.json"`).status, 0, "login read denied");
      assert.notEqual(
        sandboxed(`echo x > "${h}/.codex/packages/codex"`).status,
        0,
        "packages stay read-only",
      );
    },
  );
});

describe("the hero shows the REAL CLIs' terminals, never a scripted pane", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../packages/dashboard/scripts/capture-hero.ts", import.meta.url),
    ),
    "utf8",
  );
  it("stages no synthetic session or replayed transcript", () => {
    // A hand-written transcript replayed into a perf session looks like a CLI
    // but isn't one: each terminal must be the binary's own TUI on the mock.
    for (const forbidden of [/\/api\/perf\b/, /emit-raw/, /synthetic\s*:/, /AUTONOMOS_PERF/])
      assert.ok(!forbidden.test(source), `capture-hero.ts matches ${forbidden}`);
  });
  it("points Codex and Gemini at the local mock, with dummy keys only", () => {
    assert.match(source, /wire_api = "responses"/);
    assert.match(source, /base_url = "\$\{mockUrl\}\/v1"/);
    assert.match(source, /env\.GOOGLE_GEMINI_BASE_URL = mockUrl;/);
    assert.match(source, /selectedType: "gemini-api-key"/);
  });
});

