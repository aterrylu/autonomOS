import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "hono";
import {
  clientIdentity,
  parseTrustProxy,
  type TrustProxyMode,
} from "../trustProxy.js";

/**
 * L1: who a request is from, under `--trust-proxy=tailscale` (ADR-140). The
 * header rules were measured against tailscaled 1.102.3: it always sends
 * X-Forwarded-For (tagged nodes too), Tailscale-User-Login for user-owned
 * nodes, and overwrites anything the visitor sent.
 */

function ctx(peer: string, headers: Record<string, string> = {}): Context {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    env: { incoming: { socket: { remoteAddress: peer } } },
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

const id = (peer: string, headers: Record<string, string>, m: TrustProxyMode) =>
  clientIdentity(ctx(peer, headers), m);

describe("trust-proxy=tailscale", () => {
  it("a request tailscale serve forwarded is the visitor's tailnet address, with the login as context", () => {
    assert.deepEqual(
      id(
        "127.0.0.1",
        {
          "X-Forwarded-For": "100.70.53.56",
          "Tailscale-User-Login": "terry@example.com",
        },
        "tailscale",
      ),
      {
        address: "100.70.53.56",
        via: "tailscale-serve",
        login: "terry@example.com",
      },
    );
  });

  it("a tagged node (no user headers) is still identified by its address", () => {
    assert.deepEqual(
      id("::1", { "X-Forwarded-For": "100.69.245.108" }, "tailscale"),
      { address: "100.69.245.108", via: "tailscale-serve", login: undefined },
    );
  });

  it("this machine without the header (the CLI, a local dashboard) stays local", () => {
    assert.deepEqual(id("127.0.0.1", {}, "tailscale"), {
      address: "127.0.0.1",
      via: "local",
    });
  });

  it("SPOOFING from the network is ignored: headers from a non-loopback peer are never read", () => {
    assert.deepEqual(
      id(
        "192.168.1.50",
        {
          "X-Forwarded-For": "127.0.0.1",
          "Tailscale-User-Login": "terry@example.com",
        },
        "tailscale",
      ),
      { address: "192.168.1.50", via: "direct" },
    );
    assert.deepEqual(
      id(
        "::ffff:100.64.0.9",
        { "X-Forwarded-For": "100.70.53.56" },
        "tailscale",
      ),
      { address: "100.64.0.9", via: "direct" },
    );
  });

  it("anything but exactly one IP in X-Forwarded-For is an error (tailscaled sends one)", () => {
    for (const bad of ["100.1.1.1, 100.2.2.2", "not-an-ip", "", "  "])
      assert.ok(
        "error" in id("127.0.0.1", { "X-Forwarded-For": bad }, "tailscale"),
        JSON.stringify(bad),
      );
  });

  it("the login is made printable and short (it lands in a log line)", () => {
    const r = id(
      "127.0.0.1",
      {
        "X-Forwarded-For": "100.70.53.56",
        "Tailscale-User-Login": `evil\u001b[31m\n${"x".repeat(300)}`,
      },
      "tailscale",
    );
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.ok(!/[\u0000-\u001f]/.test(r.login ?? ""));
      assert.ok((r.login ?? "").length <= 100);
    }
  });
});

describe("trust-proxy off (the default)", () => {
  it("the headers are never read: a forwarded request is just this machine", () => {
    assert.deepEqual(
      id("127.0.0.1", { "X-Forwarded-For": "100.70.53.56" }, "off"),
      { address: "127.0.0.1", via: "local" },
    );
  });
});

describe("parseTrustProxy", () => {
  it("accepts tailscale and off; refuses anything else", () => {
    assert.equal(parseTrustProxy(undefined), "off");
    assert.equal(parseTrustProxy(""), "off");
    assert.equal(parseTrustProxy("off"), "off");
    assert.equal(parseTrustProxy("Tailscale"), "tailscale");
    assert.throws(() => parseTrustProxy("nginx"), /Unknown --trust-proxy/);
  });
});
