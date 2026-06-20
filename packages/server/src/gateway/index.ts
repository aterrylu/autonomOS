/**
 * Gateway initialization — called on server startup.
 *
 * Creates platform adapters (stubs for now), registers them with
 * the router, and connects to platforms if enabled in settings.
 */

import { getAgent, patchAgent } from "../agents/store.js";
import { emitAgentDelta } from "../events/agents.js";
import { pushSystemNotification, setAgentStatus } from "../routes/hooks.js";
import { getSettings } from "../settings.js";
import { SlackAdapter } from "./adapters/slack.js";
import {
  setCodexInboundNotifier,
  setCodexStatusSink,
  setCodexThreadIdSink,
} from "./codexControl.js";
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

  // Persist a Codex agent's conversation thread id when it's first discovered,
  // so a later server/daemon restart can resume the conversation instead of
  // forking a fresh thread. Deduped — only write when the id actually changes.
  setCodexThreadIdSink((agentId, threadId) => {
    const agent = getAgent(agentId);
    if (!agent || agent.providerThreadId === threadId) return;
    const result = patchAgent(agentId, { providerThreadId: threadId });
    if (result === undefined || result === "stale") {
      // The sink fires once per agent lifetime; a dropped write here means
      // resume capability is silently lost until the next restart. Surface it.
      console.warn(
        `[gateway] failed to persist Codex thread id for ${agentId.slice(0, 8)} (${result ?? "agent missing"}) — conversation resume may not work on next restart`,
      );
      return;
    }
    // Keep optimistic-concurrency clients in sync with the version bump (matches
    // the write-then-emit pattern of other patchAgent callers), so a dashboard
    // holding a stale version token doesn't 409 on its next edit.
    emitAgentDelta({
      type: "agent.updated",
      id: result.id,
      patch: { providerThreadId: threadId },
      version: result.version,
    });
  });

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
