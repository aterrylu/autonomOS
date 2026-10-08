import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthFailureLimiter,
  BASE_LOCK_MS,
  cappedLockoutWarn,
  FREE_FAILURES,
  GLOBAL_MAX,
  GLOBAL_WINDOW_MS,
  IDLE_MS,
  MAX_ADDRESSES,
  MAX_LOCK_MS,
  normalizeAddress,
  peerAddress,
} from "../authRateLimit.js";

/** L1: the failed-auth throttle's policy (V2), on a fake clock. */

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** `n` distinct wrong guesses from one address. */
function guess(l: AuthFailureLimiter, addr: string, n: number, from = 0) {
  let lock = 0;
  for (let i = from; i < from + n; i++)
    lock = l.recordFailure(addr, `guess-${i}`);
  return lock;
}

describe("AuthFailureLimiter: per address", () => {
  it(`allows ${FREE_FAILURES} distinct failures, then locks`, () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    assert.equal(guess(l, "a", FREE_FAILURES), 0);
    assert.deepEqual(l.check("a"), { ok: true });
    assert.equal(l.recordFailure("a", "one-more"), BASE_LOCK_MS);
    const v = l.check("a");
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.retryAfterMs === BASE_LOCK_MS);
  });

  it("backs off exponentially and caps", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    guess(l, "a", FREE_FAILURES);
    const locks: number[] = [];
    for (let i = 0; i < 12; i++) {
      locks.push(l.recordFailure("a", `more-${i}`));
      c.advance(locks[i]); // wait out each lock, then guess again
    }
    assert.deepEqual(locks.slice(0, 4), [1_000, 2_000, 4_000, 8_000]);
    assert.equal(Math.max(...locks), MAX_LOCK_MS);
    assert.equal(locks.at(-1), MAX_LOCK_MS);
  });

  it("the lock expires on its own", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    guess(l, "a", FREE_FAILURES + 1);
    c.advance(BASE_LOCK_MS - 1);
    assert.equal(l.check("a").ok, false);
    c.advance(1);
    assert.equal(l.check("a").ok, true);
  });

  it("the guess rate drops from unbounded to about one a minute", () => {
    // Keep guessing whenever allowed for an hour of fake time.
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    let guesses = 0;
    for (let s = 0; s < 3600; s++) {
      if (l.check("a").ok) {
        l.recordFailure("a", `g-${guesses++}`);
      }
      c.advance(1000);
    }
    assert.ok(guesses < FREE_FAILURES + 70, `${guesses} guesses in an hour`);
  });

  it("a REPEATED wrong value is not a new guess (a stale tab can't lock you out)", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    for (let i = 0; i < 500; i++) l.recordFailure("a", "stale-cookie");
    assert.deepEqual(l.check("a"), { ok: true });
  });

  it("addresses are independent", () => {
    const l = new AuthFailureLimiter(clock().now);
    guess(l, "a", FREE_FAILURES + 1);
    assert.equal(l.check("a").ok, false);
    assert.deepEqual(l.check("b"), { ok: true });
  });

  it("a success clears the address", () => {
    const l = new AuthFailureLimiter(clock().now);
    guess(l, "a", FREE_FAILURES);
    l.recordSuccess("a");
    assert.equal(guess(l, "a", FREE_FAILURES, 100), 0, "a fresh allowance");
  });
});

describe("AuthFailureLimiter: global ceiling (IP rotation)", () => {
  it("past GLOBAL_MAX distinct failures/window, an address with a failure is refused; a clean one is not", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    // Many addresses, each under its own allowance.
    for (let i = 0; i <= GLOBAL_MAX; i++)
      l.recordFailure(`10.0.${i >> 8}.${i & 255}`, `g-${i}`);
    assert.equal(l.check("10.0.0.1").ok, false, "a rotating address");
    assert.deepEqual(l.check("192.168.1.9"), { ok: true }, "a clean address");
    c.advance(GLOBAL_WINDOW_MS + 1);
    assert.deepEqual(l.check("10.0.0.1"), { ok: true }, "the window passes");
  });
});

