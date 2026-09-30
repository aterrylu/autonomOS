import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
  waitFor,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1), V8. A real server upgrading an OLD
 * install: a 4-char operator token (the audit's live case, where the old
 * `first4...last4` banner printed the whole token) and a pre-#301 config dir
 * (0755 root, 0644 log). After boot:
 *   - the log file is 0600 and the root 0700;
 *   - neither the log nor stdout carries the token (`--print-url` goes to
 *     the terminal only);
 *   - the same short token still authenticates: upgrades never break auth.
 */

const SHORT = "QZXJ";
const mode = (p: string) => statSync(p).mode & 0o777;

describe("V8: an old install's token stays out of its logs", {
  skip: !RUN_INTEGRATION,
  timeout: 60_000,
}, () => {
  let server: BootedServer;
  let logPath: string;

  before(async () => {
    server = await bootServer({
      token: SHORT,
      extraArgs: ["--print-url"],
      prepareConfigDir: (dir) => {
        mkdirSync(join(dir, "logs"), { recursive: true });
        writeFileSync(
          join(dir, "logs", "autonomos.log"),
          "from an older build\n",
        );
        chmodSync(join(dir, "logs", "autonomos.log"), 0o644);
        chmodSync(join(dir, "logs"), 0o755);
        chmodSync(dir, 0o755);
      },
    });
    logPath = join(server.configDir, "logs", "autonomos.log");
  }, HOOK_TIMEOUT);

  after(() =>
    boundedTeardown("token-log-hygiene", async () => {
      await server?.kill();
      if (server) rmSync(server.configDir, { recursive: true, force: true });
    }),
  );

  it("re-tightens the config root and the existing log", () => {
    assert.equal(mode(server.configDir), 0o700, "root");
    assert.equal(mode(join(server.configDir, "logs")), 0o700, "logs dir");
    assert.equal(mode(logPath), 0o600, "log file");
    assert.match(
      readFileSync(logPath, "utf8"),
      /\[security\] removed group\/other access/,
      "says what it tightened",
    );
  });

  it("the banner hides a short token completely", () => {
    assert.match(server.logs(), /Auth token: \(hidden, 4 chars\)/);
  });

  it("the sign-in link reaches the terminal but never the log file", async () => {
    assert.ok(
      await waitFor(async () => server.logs().includes(`#token=${SHORT}`), {
        timeoutMs: 5000,
      }),
      "link on stdout",
    );
    assert.ok(existsSync(logPath));
    assert.ok(
      !readFileSync(logPath, "utf8").includes(SHORT),
      "the log never holds the token",
    );
  });

  it("the short token still authenticates after the upgrade", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents`, {
      headers: { Authorization: `Bearer ${SHORT}` },
    });
    assert.equal(res.status, 200);
  });
});
