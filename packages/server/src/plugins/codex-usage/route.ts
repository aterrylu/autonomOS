import { Hono } from "hono";
import { getCodexUsage } from "./scanner.js";

export const codexUsageRouter = new Hono();

codexUsageRouter.get("/", async (c) => {
  try {
    const data = await getCodexUsage();
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[codex-usage] failed to fetch usage:", message);
    return c.json(
      { error: "Failed to fetch Codex usage", detail: message },
      500,
    );
  }
});