describe("AuthFailureLimiter: bounded memory", () => {
  it(`keeps at most ${MAX_ADDRESSES} addresses (least recently seen evicted)`, () => {
    const l = new AuthFailureLimiter(clock().now);
    for (let i = 0; i < MAX_ADDRESSES + 500; i++) l.recordFailure(`a${i}`, "x");
    assert.equal(l.size(), MAX_ADDRESSES);
  });

  it("decays from the last FAILURE, even while the address keeps making requests (#452)", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    guess(l, "a", FREE_FAILURES);
    // The operator's dashboard keeps polling from the same address: each
    // request is checked, and none may keep the failure record alive.
    for (let i = 0; i < 20; i++) {
      c.advance(60_000);
      assert.deepEqual(l.check("a"), { ok: true });
    }
    // 20 minutes after the last failure: forgotten, a fresh allowance.
    assert.equal(guess(l, "a", FREE_FAILURES, 500), 0);
  });

  it("forgets an idle, unlocked address", () => {
    const c = clock();
    const l = new AuthFailureLimiter(c.now);
    guess(l, "a", FREE_FAILURES);
    c.advance(IDLE_MS + 1);
    assert.deepEqual(l.check("a"), { ok: true });
    assert.equal(l.size(), 0);
  });

  it("never stores the credential itself", () => {
    const l = new AuthFailureLimiter(clock().now);
    l.recordFailure("a", "super-secret-guess");
    assert.ok(
      !JSON.stringify([
        ...(l as unknown as { records: Map<string, unknown> }).records,
      ]).includes("super-secret"),
    );
  });
});

describe("helpers", () => {
  it("normalizes IPv4-mapped IPv6", () => {
    assert.equal(normalizeAddress("::ffff:10.1.2.3"), "10.1.2.3");
    assert.equal(normalizeAddress("::1"), "::1");
    // Tailscale IPv6: one exact address per node, so each is its own bucket.
    assert.notEqual(
      normalizeAddress("fd7a:115c:a1e0:ab12:4843:cd96:6245:1001"),
      normalizeAddress("fd7a:115c:a1e0:ab12:4843:cd96:6245:1002"),
    );
    assert.equal(
      normalizeAddress("FD7A:115C:A1E0:AB12:4843:CD96:6245:1001"),
      "fd7a:115c:a1e0:ab12:4843:cd96:6245:1001",
    );
    assert.equal(normalizeAddress(undefined), "unknown");
  });

  it("keys IPv6 by /64", () => {
    assert.equal(
      normalizeAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
      "2001:0db8:0001:0002::/64",
    );
    assert.equal(
      normalizeAddress("2001:db8:1:2::9"),
      normalizeAddress("2001:db8:1:2:ffff::1"),
    );
    assert.notEqual(
      normalizeAddress("2001:db8:1:2::9"),
      normalizeAddress("2001:db8:1:3::9"),
    );
    assert.equal(normalizeAddress("fe80::1%en0"), "fe80:0000:0000:0000::/64");
  });

  it("rotating addresses inside one /64 shares one allowance (#V2a review)", () => {
    const l = new AuthFailureLimiter(clock().now);
    let lock = 0;
    for (let i = 0; i <= FREE_FAILURES; i++)
      lock = l.recordFailure(
        normalizeAddress(`2001:db8:1:2::${(i + 1).toString(16)}`),
        `g-${i}`,
      );
    assert.ok(lock > 0, "the 11th wrong value from the same /64 is limited");
    assert.equal(l.check(normalizeAddress("2001:db8:1:2::abcd")).ok, false);
  });

  it("lockout warnings are capped and carry no credential", () => {
    const lines: string[] = [];
    const warn = cappedLockoutWarn(3, (l) => lines.push(l));
    for (let i = 0; i < 10; i++) warn("10.0.0.1", 4000);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /10\.0\.0\.1 .* for 4s/);
    assert.match(lines[2], /not logged until restart/);
  });
});

describe("peerAddress", () => {
  it("is the TCP peer, never a forwarding header an attacker controls", () => {
    const c = {
      env: { incoming: { socket: { remoteAddress: "::ffff:10.9.8.7" } } },
      req: { header: () => "1.2.3.4" },
    } as unknown as Parameters<typeof peerAddress>[0];
    assert.equal(peerAddress(c), "10.9.8.7");
  });
});
