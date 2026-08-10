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
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_PERMISSION_MODE,
  LEGACY_PERMISSION_MODE_SPELLINGS,
  PERMISSION_MODES,
} from "@autonomos/core";
import { TOOL_CREATE_AGENT, TOOL_CREATE_TEMPLATE } from "../mcp/tools.js";

/** The HTTP transport's zod shapes — read as SOURCE, see describedPermissionProse. */
const VALIDATION_SOURCE = readFileSync(
  new URL("../validation.ts", import.meta.url),
  "utf-8",
);

/** Pull the `permissionMode` property out of a tool's JSON Schema. */
function permissionSchema(tool: {
  inputSchema: { properties: Record<string, unknown> };
}): { enum?: unknown; default?: unknown; description?: string } {
  const prop = tool.inputSchema.properties.permissionMode;
  assert.ok(prop, "tool is missing a permissionMode property");
  return prop as { enum?: unknown; default?: unknown; description?: string };
}

/**
 * Every piece of operator/agent-facing prose describing a permission mode.
 *
 * Deliberately includes the zod `.describe()` strings from validation.ts, not
 * just the JSON Schema in tools.ts. They are two hand-written copies of the
 * same explanation for two different MCP transports, and a check that covers
 * only one leaves the other free to drift — which is precisely how the HTTP and
 * channel servers came to disagree about `list_agents` in the first place.
 */
function describedPermissionProse(): Array<[label: string, prose: string]> {
  const out: Array<[string, string]> = [];
  for (const [label, tool] of [
    ["tools.ts create_agent", TOOL_CREATE_AGENT],
    ["tools.ts create_template", TOOL_CREATE_TEMPLATE],
  ] as const) {
    out.push([label, permissionSchema(tool).description ?? ""]);
  }
  // The zod raw shapes are plain objects in validation.ts (consolidation PR B
  // moved them out of the closure in mcp.ts), so read the source. A
  // brittle-looking approach that is the point: it fails loudly if the file
  // moves, rather than silently checking nothing. Anchored on `.enum(` so it
  // reads the two PUBLISHED modes and not the REST shapes' deliberately loose
  // `permissionMode: z.unknown()`.
  const described = [
    ...VALIDATION_SOURCE.matchAll(
      /permissionMode:\s*z\s*\n?\s*\.enum\([^)]*\)[\s\S]{0,300}?\.describe\(\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ];
  assert.ok(
    described.length >= 2,
    `expected to find both zod permissionMode descriptions in validation.ts, found ${described.length} — has the schema shape changed?`,
  );
  described.forEach((m, i) => {
    out.push([`validation.ts zod #${i + 1}`, m[1]]);
  });
  return out;
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

  it("advertises NO default — because omission does not mean the fallback", () => {
    // Advertising a default the server doesn't actually apply is worse than
    // advertising none: an agent reads this schema to decide whether it needs
    // to pass a mode at all. `default: "ask"` claimed that omitting the field
    // yields `ask`, which is false on every resume — omission PRESERVES the
    // agent's current mode. A client materializing that advertised default
    // would send `permissionMode: "ask"` explicitly on a resume and re-level a
    // deliberately autonomous agent, reproducing the demotion this PR fixed.
    //
    // The fallback chain is explained in the description instead, where it can
    // be stated conditionally.
    for (const tool of [TOOL_CREATE_AGENT, TOOL_CREATE_TEMPLATE]) {
      assert.equal(
        permissionSchema(tool).default,
        undefined,
        `${tool.name} must not advertise a default permission mode`,
      );
    }
  });

  it("both MCP transports advertise the SAME permission vocabulary", () => {
    // The channel server (tools.ts JSON Schema) and the HTTP server
    // (validation.ts zod, consumed by mcp.ts) are hand-written copies for two
    // transports. When they drifted on `list_agents`, agents could not see a
    // peer's mode at all — the readback gap this PR closes. The same drift in
    // the create_agent enum would teach different vocabularies to different
    // clients, so pin them together.
    //
    // Notably this must FAIL if the legacy spelling is added to only one side:
    // backward compatibility belongs at the REST boundary, not in a published
    // enum, precisely because the enum is what a model treats as current.
    const zodEnums = [
      ...VALIDATION_SOURCE.matchAll(
        /permissionMode:\s*z\s*\n?\s*\.enum\(([^)]*)\)/g,
      ),
    ].map((m) => m[1].trim());
    assert.ok(
      zodEnums.length >= 2,
      `expected both zod permissionMode enums in validation.ts, found ${zodEnums.length}`,
    );
    for (const e of zodEnums) {
      assert.equal(
        e,
        "PERMISSION_MODES",
        `validation.ts publishes a permissionMode enum of \`${e}\` instead of deriving it from PERMISSION_MODES — the two transports would advertise different vocabularies`,
      );
    }
  });

  it("no schema description names a mode that does not exist", () => {
    // The defect this exists to catch is the literal pre-rename wording
    // "Default: default" — which is UNQUOTED. An earlier version of this test
    // only scanned `'quoted'` tokens and therefore let the exact string it was
    // written for pass. Check both shapes.
    //
    // Also covers the hand-written zod `.describe()` prose in mcp.ts, which is
    // a second copy of the same text: the two servers advertising different
    // vocabularies is the divergence class this PR is closing.
    const modes = new Set<string>(PERMISSION_MODES);
    const retired = new Set(
      LEGACY_PERMISSION_MODE_SPELLINGS as readonly string[],
    );

    for (const [label, desc] of describedPermissionProse()) {
      // Quoted tokens must name a real mode.
      for (const quoted of desc.matchAll(/'([a-z_]+)'/g)) {
        assert.ok(
          modes.has(quoted[1]),
          `${label} quotes '${quoted[1]}', which is not a permission mode`,
        );
      }
      // A retired spelling must not appear as a bare word either. Word-boundary
      // matched so "the default fallback" (the ordinary English word, now that
      // it no longer names a value) is still allowed — the ban is on presenting
      // it as a MODE, which is what `Default: default` did.
      for (const word of retired) {
        assert.doesNotMatch(
          desc,
          new RegExp(`\\b${word}\\s*[:.]|:\\s*${word}\\b`, "i"),
          `${label} still presents the retired spelling "${word}" as a mode`,
        );
      }
    }
  });
});
