import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeMessage } from "../gateway/router.js";

describe("routeMessage — URI routing", () => {
  // Note: routeMessage depends on sessionClients registry.
  // Without registered sessions, agent:// routes will fail with "not found".
  // These tests verify URI parsing, scheme handling, and error paths.

  it("rejects invalid URI (no scheme)", () => {
    const err = routeMessage("no-scheme", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("Invalid URI"));
  });

  it("rejects unknown URI scheme", () => {
    const err = routeMessage("ftp://server/file", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("Unknown URI scheme"));
    assert.ok(err.includes("ftp"));
  });

  it("returns error for agent:// when no agents connected", () => {
    const err = routeMessage("agent://nonexistent", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("not found"));
  });

  it("returns error for discord:// when adapter not connected", () => {
    const err = routeMessage("discord://guild/channel", "hello", "sender-123");
    assert.ok(err);
    assert.ok(err.includes("not available") || err.includes("not connected"));
  });

  it("returns error for telegram:// when adapter not connected", () => {
    const err = routeMessage("telegram://chat-id", "hello", "sender-123");
    assert.ok(err);
  });

  it("returns error for slack:// when adapter not connected", () => {
    const err = routeMessage(
      "slack://workspace/channel",
      "hello",
      "sender-123",
    );
    assert.ok(err);
  });

  it("broadcast:// succeeds even with no agents (no-op)", () => {
    const err = routeMessage("broadcast://all", "hello everyone", "sender-123");
    assert.equal(err, null);
  });

  it("parses URI scheme correctly", () => {
    // agent:// with a name containing special chars
    const err = routeMessage("agent://My Agent", "hello", "sender-123");
    // Should fail with "not found" (no agents registered), not "invalid URI"
    assert.ok(err);
    assert.ok(err.includes("not found"));
    assert.ok(!err.includes("Invalid URI"));
  });
});
