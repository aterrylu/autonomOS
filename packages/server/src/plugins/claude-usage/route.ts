import { Hono } from "hono";
import { getRateLimits } from "./scanner.js";

export const claudeUsageRouter = new Hono();

claudeUsageRouter.get("/", async (c) => {
  try {
    const data = await getRateLimits();
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to fetch rate limits:", message);
    return c.json(
      { error: "Failed to fetch rate limits", detail: message },
      500,
    );
  }
});
