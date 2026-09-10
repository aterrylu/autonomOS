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
import {
  noteAgentMessage,
  pushSystemNotification,
  setAgentStatus,
} from "../routes/hooks.js";
import {
  setCodexActivitySink,
  setCodexInboundNotifier,
  setCodexStatusSink,
  setCodexThreadIdSink,
} from "./codexControl.js";
import {
  type CodexAgentReply,
  readLastCodexAgentMessage,
} from "./codexRollout.js";
import { isSessionClientRegistered } from "./router.js";

// Seam: the rollout reader is swappable so handleCodexActivity's flush behavior
// is unit-testable without a real rollout on disk.
let readAgentMessage: (threadId: string) => CodexAgentReply | null =
  readLastCodexAgentMessage;
/** Test hook — override the Codex agent-message reader; null restores default. */
export function _setCodexAgentMessageReaderForTesting(
  fn: ((threadId: string) => CodexAgentReply | null) | null,
): void {
  readAgentMessage = fn ?? readLastCodexAgentMessage;
}

/**
 * The Codex activity sink: fed by codexControl on every observed status. Two
 * jobs, both keyed off the working→idle turn boundary (`flush`):
 *   1. lastActivityAt (#351) — advance recency on "working", persist on the
 *      turn boundary. `markActivity` owns debounce/monotonicity/unknown-id.
 *   2. unread (#num) badge — a completed turn appends the agent's REPLY (read off
 *      the rollout) as a user-facing "AgentMessage" notification, so a Codex turn
 *      both counts AND shows in the bell panel with content (F3 — supersedes the
 *      earlier content-less Stop bump, which the panel filtered out).
 * Named + exported so the flush-gating is unit-testable (a mid-turn "working"
 * observation must NOT append; only the turn boundary does).
 */
export function handleCodexActivity(
  agentId: string,
  ts: number,
  flush: boolean,
): void {
  const rec = markActivity(agentId as UUID, ts, { flush });
  if (rec) {
    emitAgentDelta({
      type: "agent.updated",
      id: rec.id,
      patch: { lastActivityAt: rec.lastActivityAt },
      version: rec.version,
    });
  }
  // The working→idle flush IS a completed Codex turn. Read the agent's reply off
  // its rollout and append it as a user-facing AgentMessage notification so the
  // turn counts + shows with content.
  //
  // DEDUP is load-bearing (not an optimization): the working→idle edge fires once
  // per turn, but if the daemon reports idle BEFORE Codex flushes this turn's
  // reply, the reader returns the PREVIOUS turn's reply (still the newest on
  // disk) — which we already surfaced. Re-appending would post a stale duplicate
  // as new (worse than a miss). We dedup on the reply's TIMESTAMP, not its text,
  // so a genuinely-repeated reply (a cron Codex agent answering "Done." each run)
  // STILL counts — only a stale re-read of the same rollout line is skipped
  // (nox). When a real turn produces no readable reply yet, nothing is appended
  // (bounded best-effort under-count, logged below so it's observable).
  //
  // Isolated: this runs synchronously under the Codex app-server WS message
  // callback, so a bug here must never propagate out and take down status
  // processing for the agent. The leaves are already guarded (emitAgentDelta
  // wraps subscribers; markActivity self-guards); this wraps the widened surface.
  if (flush) {
    try {
      const threadId = getAgent(agentId as UUID)?.providerThreadId;
      const reply = threadId ? readAgentMessage(threadId) : null;
      if (reply && reply.ts !== lastReplyTsByAgent.get(agentId)) {
        lastReplyTsByAgent.set(agentId, reply.ts);
        noteAgentMessage(agentId, reply.message);
      } else if (threadId && !reply) {
        // Observable breadcrumb for "badge lower than turn count": a turn ended
        // but no reply was readable (not flushed yet / no rollout).
        console.log(
          `[gateway] Codex ${agentId.slice(0, 8)} turn ended with no readable reply yet — not counted`,
        );
      }
    } catch (err) {
      console.warn(
        `[gateway] Codex turn-complete notification for ${agentId.slice(0, 8)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// agentId → the TIMESTAMP of the last reply we surfaced, so a flush that races
// the rollout write can't re-post the previous turn's reply (see above). Keyed on
// ts (occurrence identity), so an identical-text reply from a genuinely new turn
// still counts. One tiny string per Codex agent ever seen — bounded by fleet
// size, negligible; keyed on ts, it also can't wrongly suppress a post-clear
// reply (a new turn carries a new ts). A teardown-prune is a fine follow-up but
// not worth a store↔gateway import cycle here.
const lastReplyTsByAgent = new Map<string, string>();

/** Test hook — clear the per-agent dedup memory between cases. */
export function _resetCodexUnreadDedupForTesting(): void {
  lastReplyTsByAgent.clear();
}

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

  // Feed a Codex agent's genuine work into recency (#351) + the unread badge —
  // Codex has no hook relay, so both were blind (recency frozen at spawn, unread
  // stuck at 0). See handleCodexActivity for the mechanism.
  setCodexActivitySink(handleCodexActivity);

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
