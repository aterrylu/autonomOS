import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const {
  parseProcEnv,
  selectFreshestExternalCookie,
  refreshHarvestedFromSessions,
  isServerTree,
  __resetScanThrottleForTests,
} = await import("../plugins/claude-usage/cookieScanner.js");
const { getHarvestedSessionKey, setHarvestedSessionKey } = await import(
  "../plugins/claude-usage/sessionStore.js"
);

// Two distinct, validly-shaped session keys standing in for two accounts.
const KEY_A = "sk-ant-sid02-AAAAAAAAAAAAAAAAAAAA";
const KEY_B = "sk-ant-sid02-BBBBBBBBBBBBBBBBBBBB";
const OAUTH = "sk-ant-oat01-not-a-session-cookie";

type Proc = Parameters<typeof selectFreshestExternalCookie>[0][number];
const proc = (over: Partial<Proc>): Proc => ({
  pid: 1,
  startMs: 0,
  cookie: null,
  hosted: false,
  ...over,
});

describe("cookieScanner.parseProcEnv", () => {
  it("returns null for a process with no session cookie", () => {
    assert.equal(
      parseProcEnv(10, 0, "/usr/local/bin/claude --resume PATH=/x"),
      null,
    );
  });

  it("reads the cookie and marks an external session non-hosted", () => {
    const info = parseProcEnv(
      10,
      123,
      `/bin/claude CLAUDE_SESSION_COOKIE=${KEY_B} HOME=/u`,
    );
    assert.deepEqual(info, {
      pid: 10,
      startMs: 123,
      cookie: KEY_B,
      hosted: false,
    });
  });

  it("marks an autonomOS agent hosted (AGENT_NAME or SESSION_ID marker)", () => {
    const byName = parseProcEnv(
      11,
      0,
      `claude CLAUDE_SESSION_COOKIE=${KEY_A} AUTONOMOS_AGENT_NAME=Foo@bar`,
    );
    assert.equal(byName?.hosted, true);
    const bySession = parseProcEnv(
      12,
      0,
      `claude CLAUDE_SESSION_COOKIE=${KEY_A} AUTONOMOS_SESSION_ID=abc-123`,
    );
    assert.equal(bySession?.hosted, true);
  });
});

describe("cookieScanner.selectFreshestExternalCookie", () => {
  it("returns null with no processes", () => {
    assert.equal(selectFreshestExternalCookie([]), null);
  });

  it("ignores hosted agents entirely", () => {
    assert.equal(
      selectFreshestExternalCookie([proc({ cookie: KEY_A, hosted: true })]),
      null,
    );
  });

  it("returns the only valid external cookie", () => {
    assert.equal(
      selectFreshestExternalCookie([proc({ cookie: KEY_B, hosted: false })]),
      KEY_B,
    );
  });

  it("prefers the most-recently-started external session", () => {
    const cookie = selectFreshestExternalCookie([
      proc({ pid: 1, cookie: KEY_A, startMs: 1_000 }),
      proc({ pid: 2, cookie: KEY_B, startMs: 9_000 }),
    ]);
    assert.equal(cookie, KEY_B);
  });

  it("rejects a non-session-key value (e.g. an OAuth token)", () => {
    assert.equal(
      selectFreshestExternalCookie([proc({ cookie: OAUTH, hosted: false })]),
      null,
    );
  });

  it("picks the external account even when a hosted agent started later", () => {
    // The exact bug: the frozen hosted-agent cookie (KEY_A) must lose to the
    // user's freshly-logged-in interactive session (KEY_B), regardless of age.
    const cookie = selectFreshestExternalCookie([
      proc({ pid: 1, cookie: KEY_A, hosted: true, startMs: 9_999 }),
      proc({ pid: 2, cookie: KEY_B, hosted: false, startMs: 1 }),
    ]);
    assert.equal(cookie, KEY_B);
  });
});

describe("cookieScanner.isServerTree", () => {
  // chain: 100(server) → 200(agent) → 300(shell); 900 is the user's own session
  const ppidOf = new Map<number, number>([
    [200, 100],
    [300, 200],
    [900, 800], // user login shell, unrelated to the server
    [800, 1],
  ]);
  const SERVER = 100;

  it("treats the server process itself as in-tree", () => {
    assert.equal(isServerTree(SERVER, ppidOf, SERVER), true);
  });

  it("treats a direct child (spawned agent / isolated run) as in-tree", () => {
    assert.equal(isServerTree(200, ppidOf, SERVER), true);
  });

  it("treats a deeper descendant as in-tree", () => {
    assert.equal(isServerTree(300, ppidOf, SERVER), true);
  });

  it("treats the user's own session (reparents to init) as external", () => {
    assert.equal(isServerTree(900, ppidOf, SERVER), false);
  });

  it("does not loop on a cyclic ppid map", () => {
    const cyclic = new Map<number, number>([
      [10, 20],
      [20, 10],
    ]);
    assert.equal(isServerTree(10, cyclic, SERVER), false);
  });
});

describe("cookieScanner.refreshHarvestedFromSessions", () => {
  beforeEach(() => {
    setHarvestedSessionKey(null);
    __resetScanThrottleForTests();
  });
  afterEach(() => {
    setHarvestedSessionKey(null);
    __resetScanThrottleForTests();
  });

  it("adopts a fresh external cookie and reports the change", async () => {
    const changed = await refreshHarvestedFromSessions(
      async () => [proc({ cookie: KEY_B, hosted: false, startMs: 5 })],
      1_000,
    );
    assert.equal(changed, true);
    assert.equal(getHarvestedSessionKey(), KEY_B);
  });

  it("switches accounts when a newer external session appears", async () => {
    await refreshHarvestedFromSessions(
      async () => [proc({ cookie: KEY_A, hosted: false, startMs: 5 })],
      1_000,
    );
    assert.equal(getHarvestedSessionKey(), KEY_A);
    // Past the throttle window, a newer session under account B wins.
    const changed = await refreshHarvestedFromSessions(
      async () => [
        proc({ pid: 1, cookie: KEY_A, hosted: false, startMs: 5 }),
        proc({ pid: 2, cookie: KEY_B, hosted: false, startMs: 50 }),
      ],
      100_000,
    );
    assert.equal(changed, true);
    assert.equal(getHarvestedSessionKey(), KEY_B);
  });

  it("throttles repeat scans within the window", async () => {
    let calls = 0;
    const lister = async () => {
      calls++;
      return [proc({ cookie: KEY_B, hosted: false, startMs: 5 })];
    };
    await refreshHarvestedFromSessions(lister, 1_000);
    const second = await refreshHarvestedFromSessions(lister, 1_500); // within 5s
    assert.equal(calls, 1, "second call should be throttled, not rescan");
    assert.equal(second, false);
  });

  it("never clears a previously-good key when no session is live", async () => {
    await refreshHarvestedFromSessions(
      async () => [proc({ cookie: KEY_B, hosted: false, startMs: 5 })],
      1_000,
    );
    assert.equal(getHarvestedSessionKey(), KEY_B);
    // No external sessions now (only a frozen hosted agent) — keep KEY_B.
    const changed = await refreshHarvestedFromSessions(
      async () => [proc({ cookie: KEY_A, hosted: true, startMs: 9 })],
      100_000,
    );
    assert.equal(changed, false);
    assert.equal(getHarvestedSessionKey(), KEY_B);
  });
});
