import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
const { runTokenCommand, removeEnvToken, inspectServiceDefinition } =
  await import("../commands/token.js");
const { runAuthCommand } = await import("../commands/auth.js");
const { findInstalledService } = await import("../lib/service-control.js");
const { getServicePaths } = await import("../lib/service-paths.js");

// rotate EDITS the .env files the installed service loads. It must never find
// the operator's real service (whose .env holds the live token), so abort
// before any test runs unless both lookups resolve inside the sandbox.
if (getConfigDir() !== TEST_DIR)
  throw new Error(`config dir isolation failed: ${getConfigDir()}`);
if (findInstalledService() !== null)
  throw new Error("found an installed service outside the sandbox: aborting");

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
      removed: [],
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
    const text = out.join("\n");
    assert.match(text, /still set, and the server uses it INSTEAD/);
    assert.match(text, /this shell's environment/);
    assert.ok(!text.includes("abcd"));
  });

  it("refuses unknown options without touching anything", async () => {
    writeFileSync(join(TEST_DIR, "token"), "keep-me");
    assert.equal(await runTokenCommand(["rotate", "--bogus"]), 64);
    assert.equal(readFileSync(join(TEST_DIR, "token"), "utf8"), "keep-me");
  });
});

describe("the installed service definition", () => {
  /** A make-prod style install inside the sandbox: a service file that runs a
   *  wrapper script, which loads the repo .env. */
  function fakeService(extraPlist = "") {
    const repo = join(TEST_DIR, "repo");
    mkdirSync(repo, { recursive: true });
    const env = join(repo, ".env");
    writeFileSync(env, "PORT=3100\nAUTONOMOS_TOKEN=abcd\n");
    const wrapper = join(repo, "autonomos-wrapper");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nARGS=()\n[ -f "${env}" ] && ARGS+=(--env-file="${env}")\nexec tsx "\${ARGS[@]}" cli.ts "$@"\n`,
    );
    const { serviceFile } = getServicePaths(TEST_DIR);
    assert.ok(serviceFile.startsWith(TEST_DIR), "precondition: sandboxed");
    mkdirSync(join(serviceFile, ".."), { recursive: true });
    writeFileSync(
      serviceFile,
      `<plist><dict><key>ProgramArguments</key><array><string>${wrapper}</string><string>start</string></array>${extraPlist}</dict></plist>`,
    );
    return { env, serviceFile };
  }

  it("finds the .env a wrapper script loads, and whether the definition sets the token", () => {
    const { env, serviceFile } = fakeService();
    assert.deepEqual(inspectServiceDefinition(serviceFile), {
      setsToken: false,
      envFiles: [env],
    });
    const withToken = fakeService(
      "<key>EnvironmentVariables</key><dict><key>AUTONOMOS_TOKEN</key><string>x</string></dict>",
    );
    assert.equal(
      inspectServiceDefinition(withToken.serviceFile).setsToken,
      true,
    );
  });

  it("rotate cleans the service's .env without being told where it is", async () => {
    const { env } = fakeService();
    // This process got the token from that .env (the wrapper loaded it).
    process.env.AUTONOMOS_TOKEN = "abcd";
    assert.equal(await runTokenCommand(["rotate"]), 0);
    assert.ok(!readFileSync(env, "utf8").includes("abcd"));
    const text = out.join("\n");
    assert.ok(text.includes(`Took AUTONOMOS_TOKEN out of ${env}`));
    assert.ok(
      !text.includes("still set"),
      "no override warning: the env came from the .env it just cleaned",
    );
    assert.ok(!text.includes("abcd"));
  });

  it("the sign-in link uses the PORT the service's .env sets", async () => {
    const { env } = fakeService();
    writeFileSync(env, "PORT=3199\nAUTONOMOS_TOKEN=abcd\n");
    assert.equal(await runTokenCommand(["rotate"]), 0);
    assert.match(out.join("\n"), /http:\/\/localhost:3199\/#token=/);
  });

  it("rotate says loudly when the service definition itself sets the token", async () => {
    const { serviceFile } = fakeService(
      "<key>EnvironmentVariables</key><dict><key>AUTONOMOS_TOKEN</key><string>abcd</string></dict>",
    );
    assert.equal(await runTokenCommand(["rotate"]), 0);
    const text = out.join("\n");
    assert.match(text, /still set, and the server uses it INSTEAD/);
    assert.ok(text.includes(serviceFile));
    assert.match(text, /install-service --force/);
  });

  it("says the old link and sessions stop working after the restart", async () => {
    assert.equal(await runTokenCommand(["rotate"]), 0);
    assert.match(
      out.join("\n"),
      /old token will need the new link|old sign-in link stops working/,
    );
  });
});

describe("autonomos token status", () => {
  it("is read-only: with no token anywhere it creates none", async () => {
    assert.equal(await runTokenCommand(["status"]), 0);
    assert.match(out.join("\n"), /No operator token yet/);
    assert.ok(!existsSync(join(TEST_DIR, "token")), "no token file written");
  });

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

describe("the new-device lock from the CLI (ADR-148)", () => {
  const lockPath = () => join(TEST_DIR, "auth-lock.json");
  const lockedState = () =>
    writeFileSync(
      lockPath(),
      JSON.stringify({ failures: 20, lockedAt: 1_790_000_000_000, known: [] }),
    );

  it("token status reports a lock (counts only) for a short token", async () => {
    writeFileSync(join(TEST_DIR, "token"), "QZXJ");
    lockedState();
    assert.equal(await runTokenCommand(["status"]), 0);
    const text = out.join("\n");
    assert.match(text, /New devices: LOCKED OUT after 20 failed sign-ins/);
    assert.match(text, /autonomos auth unlock/);
    assert.ok(!text.includes("QZXJ"));
  });

  it("token status says open, with the count, before the cap", async () => {
    writeFileSync(join(TEST_DIR, "token"), "QZXJ");
    assert.equal(await runTokenCommand(["status"]), 0);
    assert.match(out.join("\n"), /New devices: open \(0 of 20 failed sign-ins/);
  });

  it("auth unlock with the server stopped clears the saved lock", async () => {
    lockedState();
    assert.equal(await runAuthCommand(["unlock"]), 0);
    assert.match(out.join("\n"), /New devices can sign in again/);
    const saved = JSON.parse(readFileSync(lockPath(), "utf8"));
    assert.equal(saved.lockedAt, null);
    assert.equal(saved.failures, 0);
  });

  it("auth refuses anything but `unlock`", async () => {
    assert.equal(await runAuthCommand([]), 64);
    assert.equal(await runAuthCommand(["lock"]), 64);
  });
});
