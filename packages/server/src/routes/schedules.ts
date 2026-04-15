/**
 * REST API routes for schedule management.
 *
 * CRUD for schedules + run history + scheduler control.
 * Dashboard polls these; MCP tools route through the same CRUD functions.
 */

import type { ScheduleConfig } from "@autonomos/core";
import { SUPPORTED_OVERLAP_POLICIES } from "@autonomos/core";
import { Cron } from "croner";
import { Hono } from "hono";
import {
  addScheduleJob,
  getActiveRunCount,
  getMaxConcurrentRuns,
  getQueuedRunCount,
  isSchedulerRunning,
  removeScheduleJob,
  runScheduleNow,
} from "../scheduler.js";
import {
  createSchedule,
  deleteSchedule,
  getRecentRuns,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "../schedules.js";
import { getSettings, updateSettings } from "../settings.js";

export const scheduleRouter = new Hono();
export const schedulerRouter = new Hono();

// ── Schedule CRUD ───────────────────────────────────────────────

scheduleRouter.get("/", (c) => {
  try {
    return c.json(listSchedules());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to list schedules: ${message}` }, 500);
  }
});

scheduleRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { name, schedule, target, prompt, workingDirectory } = body;
  if (typeof name !== "string" || !name.trim())
    return c.json({ error: "name is required" }, 400);
  if (typeof schedule !== "string" || !schedule.trim())
    return c.json({ error: "schedule is required" }, 400);
  if (typeof target !== "string" || !target.trim())
    return c.json({ error: "target is required" }, 400);
  if (typeof prompt !== "string" || !prompt.trim())
    return c.json({ error: "prompt is required" }, 400);
  if (typeof workingDirectory !== "string" || !workingDirectory.trim())
    return c.json({ error: "workingDirectory is required" }, 400);

  // Validate target format
  if (
    target !== "isolated" &&
    !(typeof target === "string" && target.startsWith("agent:"))
  ) {
    return c.json(
      {
        error: `Invalid target "${target}": must be "isolated" or "agent:<name>"`,
      },
      400,
    );
  }

  // Validate cron expression / one-time date
  if (typeof schedule === "string" && !schedule.startsWith("once:")) {
    try {
      const tz = typeof body.timezone === "string" ? body.timezone : undefined;
      new Cron(schedule, { timezone: tz || undefined });
    } catch (err) {
      return c.json(
        {
          error: `Invalid cron expression: ${err instanceof Error ? err.message : err}`,
        },
        400,
      );
    }
  } else if (typeof schedule === "string" && schedule.startsWith("once:")) {
    const d = new Date(schedule.slice("once:".length));
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: "Invalid one-time date format" }, 400);
    }
  }

  // Validate overlap policy
  const overlapPolicy =
    typeof body.overlapPolicy === "string" ? body.overlapPolicy : undefined;
  if (
    overlapPolicy &&
    !SUPPORTED_OVERLAP_POLICIES.includes(overlapPolicy as "skip" | "allow")
  ) {
    return c.json(
      {
        error: `Unsupported overlap policy: "${overlapPolicy}". Supported: ${SUPPORTED_OVERLAP_POLICIES.join(", ")}`,
      },
      400,
    );
  }

  try {
    const config: ScheduleConfig = {
      name: name.trim(),
      schedule: schedule.trim(),
      target: target.trim(),
      prompt: prompt.trim(),
      workingDirectory: workingDirectory.trim(),
      description:
        typeof body.description === "string" ? body.description : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      template: typeof body.template === "string" ? body.template : undefined,
      autonomous: typeof body.autonomous === "boolean" ? body.autonomous : true,
      overlapPolicy: overlapPolicy as ScheduleConfig["overlapPolicy"],
      onComplete:
        typeof body.onComplete === "string" ? body.onComplete : undefined,
      notify:
        typeof body.notify === "string"
          ? (body.notify as ScheduleConfig["notify"])
          : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    };

    const created = createSchedule(config);
    addScheduleJob(created.name, created);

    // Re-read from disk — addScheduleJob updates nextRunAt on disk
    const fresh = getSchedule(created.name) ?? created;

    return c.json({
      ok: true,
      message: `Schedule "${created.name}" created`,
      schedule: fresh,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("already exists") ? 409 : 500;
    return c.json({ error: message }, status);
  }
});

scheduleRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  try {
    const schedule = getSchedule(name);
    if (!schedule) {
      return c.json({ error: `Schedule "${name}" not found` }, 404);
    }
    const runs = getRecentRuns(name, 10);
    return c.json({ ...schedule, recentRuns: runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Invalid schedule name") ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

scheduleRouter.put("/:name", async (c) => {
  const name = c.req.param("name");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const stringFields = [
      "schedule",
      "target",
      "prompt",
      "workingDirectory",
      "description",
      "timezone",
      "template",
      "overlapPolicy",
      "onComplete",
      "notify",
    ] as const;
    const boolFields = ["autonomous", "enabled"] as const;

    const partial: Partial<ScheduleConfig> = {};
    for (const key of stringFields) {
      if (typeof body[key] === "string")
        (partial as Record<string, unknown>)[key] = body[key];
    }
    for (const key of boolFields) {
      if (typeof body[key] === "boolean")
        (partial as Record<string, unknown>)[key] = body[key];
    }

    // Validate overlapPolicy if provided
    if (
      partial.overlapPolicy &&
      !SUPPORTED_OVERLAP_POLICIES.includes(
        partial.overlapPolicy as "skip" | "allow",
      )
    ) {
      return c.json(
        {
          error: `Unsupported overlap policy: "${partial.overlapPolicy}"`,
        },
        400,
      );
    }

    const updated = updateSchedule(name, partial);

    // Recreate Cron job if schedule/timezone/enabled changed
    if (
      "schedule" in partial ||
      "timezone" in partial ||
      "enabled" in partial
    ) {
      addScheduleJob(name, updated);
    }

    return c.json({ ok: true, schedule: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

scheduleRouter.delete("/:name", (c) => {
  const name = c.req.param("name");
  try {
    removeScheduleJob(name);
    const removed = deleteSchedule(name);
    if (!removed) {
      return c.json({ error: `Schedule "${name}" not found` }, 404);
    }
    return c.json({ ok: true, message: `Schedule "${name}" deleted` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

scheduleRouter.post("/:name/run", (c) => {
  const name = c.req.param("name");
  const result = runScheduleNow(name);
  if (result.error) {
    const status = result.error.includes("not found") ? 404 : 409;
    return c.json({ error: result.error }, status);
  }
  return c.json({ ok: true, message: `Schedule "${name}" triggered` });
});

scheduleRouter.get("/:name/runs", (c) => {
  const name = c.req.param("name");
  const limit = Number(c.req.query("limit")) || 50;
  try {
    const runs = getRecentRuns(name, limit);
    return c.json(runs);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

// ── Scheduler global status/settings ────────────────────────────

schedulerRouter.get("/status", (c) => {
  return c.json({
    running: isSchedulerRunning(),
    maxConcurrentRuns: getMaxConcurrentRuns(),
    activeRuns: getActiveRunCount(),
    queuedRuns: getQueuedRunCount(),
  });
});

schedulerRouter.put("/settings", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const maxConcurrentRuns = body.maxConcurrentRuns;
  if (typeof maxConcurrentRuns !== "number" || maxConcurrentRuns < 1) {
    return c.json(
      { error: "maxConcurrentRuns must be a positive number" },
      400,
    );
  }

  const settings = getSettings();
  updateSettings({
    scheduler: { ...settings.scheduler, maxConcurrentRuns },
  });

  return c.json({ ok: true, maxConcurrentRuns });
});
