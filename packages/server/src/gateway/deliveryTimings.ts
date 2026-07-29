/**
 * The two deadlines on the `send()` round-trip, in one place because their
 * ORDERING is a correctness contract rather than two independent tunings.
 *
 * The gateway waits `DELIVERY_ACK_MS` for a Codex delivery to be confirmed; the
 * channel server waits `GATEWAY_REQUEST_TIMEOUT_MS` for the gateway's answer.
 * If the second is ever <= the first, they race: a delivery the gateway
 * successfully confirms arrives to a request the channel server has already
 * abandoned and deleted, and the agent is told "timeout" for a message that
 * landed — a false NEGATIVE, the mirror of the false positive ADR-064 removes.
 *
 * They previously lived as two literals in two files on opposite sides of the
 * esbuild bundle boundary, each with a prose comment describing the ordering and
 * nothing enforcing it: either number could be edited alone and both files would
 * still read as correct. `delivery-timings.test.ts` now asserts the relation.
 *
 * NO IMPORTS — this is bundled into `channel-server/dist.mjs` via esbuild with
 * `--packages=external`, so a bare `@autonomos/core` specifier here would not
 * resolve at runtime in the packaged build (the trap recorded in ADR-061).
 */

/** How long the gateway waits for a Codex delivery to be CONFIRMED before it
 *  reports the message as not-yet-arrived. See the sizing note in `router.ts`. */
export const DELIVERY_ACK_MS = 2_000;

/** How long the channel server waits for the gateway's `send_result`. A
 *  backstop for a wedged gateway — NOT the bound that governs a normal send,
 *  which is why it must stay comfortably above `DELIVERY_ACK_MS`. */
export const GATEWAY_REQUEST_TIMEOUT_MS = 5_000;
