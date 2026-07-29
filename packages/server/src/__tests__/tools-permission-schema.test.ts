/**
 * Guards the ONE deliberate duplication of the permission-mode value list.
 *
 * `mcp/tools.ts` cannot import from `@autonomos/core`: it is bundled into
 * channel-server/dist.mjs with `--packages=external`, and build-binary.ts
 * copies that bundle into the binary's bundle dir, where a bare
 * `@autonomos/core` specifier does not resolve. An import there would break
 * every agent spawn in the packaged build — at runtime, and only there.
 *
 * So the values are hand-copied, and this file is what keeps the copy honest.
 * It is the substitute for the shared import, not a nice-to-have: without it,
 * adding a fifth mode to core would leave the MCP schema silently rejecting it
 * for both the HTTP and channel servers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "@autonomos/core";
import { TOOL_CREATE_AGENT, TOOL_CREATE_TEMPLATE } from "../mcp/tools.js";

/** Pull the `permissionMode` property out of a tool's JSON Schema. */
function permissionSchema(tool: {
  inputSchema: { properties: Record<string, unknown> };
}): { enum?: unknown; default?: unknown } {
  const prop = tool.inputSchema.properties.permissionMode;
  assert.ok(prop, "tool is missing a permissionMode property");
  return prop as { enum?: unknown; default?: unknown };
}

describe("MCP tool schemas mirror core's permission modes", () => {
  it("create_agent lists exactly PERMISSION_MODES, in order", () => {
    assert.deepEqual(permissionSchema(TOOL_CREATE_AGENT).enum, [
      ...PERMISSION_MODES,
    ]);
  });

  it("create_template lists exactly PERMISSION_MODES, in order", () => {
    assert.deepEqual(permissionSchema(TOOL_CREATE_TEMPLATE).enum, [
      ...PERMISSION_MODES,
    ]);
  });

  it("create_agent's advertised default is the real DEFAULT_PERMISSION_MODE", () => {
    // Advertising a default the server doesn't actually apply is worse than
    // advertising none: an agent reads this schema to decide whether it needs
    // to pass a mode at all.
    assert.equal(
      permissionSchema(TOOL_CREATE_AGENT).default,
      DEFAULT_PERMISSION_MODE,
    );
  });

  it("no schema description claims a mode that does not exist", () => {
    // The pre-rename descriptions read "Default: default", naming a value that
    // is now gone. Quoted mode names in the prose must resolve to real modes.
    const modes = new Set<string>(PERMISSION_MODES);
    for (const tool of [TOOL_CREATE_AGENT, TOOL_CREATE_TEMPLATE]) {
      const desc = String(
        (
          permissionSchema(tool) as unknown as {
            description?: string;
          }
        ).description ??
          (
            tool.inputSchema.properties.permissionMode as {
              description?: string;
            }
          ).description ??
          "",
      );
      for (const quoted of desc.matchAll(/'([a-z_]+)'/g)) {
        assert.ok(
          modes.has(quoted[1]),
          `description quotes '${quoted[1]}', which is not a permission mode`,
        );
      }
    }
  });
});
