import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  isLoopbackHost,
  isNetworkBind,
  keepListening,
  parseBindHosts,
} from "../bindHosts.js";

/** L1: the --host list (ADR-136): parsing, and the extra listener's retry. */

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
function fakeServer(codes: string[]) {
  const ee = new EventEmitter() as EventEmitter & {
    listen: (port: number, host: string) => void;
    close: () => void;
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
});
