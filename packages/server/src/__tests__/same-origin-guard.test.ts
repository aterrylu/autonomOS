import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { cappedWarn, sameOriginGuard } from "../sameOriginGuard.js";

/**
 * L1: the CSRF / cross-site WebSocket guard's decision table (V1). The
 * integration suite (same-origin-guard-integration.test.ts) proves it is
 * MOUNTED in front of every route on the real server. This one proves what it
 * decides, header by header.
 */

function makeApp(allowedOrigins: string[] = []) {
  const warnings: string[] = [];
  const app = new Hono();
  const guard = sameOriginGuard({
    allowedOrigins,
    warn: (l) => warnings.push(l),
  });
  app.use("/api/*", guard);
  app.use("/ws/*", guard);
  app.all("/api/*", (c) => c.json({ ok: true }));
  app.get("/ws/*", (c) => c.json({ ok: true }));
  return { app, warnings };
}

const HOST = "127.0.0.1:4711";
/** What the real dashboard sends for a JSON POST. */
const DASHBOARD = {
  Host: HOST,
  Origin: `http://${HOST}`,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/json",
};
const WS = {
  Host: HOST,
  Upgrade: "websocket",
  Connection: "Upgrade",
};

async function status(
  app: Hono,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  const res = await app.request(`http://${HOST}${path}`, init);
  if (res.status === 403) assert.equal((await res.json()).code, "CROSS_ORIGIN");
  return res.status;
}

describe("sameOriginGuard: browser requests", () => {
  const { app } = makeApp();

  it("passes the dashboard's own JSON POST", async () => {
    assert.equal(
      await status(app, "/api/templates", {
        method: "POST",
        headers: DASHBOARD,
        body: "{}",
      }),
      200,
    );
  });

  for (const site of ["same-site", "cross-site", "SAME-SITE"]) {
    it(`refuses Sec-Fetch-Site: ${site} (another port of this host is same-site)`, async () => {
      assert.equal(
        await status(app, "/api/templates", {
          method: "POST",
          headers: {
            ...DASHBOARD,
            "Sec-Fetch-Site": site,
            Origin: "http://127.0.0.1:4712",
          },
          body: "{}",
        }),
        403,
      );
    });
  }

  it("passes Sec-Fetch-Site: none (typed URL / bookmark)", async () => {
    assert.equal(
      await status(app, "/api/x", {
        method: "POST",
        headers: { ...DASHBOARD, "Sec-Fetch-Site": "none" },
        body: "{}",
      }),
      200,
    );
  });

  it("trusts Sec-Fetch-Site over Origin (a Host-rewriting reverse proxy)", async () => {
    assert.equal(
      await status(app, "/api/x", {
        method: "POST",
        headers: { ...DASHBOARD, Origin: "https://box.example" },
        body: "{}",
      }),
      200,
    );
  });

  describe("older browsers (no Fetch Metadata): Origin must be this server", () => {
    const { "Sec-Fetch-Site": _, ...old } = DASHBOARD;
    it("passes Origin == Host", async () => {
      assert.equal(
        await status(app, "/api/x", {
          method: "POST",
          headers: old,
          body: "{}",
        }),
        200,
      );
    });
    it("passes Origin == X-Forwarded-Host", async () => {
      assert.equal(
        await status(app, "/api/x", {
          method: "POST",
          headers: {
            ...old,
            Origin: "https://box.example",
            "X-Forwarded-Host": "box.example",
          },
          body: "{}",
        }),
        200,
      );
    });
    for (const origin of [
      "http://127.0.0.1:4712",
      "http://localhost:4711",
      "http://evil.127.0.0.1.nip.io:4711",
      "null",
      "not a url",
    ]) {
      it(`refuses Origin: ${origin}`, async () => {
        assert.equal(
          await status(app, "/api/x", {
            method: "POST",
            headers: { ...old, Origin: origin },
            body: "{}",
          }),
          403,
        );
      });
    }
  });
});

describe("sameOriginGuard: JSON-only bodies (no-preflight form posts)", () => {
  const { app } = makeApp();
  const { "Content-Type": _, ...noType } = DASHBOARD;

  for (const type of [
    "text/plain",
    "text/plain;charset=UTF-8",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
  ]) {
    it(`refuses Content-Type: ${type}`, async () => {
      assert.equal(
        await status(app, "/api/agents", {
          method: "POST",
          headers: { ...noType, "Content-Type": type },
          body: "{}",
        }),
        403,
      );
    });
  }

  it("refuses a form type even when the body is empty (a kill needs no body)", async () => {
    assert.equal(
      await status(app, "/api/agents/a/kill", {
        method: "POST",
        headers: { ...noType, "Content-Type": "text/plain" },
      }),
      403,
    );
  });

  it("refuses a body with no Content-Type at all", async () => {
    assert.equal(
      await status(app, "/api/agents", {
        method: "POST",
        headers: { ...noType, "Content-Length": "2" },
      }),
      403,
    );
  });

  it("passes JSON with parameters and +json types", async () => {
    for (const type of [
      "application/json; charset=utf-8",
      "Application/JSON",
      "application/merge-patch+json",
    ]) {
      assert.equal(
        await status(app, "/api/x", {
          method: "PATCH",
          headers: { ...noType, "Content-Type": type },
          body: "{}",
        }),
        200,
        type,
      );
    }
  });

  it("passes a body-less DELETE with no Content-Type (the dashboard's shape)", async () => {
    assert.equal(
      await status(app, "/api/templates/t", {
        method: "DELETE",
        headers: noType,
      }),
      200,
    );
  });

  it("leaves reads alone", async () => {
    assert.equal(
      await status(app, "/api/agents", {
        headers: {
          Host: HOST,
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "text/plain",
        },
      }),
      200,
    );
  });
});

