/**
 * Gateway initialization — called on server startup.
 *
 * Wires the router's sinks: Codex inbound failure notifications, Codex working-
 * status, the channel-server liveness probe, and thread-id persistence.
 *
 * The platform adapters that used to be registered here are gone (ADR-064).
 * `Platform` had exactly one member and its only implementation was a
 * `StubAdapter` whose `send()` was a `console.log` returning a fabricated
 * message id — so `slack://` reported SUCCESS for every message, guaranteed.
 * That is the same false-ack this PR exists to remove, in its purest form.
 */

import type { UUID } from "@autonomos/core";
import { setChannelServerProbe } from "../agents/runtime.js";
import { getAgent, markActivity, patchAgent } from "../agents/store.js";
import { emitAgentDelta } from "../events/agents.js";
import { pushSystemNotification, setAgentStatus } from "../routes/hooks.js";
import {
  setCodexActivitySink,
  setCodexInboundNotifier,
  setCodexStatusSink,
  setCodexThreadIdSink,
} from "./codexControl.js";
import { isSessionClientRegistered } from "./router.js";

export async function initGateway(): Promise<void> {
  // Surface persistent Codex inbound-delivery failures to the dashboard
  // notification panel. Since ADR-064 the SENDER is told about its own message
  // (the router's ack window expires and reports "not delivered, still
  // retrying") — but only about that one. Nothing else tells the OPERATOR that
  // an agent's inbound is wedged across many senders and many retries.
  setCodexInboundNotifier(pushSystemNotification);

  // Feed Codex agents' live working-status (busy/idle from the app-server event
  // stream) into the same in-memory status map CC/Gemini use — so the dashboard
  // shows real status instead of a flat "running". CodexStatus is a subset of
  // AgentStatus, so this is type-checked end-to-end (no cast).
  setCodexStatusSink(setAgentStatus);

  // Feed a Codex agent's genuine work into `lastActivityAt` (#351) — Codex has
  // no hook relay, so its recency was frozen at spawn (Terry's "birth date, not
  // last-active" bug). "working" (incl. the 10s status poll) advances it; the
  // working→idle turn boundary forces the flush. markActivity owns
  // debounce/monotonicity/unknown-id; a landed flush returns the record, which
  // we push as a recency delta so live dashboards advance (mirrors routes/hooks.ts).
  setCodexActivitySink((agentId, ts, flush) => {
    const rec = markActivity(agentId as UUID, ts, { flush });
    if (rec) {
      emitAgentDelta({
        type: "agent.updated",
        id: rec.id,
        patch: { lastActivityAt: rec.lastActivityAt },
        version: rec.version,
      });
    }
  });

  // Detect a Codex agent whose daemon-launched channel-server MCP subprocess
  // never connected — that agent silently has no outbound path (send + org
  // tools). The runtime schedules a one-shot post-spawn check against this
  // registry signal (registration = the channel server came up).
  setChannelServerProbe(isSessionClientRegistered);

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

  console.log("[gateway] initialized");
}
