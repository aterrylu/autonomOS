import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
  getConfigDir,
} from "../configDir.js";

// The test-escape guard (ADR pending): a test process must NEVER resolve the
// production config dir. This suite runs UNDER the node test runner
// (NODE_TEST_CONTEXT is set), so the guard's own behavior is directly
// observable. Mutation-verified: removing the guard turns the throw cases
// green-for-the-wrong-reason → these assertions red.

const REAL = join(process.env.HOME as string, ".autonomos");
const saved = process.env.AUTONOMOS_CONFIG_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.AUTONOMOS_CONFIG_DIR;
  else process.env.AUTONOMOS_CONFIG_DIR = saved;
  _resetConfigDirForTesting();
});

test("THROWS when a test would resolve the real default dir (env unset)", () => {
  delete process.env.AUTONOMOS_CONFIG_DIR;
  assert.throws(() => getConfigDir(), /REAL config dir/);
});

test("THROWS when the env explicitly points at the real dir (worker-agent inheritance)", () => {
  // autonomOS sets AUTONOMOS_CONFIG_DIR=<real> in every spawned agent's env —
  // presence is NOT isolation; the guard must compare the resolved path.
  process.env.AUTONOMOS_CONFIG_DIR = REAL;
  assert.throws(() => getConfigDir(), /REAL config dir/);
});

test("passes with an isolated env dir", () => {
  process.env.AUTONOMOS_CONFIG_DIR = "/tmp/aos-guard-ok";
  assert.equal(getConfigDir(), "/tmp/aos-guard-ok");
});

test("passes with the explicit test override, even when env points at real", () => {
  process.env.AUTONOMOS_CONFIG_DIR = REAL;
  _setConfigDirForTesting("/tmp/aos-guard-override");
  assert.equal(getConfigDir(), "/tmp/aos-guard-override");
});
