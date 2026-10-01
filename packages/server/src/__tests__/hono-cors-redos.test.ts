import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Security audit V12: hono < 4.12.34's `cors` middleware split
// Access-Control-Request-Headers with the regex  \s*,\s*  which backtracks
// quadratically on a long run of interior whitespace. The server mounts `cors`
// before auth (run.ts, whenever CORS_ORIGIN is set or the dashboard isn't
// embedded), so one unauthenticated preflight could hold the event loop.
//
// Measured on the pinned 4.12.5: 16k spaces 350 ms, 32k about 2 s, and it
// quadruples per doubling. On 4.13.12: 64k spaces under 1 ms. A 64k header
// finishing well inside a second separates the two by orders of magnitude,
// which stays robust on a loaded CI runner.
//
// Interior whitespace matters: the Headers class trims trailing whitespace,
// so "a" followed only by spaces never reaches the split.
//
// (Line comments on purpose: the regex contains a star-slash, which would
// close a block comment early.)

const ORIGIN = "http://allowed.example";

describe("hono cors preflight is linear in Access-Control-Request-Headers (audit V12)", () => {
  it("a 64k-space header is answered well inside a second", async () => {
    const app = new Hono();
    app.use("*", cors({ origin: ORIGIN }));
    app.get("/x", (c) => c.text("ok"));
    const header = `a${" ".repeat(64_000)}b`;
    const started = performance.now();
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": header,
      },
    });
    const ms = performance.now() - started;
    assert.equal(
      res.status,
      204,
      "precondition: the preflight was handled by cors",
    );
    assert.ok(
      ms < 1_000,
      `cors preflight took ${ms.toFixed(0)} ms (quadratic split?)`,
    );
  });
});
