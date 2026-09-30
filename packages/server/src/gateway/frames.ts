/**
 * Boundary validation for frames a channel server sends on /ws/gateway.
 *
 * The route used to `JSON.parse` a frame and read its fields straight off the
 * result. Any agent can write to this socket (it holds the socket path and a
 * token), so the input is untrusted, and two frames crashed the whole server
 * (security audit V6): `null` threw on `msg.type`, and a `register` without
 * `sessionId` threw on `msg.sessionId.slice`. The handler is async, so those
 * throws became unhandled rejections and Node exited.
 *
 * Every client→server frame now passes this schema before the route reads a
 * field. Only the three types a channel server sends are accepted; the
 * server→client types in `GatewayWsMessage` are never valid inbound.
 *
 * Extra keys are stripped, not rejected, so a newer channel server that adds
 * an optional field still talks to an older server.
 */

import type { GatewayWsMessage } from "@autonomos/core";
import { z } from "zod";

const registerFrame = z.object({
  type: z.literal("register"),
  sessionId: z.string().min(1),
  agentToken: z.string().optional(),
});

const sendFrame = z.object({
  type: z.literal("send"),
  to: z.string(),
  message: z.string(),
  requestId: z.string(),
});

const listAgentsFrame = z.object({
  type: z.literal("list_agents_request"),
  requestId: z.string(),
});

const clientFrame = z.discriminatedUnion("type", [
  registerFrame,
  sendFrame,
  listAgentsFrame,
]);

export type GatewayClientFrame = z.infer<typeof clientFrame>;

// Compile-time link to the shared protocol type: if core changes one of these
// shapes, the schema here must follow or the build fails.
const _matchesProtocol = (f: GatewayClientFrame): GatewayWsMessage => f;
void _matchesProtocol;

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  clientFrame.options.map((o) => o.shape.type.value),
);

export type ParsedFrame =
  | { ok: true; frame: GatewayClientFrame }
  | {
      ok: false;
      /** Safe to log: names the problem, never echoes field values (a
       *  register frame carries a credential). */
      reason: string;
      /** The frame's `type`, when it was a string. */
      type?: string;
      /** The frame's `requestId`, when it was a string, so the route can
       *  still answer a malformed request instead of leaving the sender to
       *  wait out its deadline. */
      requestId?: string;
    };

/** Parse and validate one raw frame. Never throws. */
export function parseGatewayFrame(raw: string): ParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `invalid JSON (${raw.length} bytes)` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const kind =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return { ok: false, reason: `frame is ${kind}, not an object` };
  }
  const obj = value as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const requestId =
    typeof obj.requestId === "string" ? obj.requestId : undefined;
  if (type === undefined) {
    return { ok: false, reason: "frame has no string `type`", requestId };
  }
  if (!KNOWN_TYPES.has(type)) {
    return { ok: false, reason: "unknown message type", type, requestId };
  }
  const result = clientFrame.safeParse(value);
  if (!result.success) {
    // Paths and codes only. Zod's messages can quote the received value.
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
      .join(", ");
    return {
      ok: false,
      reason: `invalid ${type} frame (${issues})`,
      type,
      requestId,
    };
  }
  return { ok: true, frame: result.data };
}
