import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOGGED_TYPE_CHARS, parseGatewayFrame } from "../gateway/frames.js";

/**
 * The schema half of the V6 fix, on its own. gateway-malformed-frames.test.ts
 * proves the server SURVIVES bad frames, but the route's catch-all would make
 * that pass even with no schema at all; these pin that the schema itself
 * rejects them, so the route never reads a field off an unvalidated value.
 */
describe("parseGatewayFrame", () => {
  it("accepts each client frame type, stripping unknown keys", () => {
    const reg = parseGatewayFrame(
      '{"type":"register","sessionId":"s1","agentToken":"t","extra":1}',
    );
    assert.deepEqual(reg, {
      ok: true,
      frame: { type: "register", sessionId: "s1", agentToken: "t" },
    });
    assert.ok(
      parseGatewayFrame('{"type":"register","sessionId":"s1"}').ok,
      "agentToken is optional in the schema; verifyAgentToken refuses it",
    );
    assert.ok(
      parseGatewayFrame(
        '{"type":"send","to":"agent://x","message":"m","requestId":"r"}',
      ).ok,
    );
    assert.ok(
      parseGatewayFrame('{"type":"list_agents_request","requestId":"r"}').ok,
    );
  });

  for (const raw of ["null", "42", '"x"', "true", "[]", "{", ""]) {
    it(`rejects non-object input ${JSON.stringify(raw)}`, () => {
      assert.equal(parseGatewayFrame(raw).ok, false);
    });
  }

  it("rejects a register without a non-empty string sessionId (audit PoC 2)", () => {
    for (const raw of [
      '{"type":"register"}',
      '{"type":"register","sessionId":""}',
      '{"type":"register","sessionId":5}',
    ]) {
      const r = parseGatewayFrame(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(!r.ok && r.type, "register");
    }
  });

  it("rejects server→client types sent inbound", () => {
    const r = parseGatewayFrame(
      '{"type":"send_result","requestId":"r","success":true}',
    );
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "unknown message type");
  });

  it("carries a string requestId out of a rejected frame so the route can answer it", () => {
    const r = parseGatewayFrame('{"type":"send","to":5,"requestId":"req-9"}');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.requestId, "req-9");
  });

  it("caps an unknown type, which the route logs (review: 2MB type = 2MB log line)", () => {
    const huge = "x".repeat(2_000_000);
    const r = parseGatewayFrame(JSON.stringify({ type: huge }));
    assert.equal(r.ok, false);
    const type = !r.ok ? (r.type ?? "") : "";
    assert.ok(
      type.length <= MAX_LOGGED_TYPE_CHARS + 32,
      `type carried ${type.length} chars`,
    );
    assert.ok(type.endsWith(`(+${2_000_000 - MAX_LOGGED_TYPE_CHARS} chars)`));
    // A short unknown type is carried as-is (the version-skew warning names it).
    const short = parseGatewayFrame('{"type":"dashboard_connect"}');
    assert.equal(!short.ok && short.type, "dashboard_connect");
  });

  it("never echoes field values in the reason (a register carries a token)", () => {
    const r = parseGatewayFrame(
      '{"type":"register","sessionId":7,"agentToken":"SECRET-TOKEN-VALUE"}',
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && !r.reason.includes("SECRET-TOKEN-VALUE"));
  });
});
