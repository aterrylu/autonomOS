import type {
  Provider,
  ProviderInfo,
  RuntimePermissionCheck,
} from "@autonomos/core";
import { Hono } from "hono";
import { getAllProviders } from "../providers/index.js";
import { getPermissionCheck } from "../runtimeProbe.js";

const app = new Hono();

/** How long the providers list waits for a (usually cached) probe verdict. */
const PROBE_WAIT_MS = 2_000;

function installedBinary(p: { resolveBinary(): string }): string | null {
  try {
    return p.resolveBinary();
  } catch {
    return null;
  }
}

/**
 * Start the drift probe for every installed CLI, off the request path. Called
 * once the boot resume has settled, so it never competes with agents coming
 * back up; later requests hit the cache (re-probed when a binary changes).
 */
export function warmPermissionChecks(): void {
  for (const p of getAllProviders()) {
    const binary = installedBinary(p);
    if (binary) void getPermissionCheck(p.name as Provider, binary);
  }
}

/**
 * GET /api/providers — list all registered providers with install status,
 * version, capabilities, and the drift probe's verdict on their permission
 * options. Used by the dashboard's "Create Agent" panel to show runtime options.
 */
app.get("/", async (c) => {
  const providers: ProviderInfo[] = await Promise.all(
    getAllProviders().map(async (p) => {
      const binary = installedBinary(p);
      let permissionCheck: RuntimePermissionCheck | undefined;
      if (binary) {
        // Don't hold the list on a slow first probe: return without a verdict
        // and let the next request pick up the cached one.
        permissionCheck = await Promise.race([
          getPermissionCheck(p.name as Provider, binary),
          new Promise<undefined>((r) => {
            setTimeout(() => r(undefined), PROBE_WAIT_MS).unref();
          }),
        ]);
      }
      return {
        name: p.name,
        displayName: p.displayName,
        installed: binary !== null,
        version: permissionCheck?.version ?? null,
        recommended: p.name === "claude-code",
        capabilities: p.capabilities,
        ...(permissionCheck ? { permissionCheck } : {}),
      };
    }),
  );

  return c.json(providers);
});

export { app as providerRouter };
