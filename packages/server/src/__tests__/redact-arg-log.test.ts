import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactArgForLog } from "../agents/runtime.js";

/**
 * Spawn-arg log redaction (nox review, #293).
 *
 * The Codex daemon takes the per-agent + global tokens as literal `-c` flags,
 * so they reach the server log unless scrubbed. A blanket `startsWith('{"…')`
 * check (the old redaction) missed them — this pins that both token vars are
 * redacted wherever they appear in an arg, while non-secret args pass through.
 */
describe("redactArgForLog", () => {
  it("redacts the per-agent token in a Codex -c flag (quoted)", () => {
    const out = redactArgForLog(
      'mcp_servers.autonomos.env.AUTONOMOS_AGENT_TOKEN="deadbeefcafe1234"',
    );
    assert.ok(!out.includes("deadbeefcafe1234"), `leaked: ${out}`);
    assert.ok(out.includes("AUTONOMOS_AGENT_TOKEN="));
  });

  it("redacts the global token too (pre-existing exposure)", () => {
    const out = redactArgForLog(
      'mcp_servers.autonomos.env.AUTONOMOS_TOKEN="9758abcd"',
    );
    assert.ok(!out.includes("9758abcd"), `leaked: ${out}`);
  });

  it("redacts an unquoted token value", () => {
    const out = redactArgForLog("AUTONOMOS_AGENT_TOKEN=rawhexvalue99");
    assert.ok(!out.includes("rawhexvalue99"), `leaked: ${out}`);
  });

  it("still collapses the Claude mcpServers / hooks JSON blobs", () => {
    assert.equal(
      redactArgForLog('{"mcpServers":{"autonomos":{"env":{"x":"y"}}}}'),
      '{"mcpServers":...}',
    );
    assert.equal(redactArgForLog('{"hooks":{"Stop":[]}}'), '{"hooks":...}');
  });

  it("passes non-secret args through untouched", () => {
    assert.equal(redactArgForLog("--session-id"), "--session-id");
    assert.equal(redactArgForLog("app-server"), "app-server");
    assert.equal(
      redactArgForLog('mcp_servers.autonomos.env.AUTONOMOS_SESSION_ID="abc"'),
      'mcp_servers.autonomos.env.AUTONOMOS_SESSION_ID="abc"',
    );
  });
});
