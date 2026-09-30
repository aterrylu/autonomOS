## ADR-124: Throttle failed auth per address and globally, counting only distinct wrong credentials (V2a)

- **Date:** 2026-09-30
- **Decided by:** SecurityFix-Auth@autonomOS (agent) implementing audit finding V2 part (a) and ADR-117 follow-up 5, which Terry approved for fixing. The plan was sent to TeamLead@autonomOS before building.
- **Context:** The audit (V2, High) measured about 24,900 wrong-token guesses per second against the public listener, all plain 401s. A short operator token (which upgrades deliberately preserve) falls in minutes on loopback and in hours over a network. The result is the operator credential, which means code execution through a bypass agent. Nothing counted failures. ADR-117 deferred a limiter on `POST /api/auth` to this change.
- **Decision:**
  1. **`AuthFailureLimiter`** (`authRateLimit.ts`) sits in front of every credential check on the PUBLIC listener: `requireAuth` for `/api/*` and `/ws/*` (including WebSocket upgrades), and `POST /api/auth`. The internal Unix socket is same-user only and is never throttled.
  2. **Only DISTINCT wrong credentials count.** Each failed value is hashed (SHA-256, truncated, never stored raw), and a value the address already failed with is not a new guess. A request that presents no credential makes no guess and isn't counted.
  3. **Per address:** 10 free distinct failures. Each further one locks the address for 1s·2^k, capped at 60s. While an address is locked, its requests get **429 + `Retry-After` before any credential is evaluated**, the right token included.
  4. **Global:** past 300 distinct failures per minute across all addresses, any address with a recent failure is refused until the rate falls. An address with a clean record is still evaluated.
  5. **A success clears the address.**
  6. **Bounded memory:** at most 10,000 address records (least recently seen evicted), idle ones forgotten after 15 minutes, and at most 32 failure hashes per address.
  7. **The address is the TCP peer**, normalized so `::ffff:a.b.c.d` equals `a.b.c.d`. It never comes from `X-Forwarded-For`.
  8. **One seam:** `verifyCredential(c)` in `run.ts` is the only place a credential is judged. Any future credential kind is added there, and the throttle covers it.
  9. **The dashboard says why.** The login form shows the server's "Too many failed sign-in attempts. Try again in Ns." A sign-in link refused with 429 gets its own message instead of "couldn't reach the server".
- **Rationale:**
  - **Distinct-value counting separates a guesser from a confused client.** A guesser must vary the value. An open tab or script holding a stale token (another instance's legacy cookie, an old Bearer) repeats one value forever, and counting those would lock the operator out of their own login page. This matters on localhost, where the operator's browser and a local attacker share `127.0.0.1`.
  - **Refusing before evaluation is what bounds the guess rate.** A limiter that still checks the credential and merely answers slowly lets a parallel guesser keep its full throughput.
  - **The effect:** after the allowance, at most about one guess a minute per address. In the unit test, keeping at it for an hour yields fewer than 80 guesses, against about 90 million unthrottled. A 4-character token goes from minutes to centuries.
  - **The global ceiling bounds IP rotation** without a global lockout that would let an attacker deny service to everyone.
  - **The TCP peer, because a forwarding header is attacker-controlled.**
- **Alternatives considered:**
  - **Count every failure.** Rejected: it self-locks the stale-tab case above.
  - **Delay responses (tarpit) instead of refusing.** Rejected: it doesn't bound a concurrent guesser, and it holds sockets open.
  - **Trust `X-Forwarded-For` behind a proxy.** Rejected as a default: any client can spoof it. An explicit trusted-proxy setting can come later if proxied installs need per-client limits.
  - **Lock the whole server globally** when the global ceiling trips. Rejected: an attacker could then lock out the operator at will.
  - **A persistent (on-disk) limiter.** Rejected: a restart already costs an attacker a boot cycle, and persistence adds a file to secure and migrate.
- **Residual risks (named):**
  - **Behind a reverse proxy**, every client shares the proxy's address. The per-address limit then acts like a shared one, and an attacker's failures can make the operator wait up to 60s.
  - **On a shared host**, a local attacker and the operator share `127.0.0.1`, with the same up-to-60s effect.
  - **A distributed attacker** with many addresses is bounded by the global ceiling, not stopped.
  - **This limits online guessing only.** Weak tokens themselves are V2b: boot warning, dashboard banner, and `autonomos token rotate`.
- **Source:** Security audit phase 1 (SecurityAudit-Claude, V2) and ADR-117 follow-up 5. Brief from TeamLead@autonomOS to SecurityFix-Auth@autonomOS. PR `terry/security-auth-rate-limit`.
