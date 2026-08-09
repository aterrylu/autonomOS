/**
 * Retraction SEAM coverage — the leaf logic is tested in
 * channel-server-check.test.ts against a fake IO; these tests pin the three
 * real wirings that make retraction work in production (guard placement, not
 * just guard logic):
 *
 *   1. pushSystemNotification mints an id and retractSystemNotification
 *      splices exactly that item (routes/hooks.ts);
 *   2. the gateway registration edge (registerSessionClient) stands a check
 *      down (gateway/router.ts → channelServerCheck);
 *   3. a check wired to the REAL notification store warns into it and the
 *      registration edge retracts from it.
 *
 * Before these, commenting out the router.ts noteChannelServerRegistered call
 * — which disables retraction entirely — left the whole suite green.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { WSContext } from "hono/ws";
import {
  _resetChannelServerChecksForTesting,
  trackChannelServerRegistration,
} from "../agents/channelServerCheck.js";
import {
  registerSessionClient,
  unregisterSessionClient,
} from "../gateway/router.js";
import {
  clearNotifications,
  getNotifications,
  getUnreadCount,
  pushSystemNotification,
  retractSystemNotification,
} from "../routes/hooks.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out waiting for: ${what}`);
    }
    await sleep(2);
  }
}

/** Minimal stand-in — the router only stores and compares the reference. */
function fakeWs(): WSContext {
  return {} as unknown as WSContext;
}

describe("notification push/retract (routes/hooks.ts)", () => {
  const sid = "seam-hooks-session";
  afterEach(() => clearNotifications(sid));

  it("push mints an id, retract removes exactly that item, second retract is false", () => {
    const keepId = pushSystemNotification(sid, "keep me");
    const dropId = pushSystemNotification(sid, "drop me");
    assert.equal(getNotifications(sid).length, 2);
    assert.equal(getUnreadCount(sid), 2);

    assert.equal(retractSystemNotification(sid, dropId), true);
    const remaining = getNotifications(sid);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, keepId);
    assert.equal(remaining[0].message, "keep me");
    assert.equal(getUnreadCount(sid), 1);

    assert.equal(
      retractSystemNotification(sid, dropId),
      false,
      "retracting an already-gone id reports false",
    );
  });

  it("retract is scoped to the session — the same id in another session is untouched", () => {
    const id = pushSystemNotification(sid, "mine");
    assert.equal(retractSystemNotification("some-other-session", id), false);
    assert.equal(getNotifications(sid).length, 1);
    retractSystemNotification(sid, id);
  });
});

describe("registration edge stands checks down (gateway/router.ts wiring)", () => {
  const sid = "seam-edge-session";

  afterEach(() => {
    _resetChannelServerChecksForTesting();
    clearNotifications(sid);
  });

  it("registerSessionClient stands down a pending check before it can warn", async () => {
    let notified = 0;
    trackChannelServerRegistration(sid, "Seam@test", {
      probe: () => false,
      isLive: () => true,
      notify: (m) => {
        notified++;
        return pushSystemNotification(sid, m);
      },
      retract: (id) => retractSystemNotification(sid, id),
      probeDelaysMs: [30, 30, 30],
    });

    const ws = fakeWs();
    registerSessionClient(sid, ws);

    await sleep(150); // past all probe delays — nothing may fire
    assert.equal(notified, 0, "registration must stand the check down");
    assert.deepEqual(getNotifications(sid), []);
    unregisterSessionClient(ws);
  });

  it("a check warned into the REAL store is retracted by the registration edge", async () => {
    trackChannelServerRegistration(sid, "Seam@test", {
      probe: () => false,
      isLive: () => true,
      notify: (m) => pushSystemNotification(sid, m),
      retract: (id) => retractSystemNotification(sid, id),
      probeDelaysMs: [10, 10, 10],
    });

    await waitFor(
      () => getNotifications(sid).length === 1,
      "final-miss warning lands in the notification store",
    );
    assert.match(getNotifications(sid)[0].message ?? "", /can't send messages/);

    const ws = fakeWs();
    registerSessionClient(sid, ws);
    assert.deepEqual(
      getNotifications(sid),
      [],
      "late registration must retract the warning from the store",
    );
    unregisterSessionClient(ws);
  });
});
