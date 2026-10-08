import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  isLoopbackHost,
  isNetworkBind,
  isTailscaleAddress,
  keepListening,
  parseBindHosts,
} from "../bindHosts.js";

/** L1: the --host list (ADR-139): parsing, and the extra listener's retry. */

describe("parseBindHosts", () => {
  it("one address, a list, quotes and blanks", () => {
    assert.equal(parseBindHosts(undefined), undefined);
    assert.equal(parseBindHosts(""), undefined);
    assert.deepEqual(parseBindHosts("127.0.0.1"), ["127.0.0.1"]);
    assert.deepEqual(parseBindHosts("127.0.0.1, 100.70.53.56"), [
      "127.0.0.1",
      "100.70.53.56",
    ]);
    assert.deepEqual(parseBindHosts(`"127.0.0.1",'dev-box',`), [
      "127.0.0.1",
      "dev-box",
    ]);
    assert.equal(parseBindHosts(" , "), undefined);
  });
});

describe("isNetworkBind", () => {
  it("all interfaces, or any non-loopback entry, is a network bind", () => {
    assert.equal(isNetworkBind(undefined), true);
    assert.equal(isNetworkBind(["127.0.0.1"]), false);
    assert.equal(isNetworkBind(["127.0.0.1", "::1", "localhost"]), false);
    assert.equal(isNetworkBind(["127.0.0.1", "100.70.53.56"]), true);
    assert.equal(isNetworkBind(["dev-box"]), true);
  });
  it("loopback is 127/8, ::1 and localhost", () => {
    for (const h of ["127.0.0.1", "127.4.5.6", "::1", "localhost"])
      assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["0.0.0.0", "::", "100.64.0.1", "dev-box"])
      assert.equal(isLoopbackHost(h), false, h);
  });
});

/** A fake server whose listen() fails with `codes` in turn, then succeeds. */
function fakeServer(codes: string[], boundAddress?: string) {
  const ee = new EventEmitter() as EventEmitter & {
    listen: (port: number, host: string) => void;
    close: () => void;
    address: () => { address: string } | null;
    attempts: number;
    closed: boolean;
  };
  ee.attempts = 0;
  ee.closed = false;
  ee.listen = () => {
    const code = codes[ee.attempts++];
    queueMicrotask(() => {
      if (code) ee.emit("error", Object.assign(new Error(code), { code }));
      else ee.emit("listening");
    });
  };
  ee.close = () => {
    ee.closed = true;
  };
  ee.address = () => (boundAddress ? { address: boundAddress } : null);
  return ee;
}

