/**
 * Who is making the current API request, when it isn't the operator.
 *
 * Agents used to call the REST API with the OPERATOR token (security audit
 * V3), so the server could not tell an agent's call from the human's. The
 * channel server now authenticates with its per-agent token on the internal
 * socket (routes/agentApi.ts), and that router runs the real handler inside
 * `runAsAgent`. A handler that needs to know asks `getAgentCaller()`.
 *
 * AsyncLocalStorage rather than a request header: a header can be sent by
 * anyone who can reach the public listener, while this context is set only by
 * code that has already verified the agent's credential.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentCaller {
  kind: "agent";
  sessionId: string;
}

const storage = new AsyncLocalStorage<AgentCaller>();

export function runAsAgent<T>(caller: AgentCaller, fn: () => T): T {
  return storage.run(caller, fn);
}

/** The verified agent behind this request, or undefined for the operator. */
export function getAgentCaller(): AgentCaller | undefined {
  return storage.getStore();
}
