/**
 * Gateway initialization — called on server startup.
 *
 * Creates platform adapters (stubs for now), registers them with
 * the router, and connects to platforms if enabled in settings.
 */

import { getSettings } from "../settings.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { registerAdapter, setRoutes } from "./router.js";

const adapters = [
  new DiscordAdapter(),
  new TelegramAdapter(),
  new SlackAdapter(),
];

export async function initGateway(): Promise<void> {
  for (const adapter of adapters) {
    registerAdapter(adapter);
  }

  const settings = getSettings();
  if (settings.routes) {
    setRoutes(settings.routes);
  }

  // Connect enabled adapters — isolate failures so one bad adapter
  // doesn't prevent the others from starting
  const gateway = settings.gateway;
  if (gateway) {
    for (const adapter of adapters) {
      if (gateway[adapter.platform]?.enabled) {
        try {
          await adapter.connect();
        } catch (err) {
          console.error(
            `[gateway] ${adapter.platform} adapter failed to connect:`,
            err,
          );
        }
      }
    }
  }

  console.log("[gateway] initialized");
}

export async function shutdownGateway(): Promise<void> {
  const results = await Promise.allSettled(
    adapters.filter((a) => a.isConnected()).map((a) => a.disconnect()),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gateway] adapter disconnect failed:", r.reason);
    }
  }
  console.log("[gateway] shut down");
}
