import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "hono";
import {
  clientIdentity,
  getServeCommand,
  markServeConnection,
  parseTrustProxy,
  setServeSocketPath,
  type TrustProxyMode,
} from "../trustProxy.js";

/**
 * L1: who a request is from, under `--trust-proxy=tailscale` (ADR-140, and
 * ADR-153: identity headers are trusted ONLY on the owner-only serve socket).
 * The header rules were measured against tailscaled 1.102.3: it always sends
 * X-Forwarded-For (tagged nodes too), Tailscale-User-Login for user-owned
 * nodes, and overwrites anything the visitor sent.
 */

const SOCKET = "/home/u/.autonomos/serve.sock";
setServeSocketPath(SOCKET);

/** A request on a TCP connection from `peer`. */
function tcp(peer: string, headers: Record<string, string> = {}): Context {
  return ctx({ remoteAddress: peer }, headers);
}

/** A request on the serve socket (a unix socket: no remote address). */
function viaServeSocket(headers: Record<string, string>): Context {
  const socket = {};
  markServeConnection(socket);
  return ctx(socket, headers);
}

function ctx(socket: object, headers: Record<string, string>): Context {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    env: { incoming: { socket } },
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

const T: TrustProxyMode = "tailscale";

describe("trust-proxy=tailscale: the serve socket", () => {
  it("a request tailscaled forwarded over the socket is the visitor's tailnet address, with the login as context", () => {
    assert.deepEqual(
      clientIdentity(
        viaServeSocket({
          "X-Forwarded-For": "100.70.53.56",
          "Tailscale-User-Login": "terry@example.com",
        }),
        T,
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
      clientIdentity(
        viaServeSocket({ "X-Forwarded-For": "100.69.245.108" }),
        T,
      ),
      { address: "100.69.245.108", via: "tailscale-serve", login: undefined },
    );
  });

  it("on the socket, anything but exactly one IP in X-Forwarded-For (or none) is an error", () => {
    for (const bad of ["100.1.1.1, 100.2.2.2", "not-an-ip", "", "  "]) {
      const r = clientIdentity(viaServeSocket({ "X-Forwarded-For": bad }), T);
      assert.ok(
        "error" in r && r.code === "BAD_PROXY_HEADER",
        JSON.stringify(bad),
      );
    }
    const none = clientIdentity(viaServeSocket({}), T);
    assert.ok("error" in none && none.code === "BAD_PROXY_HEADER");
  });

  it("the login is made printable and short (it lands in a log line)", () => {
    const r = clientIdentity(
      viaServeSocket({
        "X-Forwarded-For": "100.70.53.56",
        "Tailscale-User-Login": `evil\u001b[31m\n${"x".repeat(300)}`,
      }),
      T,
    );
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.ok(!/[\u0000-\u001f]/.test(r.login ?? ""));
      assert.ok((r.login ?? "").length <= 100);
    }
  });
});

describe("trust-proxy=tailscale: loopback TCP is never trusted for identity", () => {
  it("plain local browsing (no identity headers) is this machine, unaffected", () => {
    assert.deepEqual(clientIdentity(tcp("127.0.0.1"), T), {
      address: "127.0.0.1",
      via: "local",
    });
    assert.deepEqual(clientIdentity(tcp("::1"), T), {
      address: "::1",
      via: "local",
    });
  });

  it("FAILS CLOSED: loopback TCP carrying tailscale identity headers (serve pointed at the port) is refused, naming the socket command", () => {
    const cases: Array<Record<string, string>> = [
      { "X-Forwarded-For": "100.70.53.56" },
      { "Tailscale-User-Login": "terry@example.com" },
      {
        "X-Forwarded-For": "100.70.53.56",
        "Tailscale-User-Login": "terry@example.com",
      },
    ];
    for (const headers of cases) {
      const r = clientIdentity(tcp("127.0.0.1", headers), T);
      assert.ok("error" in r, JSON.stringify(headers));
      if ("error" in r) {
        assert.equal(r.code, "SERVE_NOT_ON_SOCKET");
        assert.ok(
          r.error.includes(`tailscale serve --bg unix:${SOCKET}`),
          r.error,
        );
      }
    }
  });

  it("a forged header from another local program never becomes a tailnet identity", () => {
    // The #488 residual: any uid can open loopback TCP. It gets a refusal,
    // never someone else's address (and so never spends their budget).
    const r = clientIdentity(
      tcp("127.0.0.1", { "X-Forwarded-For": "100.64.9.9" }),
      T,
    );
    assert.ok("error" in r);
  });
});

describe("trust-proxy=tailscale: other peers", () => {
  it("headers from a network peer are never read", () => {
    assert.deepEqual(
      clientIdentity(
        tcp("192.168.1.50", {
          "X-Forwarded-For": "127.0.0.1",
          "Tailscale-User-Login": "terry@example.com",
        }),
        T,
      ),
      { address: "192.168.1.50", via: "direct" },
    );
    assert.deepEqual(
      clientIdentity(
        tcp("::ffff:100.64.0.9", { "X-Forwarded-For": "100.70.53.56" }),
        T,
      ),
      { address: "100.64.0.9", via: "direct" },
    );
  });
});

describe("trust-proxy off (the default)", () => {
  it("the headers are never read, on TCP or a (stray) marked socket", () => {
    assert.deepEqual(
      clientIdentity(
        tcp("127.0.0.1", { "X-Forwarded-For": "100.70.53.56" }),
        "off",
      ),
      { address: "127.0.0.1", via: "local" },
    );
    const r = clientIdentity(
      viaServeSocket({ "X-Forwarded-For": "100.70.53.56" }),
      "off",
    );
    assert.ok(!("error" in r) && r.via !== "tailscale-serve");
  });
});

describe("an unmarked unix socket is not the serve socket", () => {
  it("only connections accepted on the serve socket carry the mark", () => {
    // A socket object nobody marked (e.g. another listener): headers ignored,
    // and with no remote address it is not loopback, so no identity is taken.
    const r = clientIdentity(ctx({}, { "X-Forwarded-For": "100.70.53.56" }), T);
    assert.ok("error" in r || r.via !== "tailscale-serve");
  });
});

describe("the serve command", () => {
  it("is quoted when the socket path has spaces (the App Store default does), so it pastes into a shell", () => {
    setServeSocketPath(
      "/Users/u/Library/Group Containers/X.group.io.tailscale.ipn.macos/aos-3000.sock",
    );
    assert.equal(
      getServeCommand(),
      'tailscale serve --bg "unix:/Users/u/Library/Group Containers/X.group.io.tailscale.ipn.macos/aos-3000.sock"',
    );
    setServeSocketPath(SOCKET);
    assert.equal(getServeCommand(), `tailscale serve --bg unix:${SOCKET}`);
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
