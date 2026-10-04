/**
 * The polled tree (`GET /api/agents/tree`) and the tree the dashboard's push
 * bridge builds from agent snapshots (`buildAgentTreeNodes` in core) must be
 * the SAME, field for field (pushBridge.ts relies on it). The route used to
 * carry its own copy of the node mapper and drifted: it gained `permission`
 * (ADR-115) while core's `toAgentTreeNode` didn't, so pushed nodes lost the
 * permission the polled ones had (nox, #448).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type AgentTreeNode,
  buildAgentTreeNodes,
  completePermission,
  type UUID,
} from "@autonomos/core";
import { Hono } from "hono";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(
  join(tmpdir(), "aos-treeparity-"),
);

const { agentsRouter } = await import("../routes/agents.js");
const { buildAgent, insertAgent, listAgents, markExited } = await import(
  "../agents/store.js"
);

const app = new Hono();
app.route("/api/agents", agentsRouter);

const lead = "11111111-1111-4111-8111-111111111111" as UUID;
const worker = "22222222-2222-4222-8222-222222222222" as UUID;
const gone = "33333333-3333-4333-8333-333333333333" as UUID;
for (const [id, provider, values] of [
  [lead, "claude-code", { "permission-mode": "auto" }],
  [worker, "codex", { approval_policy: "never" }],
  [gone, "gemini-cli", { "approval-mode": "yolo" }],
] as const) {
  insertAgent(
    buildAgent({
      id,
      name: `n-${id.slice(0, 4)}`,
      workingDirectory: "/tmp",
      provider: provider as never,
      providerSessionId: id,
      permissionMode: "ask",
      permission: completePermission(provider as never, values),
      status: "running",
      managerId: id === worker ? lead : null,
    } as never),
  );
}
markExited(gone, "user_killed");

const polled = async (includeExited: boolean) =>
  (await (
    await app.request(
      `/api/agents/tree${includeExited ? "?includeExited=true" : ""}`,
    )
  ).json()) as AgentTreeNode[];

describe("polled tree == pushed tree", () => {
  for (const includeExited of [false, true]) {
    it(`includeExited=${includeExited}: identical, permission included`, async () => {
      const route = await polled(includeExited);
      const pushed = JSON.parse(
        JSON.stringify(buildAgentTreeNodes(listAgents(), { includeExited })),
      );
      assert.deepEqual(route, pushed);
      // Precondition: the field under test is really there (not both absent).
      const leadNode = route.find((n) => n.id === lead);
      assert.equal(leadNode?.permission?.values["permission-mode"], "auto");
    });
  }
});
