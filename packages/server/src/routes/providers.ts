import { Hono } from "hono";
import { getAllProviders } from "../providers/index.js";

const app = new Hono();

/**
 * GET /api/providers — list all registered providers with install status and capabilities.
 * Used by the dashboard's "Create Agent" panel to show runtime options.
 */
app.get("/", (c) => {
  const providers = getAllProviders().map((p) => {
    let installed = false;
    try {
      p.resolveBinary();
      installed = true;
    } catch {
      // not installed
    }

    return {
      name: p.name,
      displayName: p.displayName,
      installed,
      version: null as string | null,
      recommended: p.name === "claude-code",
      capabilities: p.capabilities,
    };
  });

  return c.json(providers);
});

export { app as providerRouter };
