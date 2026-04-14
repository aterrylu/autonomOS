import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── Test isolation ─────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `autonomos-mcp-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { _createMcpServerForTesting } = await import("../mcp.js");
const { _resetForTesting, _setExecutors, initScheduler, _onRunCompleted } =
  await import("../scheduler.js");

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

async function createClient(): Promise<Client> {
  const server = _createMcpServerForTesting();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP schedule tools (HTTP server)", () => {
  let client: Client;

  beforeEach(async () => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      (name) => {
        _onRunCompleted(name, { status: "success" });
      },
      (name) => {
        _onRunCompleted(name, { status: "success" });
      },
    );
    initScheduler();
    client = await createClient();
  });

  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── create_schedule ────────────────────────────────────────

  describe("create_schedule", () => {
    it("creates a schedule and returns success message", async () => {
      const result = await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "mcp-test",
          schedule: "0 9 * * 1-5",
          target: "isolated",
          prompt: "Run tests",
          workingDirectory: "~/workspace",
        },
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("mcp-test"));
      assert.ok(text.includes("created"));
    });

    it("returns error for duplicate name", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "dup-sched",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "dup-sched",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("already exists"));
    });

    it("returns error for invalid name", async () => {
      const result = await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "INVALID NAME",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("Invalid schedule name"));
    });
  });

  // ── list_schedules ─────────────────────────────────────────

  describe("list_schedules", () => {
    it("returns empty message when no schedules", async () => {
      const result = await client.callTool({
        name: "list_schedules",
        arguments: {},
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("No schedules"));
    });

    it("returns schedules as JSON", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "list-a",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "list_schedules",
        arguments: {},
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      const parsed = JSON.parse(text);
      assert.ok(parsed["list-a"]);
    });
  });

  // ── get_schedule ───────────────────────────────────────────

  describe("get_schedule", () => {
    it("returns schedule with recent runs", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "get-test",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "get_schedule",
        arguments: { name: "get-test" },
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      const parsed = JSON.parse(text);
      assert.equal(parsed.name, "get-test");
      assert.ok(Array.isArray(parsed.recentRuns));
    });

    it("returns error for non-existent schedule", async () => {
      const result = await client.callTool({
        name: "get_schedule",
        arguments: { name: "nonexistent" },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("not found"));
    });
  });

  // ── update_schedule ────────────────────────────────────────

  describe("update_schedule", () => {
    it("updates schedule fields", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "update-me",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "old prompt",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "update_schedule",
        arguments: { name: "update-me", prompt: "new prompt" },
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("updated"));

      // Verify the update persisted
      const getResult = await client.callTool({
        name: "get_schedule",
        arguments: { name: "update-me" },
      });
      const parsed = JSON.parse(
        (getResult.content as { type: string; text: string }[])[0].text,
      );
      assert.equal(parsed.prompt, "new prompt");
    });

    it("returns error for non-existent schedule", async () => {
      const result = await client.callTool({
        name: "update_schedule",
        arguments: { name: "ghost", prompt: "nope" },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("not found"));
    });
  });

  // ── delete_schedule ────────────────────────────────────────

  describe("delete_schedule", () => {
    it("deletes schedule and confirms", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "delete-me",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "delete_schedule",
        arguments: { name: "delete-me" },
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("deleted"));

      // Verify it's gone
      const getResult = await client.callTool({
        name: "get_schedule",
        arguments: { name: "delete-me" },
      });
      assert.ok(getResult.isError);
    });

    it("returns error for non-existent schedule", async () => {
      const result = await client.callTool({
        name: "delete_schedule",
        arguments: { name: "nonexistent" },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("not found"));
    });
  });

  // ── run_schedule ───────────────────────────────────────────

  describe("run_schedule", () => {
    it("triggers schedule and returns success", async () => {
      await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "run-me",
          schedule: "0 9 * * *",
          target: "isolated",
          prompt: "test",
          workingDirectory: "~",
        },
      });

      const result = await client.callTool({
        name: "run_schedule",
        arguments: { name: "run-me" },
      });

      assert.ok(!result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("triggered"));
    });

    it("returns error for non-existent schedule", async () => {
      const result = await client.callTool({
        name: "run_schedule",
        arguments: { name: "ghost" },
      });

      assert.ok(result.isError);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.ok(text.includes("not found"));
    });
  });

  // ── Full lifecycle ─────────────────────────────────────────

  describe("full lifecycle via MCP", () => {
    it("create → list → get → update → run → delete", async () => {
      // Create
      const createResult = await client.callTool({
        name: "create_schedule",
        arguments: {
          name: "lifecycle",
          schedule: "0 9 * * 1-5",
          target: "agent:worker",
          prompt: "Do work",
          workingDirectory: "~/project",
          description: "Lifecycle test",
        },
      });
      assert.ok(!createResult.isError);

      // List
      const listResult = await client.callTool({
        name: "list_schedules",
        arguments: {},
      });
      const listText = (
        listResult.content as { type: string; text: string }[]
      )[0].text;
      assert.ok(listText.includes("lifecycle"));

      // Get
      const getResult = await client.callTool({
        name: "get_schedule",
        arguments: { name: "lifecycle" },
      });
      const schedule = JSON.parse(
        (getResult.content as { type: string; text: string }[])[0].text,
      );
      assert.equal(schedule.target, "agent:worker");

      // Update
      const updateResult = await client.callTool({
        name: "update_schedule",
        arguments: { name: "lifecycle", prompt: "Updated work" },
      });
      assert.ok(!updateResult.isError);

      // Run
      const runResult = await client.callTool({
        name: "run_schedule",
        arguments: { name: "lifecycle" },
      });
      assert.ok(!runResult.isError);

      // Delete
      const deleteResult = await client.callTool({
        name: "delete_schedule",
        arguments: { name: "lifecycle" },
      });
      assert.ok(!deleteResult.isError);

      // Verify gone
      const finalGet = await client.callTool({
        name: "get_schedule",
        arguments: { name: "lifecycle" },
      });
      assert.ok(finalGet.isError);
    });
  });
});
