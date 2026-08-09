/**
 * Edge-triggered poller logging — one line per state TRANSITION, silence in
 * between. Regression for the 2026-08-08 audit finding: the usage poller wrote
 * a 15-line network stack every poll cycle while offline (111 occurrences,
 * ~13% of the live rotating log).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { createEdgeLogger } from "../plugins/claude-usage/edgeLog.js";

describe("createEdgeLogger", () => {
  let errors: string[];
  let logs: string[];

  beforeEach(() => {
    errors = [];
    logs = [];
    mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    mock.method(console, "log", (...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  it("logs the first failure once, then suppresses repeats", () => {
    const edge = createEdgeLogger("[test] poll");
    for (let i = 0; i < 50; i++) edge.failure(new Error("connect timeout"));
    assert.equal(errors.length, 1, "only the healthy→failing edge logs");
    assert.match(errors[0], /\[test\] poll failed: connect timeout/);
  });

  it("logs recovery once with the suppressed-failure count", () => {
    const edge = createEdgeLogger("[test] poll");
    for (let i = 0; i < 7; i++) edge.failure(new Error("down"));
    edge.success();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /recovered after 7 failed attempt\(s\)/);
    // Steady-state success stays silent.
    edge.success();
    assert.equal(logs.length, 1);
  });

  it("a new outage after recovery logs again (edge, not once-ever)", () => {
    const edge = createEdgeLogger("[test] poll");
    edge.failure(new Error("down"));
    edge.success();
    edge.failure(new Error("down again"));
    assert.equal(errors.length, 2);
    edge.success();
    assert.match(logs[1], /recovered after 1 failed attempt\(s\)/);
  });

  it("keeps the log line single-line for multi-line error messages", () => {
    const edge = createEdgeLogger("[test] poll");
    edge.failure(
      new Error(
        "Failed to connect to the server.\nReason: deep transport\ngoo",
      ),
    );
    assert.equal(errors.length, 1);
    assert.ok(!errors[0].includes("\n"), "no embedded newlines");
    assert.match(errors[0], /Failed to connect to the server\. …/);
  });

  it("stringifies non-Error throwables", () => {
    const edge = createEdgeLogger("[test] poll");
    edge.failure("plain string reason");
    assert.match(errors[0], /plain string reason/);
  });
});
