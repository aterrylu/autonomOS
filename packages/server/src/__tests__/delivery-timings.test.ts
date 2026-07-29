/**
 * The `send()` round-trip has two deadlines whose ORDERING is a correctness
 * contract, not two independent tunings — and until ADR-064 nothing enforced it.
 *
 * The gateway waits `DELIVERY_ACK_MS` to confirm a Codex delivery; the channel
 * server waits `GATEWAY_REQUEST_TIMEOUT_MS` for the gateway's `send_result`. If
 * the second is ever <= the first they race, and the loser is the AGENT: a
 * delivery the gateway successfully confirmed arrives to a request the channel
 * server has already abandoned and deleted, so `send()` reports a timeout for a
 * message that landed. That is a false NEGATIVE — the mirror image of the false
 * positive this ADR exists to remove, and just as misleading to act on.
 *
 * The two numbers used to be literals in two files on opposite sides of the
 * esbuild bundle boundary, each carrying a prose comment describing the
 * relationship. Prose does not fail a build. Either could have been edited alone
 * and both files would still have read as correct.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELIVERY_ACK_MS,
  GATEWAY_REQUEST_TIMEOUT_MS,
} from "../gateway/deliveryTimings.js";

describe("delivery timings — the two deadlines must not race", () => {
  it("gives the channel server a strictly longer deadline than the gateway's ack window", () => {
    assert.ok(
      GATEWAY_REQUEST_TIMEOUT_MS > DELIVERY_ACK_MS,
      `the channel server's wait (${GATEWAY_REQUEST_TIMEOUT_MS}ms) must exceed ` +
        `the gateway's ack window (${DELIVERY_ACK_MS}ms), or a confirmed ` +
        `delivery can be reported to the agent as a timeout`,
    );
  });

  it("leaves real headroom, not just a strictly-greater margin", () => {
    // `>` alone is satisfied by 2000 vs 2001, which in practice still races:
    // the gateway spends time on name resolution (batchGetTitles stats the
    // filesystem) BEFORE the ack window even starts, and that work is not
    // covered by DELIVERY_ACK_MS. The margin has to absorb it.
    const headroom = GATEWAY_REQUEST_TIMEOUT_MS - DELIVERY_ACK_MS;
    assert.ok(
      headroom >= 1_000,
      `only ${headroom}ms of headroom between the two deadlines — the gateway's ` +
        `pre-window work (name resolution) has to fit in here`,
    );
  });

  it("keeps the ack window well above measured delivery latency", () => {
    // Measured against a loopback daemon: 14.8ms cold (connect + initialize +
    // thread discovery), 0.2ms median warm. A window anywhere near that would
    // report healthy deliveries as not-delivered — and because the reason
    // string tells the agent NOT to re-send, those would look like silent
    // losses rather than something the agent could correct for.
    assert.ok(
      DELIVERY_ACK_MS >= 500,
      `an ack window of ${DELIVERY_ACK_MS}ms is too close to real delivery ` +
        `latency (14.8ms cold) — healthy sends would report as not delivered`,
    );
  });
});
