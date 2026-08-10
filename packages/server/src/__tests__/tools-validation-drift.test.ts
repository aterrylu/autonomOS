/**
 * Drift guard: mcp/tools.ts's hand-written JSON Schemas vs validation.ts's
 * Zod shapes (consolidation PR B).
 *
 * tools.ts MUST stay hand-written JSON — it is bundled into the channel
 * server, which cannot import @autonomos/core (or transitively, this server's
 * validation module). That means the channel transport's advertised schemas
 * are a COPY of the Zod source by construction. This test is what keeps the
 * copy honest, the same trick tools-permission-schema.test.ts uses for the
 * permission enum: derive JSON Schema from the Zod shape (z.toJSONSchema) and
 * compare property names, types, enums, required sets, and descriptions.
 *
 * If this fails you edited one side only. Fix BOTH: the Zod shape in
 * validation.ts (the source) and the JSON literal in mcp/tools.ts (the copy).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  TOOL_CREATE_AGENT,
  TOOL_CREATE_ENV_PRESET,
  TOOL_CREATE_SCHEDULE,
  TOOL_CREATE_TEMPLATE,
  TOOL_DELETE_ENV_PRESET,
  TOOL_DELETE_SCHEDULE,
  TOOL_GET_ORG_CHART,
  TOOL_GET_SCHEDULE,
  TOOL_KILL_AGENT,
  TOOL_RUN_SCHEDULE,
  TOOL_SET_MANAGER,
  TOOL_UPDATE_ENV_PRESET,
  TOOL_UPDATE_SCHEDULE,
  type ToolDef,
} from "../mcp/tools.js";
import {
  createAgentShape,
  createEnvPresetShape,
  createScheduleShape,
  createTemplateShape,
  deleteScheduleShape,
  envPresetNameShape,
  killAgentShape,
  orgChartShape,
  runScheduleShape,
  scheduleNameShape,
  setManagerShape,
  updateEnvPresetShape,
  updateScheduleShape,
} from "../validation.js";

/** Every MCP tool whose input is declared in BOTH places. Tools without a
 *  Zod shape (list_*, send, self_exit) have no source to drift from. */
const PAIRS: Array<[ToolDef, Record<string, z.ZodType>]> = [
  [TOOL_CREATE_AGENT, createAgentShape],
  [TOOL_KILL_AGENT, killAgentShape],
  [TOOL_SET_MANAGER, setManagerShape],
  [TOOL_GET_ORG_CHART, orgChartShape],
  [TOOL_CREATE_TEMPLATE, createTemplateShape],
  [TOOL_CREATE_SCHEDULE, createScheduleShape],
  [TOOL_GET_SCHEDULE, scheduleNameShape],
  [TOOL_UPDATE_SCHEDULE, updateScheduleShape],
  [TOOL_DELETE_SCHEDULE, deleteScheduleShape],
  [TOOL_RUN_SCHEDULE, runScheduleShape],
  [TOOL_CREATE_ENV_PRESET, createEnvPresetShape],
  [TOOL_UPDATE_ENV_PRESET, updateEnvPresetShape],
  [TOOL_DELETE_ENV_PRESET, envPresetNameShape],
];

interface JsonProp {
  type?: string;
  enum?: unknown[];
  description?: string;
  items?: { type?: string };
  default?: unknown;
}

function zodToJson(shape: Record<string, z.ZodType>): {
  properties: Record<string, JsonProp>;
  required: string[];
} {
  const json = z.toJSONSchema(z.object(shape), { io: "input" }) as {
    properties?: Record<string, JsonProp>;
    required?: string[];
  };
  return { properties: json.properties ?? {}, required: json.required ?? [] };
}

describe("mcp/tools.ts JSON literals match validation.ts Zod shapes", () => {
  for (const [tool, shape] of PAIRS) {
    it(`${tool.name}`, () => {
      const derived = zodToJson(shape);
      const literal = tool.inputSchema;
      const literalProps = literal.properties as Record<string, JsonProp>;

      // Same property names, no extras on either side.
      assert.deepEqual(
        Object.keys(literalProps).sort(),
        Object.keys(derived.properties).sort(),
        `${tool.name}: property sets differ`,
      );

      // Same required set (order-insensitive; absent = []).
      assert.deepEqual(
        [...(literal.required ?? [])].sort(),
        [...derived.required].sort(),
        `${tool.name}: required sets differ`,
      );

      for (const [key, lit] of Object.entries(literalProps)) {
        const der = derived.properties[key];
        if (lit.type !== undefined) {
          assert.equal(
            der.type,
            lit.type,
            `${tool.name}.${key}: type differs (zod=${der.type}, json=${lit.type})`,
          );
        }
        if (lit.enum !== undefined) {
          assert.deepEqual(
            der.enum,
            lit.enum,
            `${tool.name}.${key}: enum differs`,
          );
        }
        if (lit.items?.type !== undefined) {
          assert.equal(
            der.items?.type,
            lit.items.type,
            `${tool.name}.${key}: items.type differs`,
          );
        }
        if (lit.description !== undefined) {
          assert.equal(
            der.description,
            lit.description,
            `${tool.name}.${key}: description drifted`,
          );
        }
      }
    });
  }
});
