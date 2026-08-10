/**
 * REST API routes for schedule management.
 *
 * CRUD for schedules + run history + scheduler control.
 * Dashboard polls these; MCP tools route through the same CRUD functions.
 */

import type { ScheduleConfig } from "@autonomos/core";
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
  validateScheduleInput,
} from "../schedules.js";
import { getSettings, updateSettings } from "../settings.js";
import {
  parseBody,
  restCreateScheduleSchema,
  restUpdateScheduleSchema,
  schedulerSettingsSchema,
} from "../validation.js";

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
  // Shape (required fields, types, trimming) is the schema's; cron/target/
  // overlap-policy VALIDITY stays with validateScheduleInput below, which the
  // MCP path shares. workingDirectory is NOT required — it only ever configured
  // the removed `isolated` executor's child process, and demanding a field the
  // server ignores is worse than ignoring it quietly.
  const body = await parseBody(c, restCreateScheduleSchema);
  const { name, schedule, target, prompt, workingDirectory } = body;

  const validationError = validateScheduleInput({
    name,
    schedule,
    target,
    timezone: body.timezone,
    overlapPolicy: body.overlapPolicy as ScheduleConfig["overlapPolicy"],
  });
  if (validationError) return c.json({ error: validationError }, 400);

  try {
    const config: ScheduleConfig = {
      name,
      schedule,
      target,
      prompt,
      // Stored verbatim when supplied (deprecated, ignored) so a round-trip
      // through this endpoint doesn't silently drop an operator's value.
      workingDirectory: workingDirectory?.trim() || undefined,
      description: body.description,
      timezone: body.timezone,
      template: body.template,
      // Passed through, never defaulted. The old `: true` here was a third
      // fail-open default (alongside the executor's `!== false` and the MCP
      // schema's `.default(true)`) — it materialized full autonomy for any
      // caller that simply omitted the field. Deprecated and ignored now, but
      // synthesizing a value for a dead field would still misreport what the
      // operator asked for when the record is read back.
      autonomous: body.autonomous,
      overlapPolicy: body.overlapPolicy as ScheduleConfig["overlapPolicy"],
      onComplete: body.onComplete,
      notify: body.notify as ScheduleConfig["notify"],
      enabled: body.enabled ?? true,
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
  // The name is the PATH's — a `name` in the body is accepted (older clients
  // echo the whole record back) and ignored, as it always was: updateSchedule
  // pins `name: existing.name`.
  const { name: _ignoredName, ...rawPartial } = await parseBody(
    c,
    restUpdateScheduleSchema,
  );
  // `overlapPolicy` and `notify` cross the wire as plain strings;
  // validateScheduleInput owns the value check and its message, so the narrowing
  // cast lives here rather than in the schema.
  const partial = rawPartial as Partial<ScheduleConfig>;

  try {
    // Only the keys actually present survive the parse, which is what the
    // `"schedule" in partial` cron re-arm check below reads. Validate the
    // partial against the existing config — cron is checked against the
    // effective timezone (new if provided, else existing).
    const existing = getSchedule(name);
    const validationError = validateScheduleInput(partial, {
      existing: existing ?? undefined,
    });
    if (validationError) return c.json({ error: validationError }, 400);

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
  const { maxConcurrentRuns } = await parseBody(c, schedulerSettingsSchema);

  const settings = getSettings();
  updateSettings({
    scheduler: { ...settings.scheduler, maxConcurrentRuns },
  });

  return c.json({ ok: true, maxConcurrentRuns });
});