describe("sameOriginGuard: non-browser clients keep working", () => {
  const { app } = makeApp();

  it("passes a header-less JSON POST (Node/Bun fetch, the channel server)", async () => {
    assert.equal(
      await status(app, "/api/agents", {
        method: "POST",
        headers: { Host: HOST, "Content-Type": "application/json" },
        body: "{}",
      }),
      200,
    );
  });

  it("passes a Bearer caller that sends no JSON type (curl -d)", async () => {
    assert.equal(
      await status(app, "/api/agents", {
        method: "POST",
        headers: {
          Host: HOST,
          Authorization: "Bearer t",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "{}",
      }),
      200,
    );
  });

  it("does NOT let a Bearer header excuse a cross-site origin", async () => {
    assert.equal(
      await status(app, "/api/agents", {
        method: "POST",
        headers: {
          ...DASHBOARD,
          "Sec-Fetch-Site": "same-site",
          Authorization: "Bearer t",
        },
        body: "{}",
      }),
      403,
    );
  });
});

describe("sameOriginGuard: WebSocket upgrades", () => {
  const { app, warnings } = makeApp();

  it("passes a same-origin upgrade", async () => {
    assert.equal(
      await status(app, "/ws/agents", {
        headers: {
          ...WS,
          Origin: `http://${HOST}`,
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      200,
    );
  });

  it("refuses an upgrade from another port (Origin only)", async () => {
    assert.equal(
      await status(app, "/ws/terminal/abc", {
        headers: { ...WS, Origin: "http://127.0.0.1:4712" },
      }),
      403,
    );
  });

  it("refuses an upgrade marked same-site", async () => {
    assert.equal(
      await status(app, "/ws/agents", {
        headers: {
          ...WS,
          Origin: "http://127.0.0.1:4712",
          "Sec-Fetch-Site": "same-site",
        },
      }),
      403,
    );
  });

  it("passes a header-less upgrade (Node's WebSocket, ws)", async () => {
    assert.equal(await status(app, "/ws/agents", { headers: WS }), 200);
  });

  it("names the refused request in the log, never a credential", () => {
    assert.ok(
      warnings.some((w) => w.includes("WebSocket upgrade on /ws/terminal/abc")),
    );
    assert.ok(warnings.every((w) => !/Bearer|token=/.test(w)));
  });
});

describe("sameOriginGuard: configured origins", () => {
  for (const site of ["same-site", "cross-site"]) {
    it(`passes CORS_ORIGIN from a modern browser (Sec-Fetch-Site: ${site})`, async () => {
      const { app } = makeApp(["http://localhost:5173"]);
      assert.equal(
        await status(app, "/api/x", {
          method: "POST",
          headers: {
            ...DASHBOARD,
            Origin: "http://localhost:5173",
            "Sec-Fetch-Site": site,
          },
          body: "{}",
        }),
        200,
      );
    });
  }

  it("still refuses any OTHER origin marked same-site, even with CORS_ORIGIN set", async () => {
    const { app } = makeApp(["http://localhost:5173"]);
    assert.equal(
      await status(app, "/api/x", {
        method: "POST",
        headers: {
          ...DASHBOARD,
          Origin: "http://localhost:5174",
          "Sec-Fetch-Site": "same-site",
        },
        body: "{}",
      }),
      403,
    );
  });

  it("CORS_ORIGIN doesn't lift the JSON-only rule", async () => {
    const { app } = makeApp(["http://localhost:5173"]);
    assert.equal(
      await status(app, "/api/x", {
        method: "POST",
        headers: {
          ...DASHBOARD,
          Origin: "http://localhost:5173",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "text/plain",
        },
        body: "{}",
      }),
      403,
    );
  });

  it("passes an origin named in allowedOrigins (CORS_ORIGIN)", async () => {
    const { app } = makeApp(["http://localhost:5173"]);
    const { "Sec-Fetch-Site": _, ...old } = DASHBOARD;
    assert.equal(
      await status(app, "/api/x", {
        method: "POST",
        headers: { ...old, Origin: "http://localhost:5173" },
        body: "{}",
      }),
      200,
    );
  });
});

describe("sameOriginGuard: refusal logging stays bounded", () => {
  it("logs the first 20, then a running tally at 100, 1000, …", () => {
    const lines: string[] = [];
    const warn = cappedWarn(20, (l) => lines.push(l));
    for (let i = 1; i <= 1500; i++) warn(`refusal ${i}`);
    assert.equal(lines.filter((l) => l.startsWith("refusal")).length, 20);
    const tallies = lines.filter((l) =>
      /cross-origin requests refused/.test(l),
    );
    assert.equal(tallies.length, 2, "at 100 and 1000");
    assert.match(
      tallies[0],
      /^\[auth\] 100 cross-origin requests refused .*80 not logged/,
    );
    assert.match(tallies[1], /latest: refusal 1000$/);
  });
});
