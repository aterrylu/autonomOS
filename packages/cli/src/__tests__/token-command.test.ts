import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// `token rotate` WRITES the operator token. Against the real config dir it
// would replace the live token, so the config dir and HOME are a throwaway dir,
// set before any server module loads, and asserted before every rotate.
const TEST_DIR = join(tmpdir(), `autonomos-token-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
process.env.HOME = TEST_DIR;
// Agent shells can inherit the live token; it would win over the file.
delete process.env.AUTONOMOS_TOKEN;

const { getConfigDir } = await import("@autonomos/server/configDir.js");
const { runTokenCommand, removeEnvToken } = await import(
  "../commands/token.js"
);

if (getConfigDir() !== TEST_DIR)
  throw new Error(`config dir isolation failed: ${getConfigDir()}`);

let out: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  out = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.warn = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
});
afterEach(() => {
  Object.assign(console, orig);
  delete process.env.AUTONOMOS_TOKEN;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("removeEnvToken", () => {
  it("comments out every active AUTONOMOS_TOKEN line and keeps nothing of the value", () => {
    const { content, changed } = removeEnvToken(
      [
        "PORT=3100",
        "AUTONOMOS_TOKEN=abcd",
        "  export AUTONOMOS_TOKEN = 'wxyz'",
        "# AUTONOMOS_TOKEN=already-a-comment",
        "AUTONOMOS_TOKEN_EXTRA=keep",
      ].join("\n"),
      "on 2026-09-30",
    );
    assert.equal(changed, true);
    assert.ok(!content.includes("abcd") && !content.includes("wxyz"));
    assert.match(content, /^PORT=3100$/m);
    assert.match(content, /^# AUTONOMOS_TOKEN=already-a-comment$/m);
    assert.match(content, /^AUTONOMOS_TOKEN_EXTRA=keep$/m);
    assert.equal(
      content
        .split("\n")
        .filter((l) => l.startsWith("# AUTONOMOS_TOKEN removed")).length,
      2,
    );
  });

  it("leaves a file without the token untouched", () => {
    assert.deepEqual(removeEnvToken("PORT=1\n", "x"), {
      content: "PORT=1\n",
      changed: false,
    });
  });
});

describe("autonomos token rotate", () => {
  it("writes a strong 0600 token and prints a sign-in link, once, to the terminal", async () => {
    assert.equal(getConfigDir(), TEST_DIR, "precondition: isolated");
    writeFileSync(join(TEST_DIR, "token"), "abcd");
    assert.equal(await runTokenCommand(["rotate"]), 0);
    const token = readFileSync(join(TEST_DIR, "token"), "utf8");
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(join(TEST_DIR, "token")).mode & 0o777, 0o600);
    const text = out.join("\n");
    assert.ok(text.includes(`#token=${token}`), "sign-in link");
    assert.ok(!text.includes("abcd"), "never the old token");
  });

  it("takes AUTONOMOS_TOKEN out of the .env, keeping its other lines and mode", async () => {
    assert.equal(getConfigDir(), TEST_DIR, "precondition: isolated");
    const env = join(TEST_DIR, "app.env");
    writeFileSync(env, "PORT=3100\nAUTONOMOS_TOKEN=abcd\n");
    chmodSync(env, 0o640);
    assert.equal(await runTokenCommand(["rotate", `--env-file=${env}`]), 0);
    const after = readFileSync(env, "utf8");
    assert.match(after, /^PORT=3100$/m);
    assert.ok(!after.includes("abcd"));
    assert.match(
      after,
      /^# AUTONOMOS_TOKEN removed by `autonomos token rotate`/m,
    );
    assert.equal(statSync(env).mode & 0o777, 0o640);
  });

  it("warns when this shell still exports AUTONOMOS_TOKEN", async () => {
    assert.equal(getConfigDir(), TEST_DIR, "precondition: isolated");
    process.env.AUTONOMOS_TOKEN = "abcd";
    assert.equal(await runTokenCommand(["rotate"]), 0);
    assert.ok(
      out.some((l) => l.includes("This shell exports AUTONOMOS_TOKEN")),
    );
    assert.ok(!out.join("\n").includes("abcd"));
  });

  it("refuses unknown options without touching anything", async () => {
    writeFileSync(join(TEST_DIR, "token"), "keep-me");
    assert.equal(await runTokenCommand(["rotate", "--bogus"]), 64);
    assert.equal(readFileSync(join(TEST_DIR, "token"), "utf8"), "keep-me");
  });
});

describe("autonomos token status", () => {
  it("reports weak or strong and the length, never the value", async () => {
    writeFileSync(join(TEST_DIR, "token"), "abcd");
    assert.equal(await runTokenCommand(["status"]), 0);
    assert.match(out.join("\n"), /WEAK, 4 characters/);
    assert.ok(!out.join("\n").includes("abcd"));

    out = [];
    writeFileSync(join(TEST_DIR, "token"), "0123456789abcdef".repeat(4));
    await runTokenCommand(["status"]);
    assert.match(out.join("\n"), /strong, 64 characters/);
  });
});
