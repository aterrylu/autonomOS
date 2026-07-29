/**
 * Polling waits shared by the test suites.
 *
 * Extracted because two copies had already drifted three ways (default
 * timeout, poll interval, and the shape of the timeout message) between the two
 * Codex daemon helpers — sibling suites that fail in the same CI job were
 * producing differently-worded failures for the identical class of failure.
 */

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `predicate` until it is true; throw after `timeoutMs`.
 *
 * Prefer this over a fixed sleep anywhere an assertion depends on the wait.
 * Real ports and real servers race, and a guessed sleep is how a suite passes
 * locally and fails only under CI load.
 *
 * `message` may be a THUNK, and should be whenever it reports observed state.
 * A plain template literal is evaluated at CALL time — i.e. before the wait —
 * so `waitUntil(() => x.length === 1, \`saw ${x.length}\`)` always reports
 * "saw 0" no matter what actually arrived, which is precisely the least
 * informative thing it could say on the failure you wrote it to diagnose.
 */
export async function waitUntil(
  predicate: () => boolean,
  message: string | (() => string),
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${
      typeof message === "function" ? message() : message
    }`,
  );
}

/**
 * Await a promise, but FAIL rather than hang if it never settles.
 *
 * Use this for any promise whose contract is "settles on a terminal outcome" —
 * the delivery promises from `deliverToCodex`, in particular. A bare `await` on
 * one of those turns a broken settle into a HANG: `node:test` has no default
 * per-test timeout, so the runner child sits silent until CI's wall clock kills
 * the job, hours later, pointing at nothing. This was not hypothetical — a
 * mutation that removed dispose()'s settle loop hung the local run instead of
 * failing it, which is how it got noticed.
 */
export async function settlesWithin<T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not settle within ${timeoutMs}ms — a delivery promise ` +
              `that never settles leaves its sender waiting out the ack window ` +
              `and being told "still retrying" about a terminal outcome`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