/** Run scheduled retries immediately (no real waiting). */
function instantTimers() {
  const pending: Array<() => void> = [];
  return {
    setTimer: (fn: () => void) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimer: () => {
      pending.length = 0;
    },
    async drain() {
      for (let i = 0; i < 20 && pending.length > 0; i++) {
        pending.shift()?.();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

describe("keepListening", () => {
  it("retries an address that isn't up yet, then binds, logging exactly twice", async () => {
    const server = fakeServer(["EADDRNOTAVAIL", "EADDRNOTAVAIL", "ENOTFOUND"]);
    const lines: string[] = [];
    const t = instantTimers();
    keepListening({
      server,
      host: "100.70.53.56",
      port: 3100,
      log: (l) => lines.push(l),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    await t.drain();
    assert.equal(server.attempts, 4, "3 failures, then the bind");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /100\.70\.53\.56 isn't available yet/);
    assert.match(lines[1], /also listening on http:\/\/100\.70\.53\.56:3100/);
  });

  it("gives up (once, loudly) on an error that waiting can't fix", async () => {
    const server = fakeServer(["EACCES"]);
    const lines: string[] = [];
    const t = instantTimers();
    keepListening({
      server,
      host: "10.0.0.5",
      port: 80,
      log: (l) => lines.push(l),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    await t.drain();
    assert.equal(server.attempts, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not retrying/);
  });

  it("stop() cancels the retry and closes the listener", async () => {
    const server = fakeServer(["EADDRNOTAVAIL", "EADDRNOTAVAIL"]);
    const t = instantTimers();
    const l = keepListening({
      server,
      host: "100.70.53.56",
      port: 3100,
      log: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    l.stop();
    await t.drain();
    assert.equal(server.attempts, 1);
    assert.equal(server.closed, true);
  });

  it("an address someone else is SERVING is a loud SECURITY warning, repeated at most once a minute (#480)", async () => {
    const server = fakeServer(["EADDRINUSE", "EADDRINUSE", "EADDRINUSE"]);
    const logs: string[] = [];
    const warns: string[] = [];
    let clock = 0;
    let lookups = 0;
    const t = instantTimers();
    keepListening({
      server,
      host: "100.70.53.56",
      port: 3100,
      log: (l) => logs.push(l),
      warn: (l) => warns.push(l),
      now: () => clock,
      ownerOf: () => {
        lookups += 1;
        return 4242;
      },
      setTimer: (fn) => {
        clock += 30_000; // each retry 30s apart
        return t.setTimer(fn);
      },
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    await t.drain();
    // Failures at t=0, 30s, 60s → warnings at 0 and 60s; then it binds.
    const security = warns.filter((w) => w.includes("SECURITY"));
    assert.equal(security.length, 2);
    assert.match(
      security[0],
      /another process \(pid 4242\) is serving 100\.70\.53\.56:3100/,
    );
    assert.ok(
      warns.some((w) => /is free again/.test(w)),
      "recovery is said",
    );
    assert.ok(
      !logs.some((l) => /Tailscale still starting/.test(l)),
      "not mistaken for 'not up yet'",
    );
    // lsof is synchronous: looked up for the 2 warnings only, not the
    // in-between retry (nox, #480).
    assert.equal(lookups, 2);
  });

  it("a self-collision (another of our own --host entries) is said plainly, not as a squatter, and not retried", async () => {
    const server = fakeServer(["EADDRINUSE", "EADDRINUSE"]);
    const warns: string[] = [];
    const t = instantTimers();
    keepListening({
      server,
      host: "localhost",
      port: 3100,
      log: () => {},
      warn: (l) => warns.push(l),
      ownerOf: () => 777,
      selfPid: 777,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    await t.drain();
    assert.equal(server.attempts, 1, "not retried");
    assert.equal(warns.length, 1);
    assert.match(
      warns[0],
      /already served by another of this server's --host entries/,
    );
    assert.ok(!warns[0].includes("SECURITY"), "not a squatter alarm");
  });

  it("a NAME that resolves outside Tailscale (/etc/hosts 127.0.1.1, a VPC IP) is called out once", async () => {
    for (const bound of ["127.0.1.1", "10.128.0.7"]) {
      const server = fakeServer([], bound);
      const warns: string[] = [];
      keepListening({
        server,
        host: "dev-box",
        port: 3100,
        log: () => {},
        warn: (l) => warns.push(l),
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(warns.length, 1, bound);
      assert.match(
        warns[0],
        new RegExp(
          `dev-box resolved to ${bound.replace(/\./g, "\\.")}, which isn't a Tailscale address`,
        ),
      );
      assert.match(warns[0], /tailscale ip -4/);
    }
  });

  it("a name that resolves into the tailnet, or an IP, is not questioned", async () => {
    for (const [host, bound] of [
      ["dev-box", "100.70.53.56"],
      ["dev-box.tail1234.ts.net", "fd7a:115c:a1e0::1"],
      ["10.0.0.5", "10.0.0.5"],
    ]) {
      const server = fakeServer([], bound);
      const warns: string[] = [];
      keepListening({
        server,
        host,
        port: 3100,
        log: () => {},
        warn: (l) => warns.push(l),
      });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(warns, [], `${host} → ${bound}`);
    }
  });
});

describe("isTailscaleAddress", () => {
  it("is 100.64.0.0/10 and fd7a:115c:a1e0::/48 only", () => {
    for (const a of ["100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0:ab12::1"])
      assert.equal(isTailscaleAddress(a), true, a);
    for (const a of [
      "100.63.0.1",
      "100.128.0.1",
      "127.0.1.1",
      "10.0.0.1",
      "fd7a:115c:a1e1::1",
      "::1",
    ])
      assert.equal(isTailscaleAddress(a), false, a);
  });
});
