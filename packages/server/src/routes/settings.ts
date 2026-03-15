import { Hono } from "hono";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import { getSettings, updateSettings } from "../settings.js";

export const settingsRouter = new Hono();

settingsRouter.get("/", (c) => {
  const settings = getSettings();
  // Mask sensitive values — only expose whether they're set
  return c.json({
    claudeSessionKey: settings.claudeSessionKey ? "••••configured" : null,
    claudeOrgId: settings.claudeOrgId || null,
  });
});

settingsRouter.put("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const partial: Record<string, string | undefined> = {};
  if (typeof body.claudeSessionKey === "string") {
    partial.claudeSessionKey = body.claudeSessionKey.trim();
  }
  if (typeof body.claudeOrgId === "string") {
    partial.claudeOrgId = body.claudeOrgId.trim();
  }

  const updated = updateSettings(partial);

  // Invalidate usage cache so new credentials take effect immediately
  if (partial.claudeSessionKey || partial.claudeOrgId) {
    invalidateCache();
  }

  return c.json({
    claudeSessionKey: updated.claudeSessionKey ? "••••configured" : null,
    claudeOrgId: updated.claudeOrgId || null,
  });
});
