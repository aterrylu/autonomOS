import { Hono } from "hono";
import { getUsageSummary } from "./scanner.js";

export const claudeUsageRouter = new Hono();

claudeUsageRouter.get("/", async (c) => {
  const days = Number(c.req.query("days")) || 7;
  const clamped = Math.max(1, Math.min(days, 30));
  try {
    const summary = await getUsageSummary(clamped);
    return c.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to scan usage:", message);
    return c.json({ error: "Failed to scan usage", detail: message }, 500);
  }
});
