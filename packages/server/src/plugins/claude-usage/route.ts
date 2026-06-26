import { Hono } from "hono";
import { getSettings } from "../../settings.js";
import { getRateLimits, invalidateCache } from "./scanner.js";
import { isValidHarvestedKey, setHarvestedSessionKey } from "./sessionStore.js";

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

/**
 * Harvest endpoint. A spawned agent's SessionStart hook relays its
 * `CLAUDE_SESSION_COOKIE` here (localhost, no auth — like the hook relay), so
 * usage works with no manual paste on any install once an agent has run.
 *
 * The cookie is held ONLY in memory (see {@link ./sessionStore}) and is
 * deliberately NEVER logged. Best-effort: a malformed or unwanted relay is
 * silently ignored rather than erroring the hook.
 */
claudeUsageRouter.post("/session", async (c) => {
  // Opt-out: when auto-detect is off, don't even hold the cookie in memory.
  if (getSettings().autoDetectClaudeSession === false) return c.body(null, 204);

  let key = "";
  try {
    key = (await c.req.text()).trim();
  } catch {
    return c.body(null, 204);
  }

  // Accept only something shaped like a claude.ai session cookie (sk-ant-sid…,
  // any version) with no header-injection characters — the value later rides in
  // a Cookie request header. Rejects OAuth/API tokens and stray noise. The
  // value is never logged. (Same guard the scanner applies — see sessionStore.)
  if (isValidHarvestedKey(key)) {
    if (setHarvestedSessionKey(key)) invalidateCache();
  }
  return c.body(null, 204);
});
