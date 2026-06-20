/**
 * Gateway initialization — called on server startup.
 *
 * Creates platform adapters (stubs for now), registers them with
 * the router, and connects to platforms if enabled in settings.
 */

import { pushSystemNotification, setAgentStatus } from "../routes/hooks.js";
import { getSettings } from "../settings.js";
import { SlackAdapter } from "./adapters/slack.js";
import { setCodexInboundNotifier, setCodexStatusSink } from "./codexControl.js";
import { registerAdapter, setRoutes } from "./router.js";

const adapters = [new SlackAdapter()];

export async function initGateway(): Promise<void> {
  // Surface persistent Codex inbound-delivery failures to the dashboard
  // notification panel (the sender is ack'd on enqueue, so this is the only
  // operator-visible signal that messages aren't landing).
  setCodexInboundNotifier(pushSystemNotification);

  // Feed Codex agents' live working-status (busy/idle from the app-server event
  // stream) into the same in-memory status map CC/Gemini use — so the dashboard
  // shows real status instead of a flat "running". CodexStatus is a subset of
  // AgentStatus, so this is type-checked end-to-end (no cast).
  setCodexStatusSink(setAgentStatus);

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
