/**
 * In-process event bus for agent state changes.
 *
 * Server code (runtime, REST routes, MCP handlers) emits AgentDeltas here.
 * Subscribers (WebSocket broadcaster, future audit-log writer, future
 * scheduler hooks) react to them.
 *
 * Why a custom typed emitter instead of node:events: type-safety on the
 * event union, plus zero coupling to listener removal idioms — subscribers
 * just register a function and get back an unsubscribe handle.
 */

import type { AgentDelta } from "@autonomos/core";

type Listener = (event: AgentDelta) => void;

const listeners = new Set<Listener>();

/** Emit an event to all current subscribers. Errors in one listener don't
 *  affect the others — broadcast is best-effort. */
export function emitAgentDelta(event: AgentDelta): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(
        `[events/agents] listener error for ${event.type}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
  }
}

/** Subscribe to all agent events. Returns an unsubscribe function. */
export function onAgentDelta(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For testing — clear all subscribers between cases. */
export function _resetListenersForTesting(): void {
  listeners.clear();
}
