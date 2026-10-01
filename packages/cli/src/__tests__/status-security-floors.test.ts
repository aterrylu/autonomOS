import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { securityFloorsLines } from "../commands/status.js";

/**
 * `autonomos status` exit codes are a contract for scripts and supervisors
 * (0 running, 3 stuck). The security-floors section (ADR-137) runs inside the
 * HTTP probe's try, so a check that throws (a corrupt package.json or a
 * dangling link in node_modules) used to fall into the probe's catch and
 * report a healthy daemon as "alive but unreachable", exit 3 (nox on #482).
 */
describe("autonomos status: the security-floors section never throws", () => {
  it("a check that throws reads as 'couldn't check', not as an error", () => {
    const lines = securityFloorsLines(() => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    assert.deepEqual(lines, [
      "  security floors: couldn't check installed dependencies (Unexpected end of JSON input)",
    ]);
  });

  it("always gives a verdict: ok, n/a for a bundle install, NOT MET", () => {
    assert.deepEqual(
      securityFloorsLines(() => []),
      ["  security floors: ok"],
    );
    assert.deepEqual(
      securityFloorsLines(() => null),
      ["  security floors: n/a (bundle install)"],
    );
    const notMet = securityFloorsLines(() => [
      {
        pkg: "ws",
        min: "8.21.1",
        why: "fragment flood",
        problem: "below-floor",
        version: "8.19.0",
        seenBy: "@hono/node-ws",
      },
    ]);
    assert.equal(notMet[0], "  security floors: NOT MET");
    assert.match(notMet.join("\n"), /ws 8\.19\.0 \(loaded by @hono\/node-ws\)/);
  });
});
