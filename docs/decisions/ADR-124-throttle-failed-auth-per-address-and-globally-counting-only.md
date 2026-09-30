## ADR-124: Throttle failed auth per address and globally, counting only distinct wrong credentials (V2a)

- **Date:** 2026-09-30
- **Decided by:** SecurityFix-Auth@autonomOS (agent) implementing audit finding V2 part (a) and ADR-117 follow-up 5, which Terry approved for fixing. The plan was sent to TeamLead@autonomOS before building.
- **Context:** The audit (V2, High) measured about 24,900 wrong-token guesses per second against the public listener, all plain 401s. A short operator token (which upgrades deliberately preserve) falls in minutes on loopback and in hours over a network. The result is the operator credential, which means code execution through a bypass agent. Nothing counted failures. ADR-117 deferred a limiter on `POST /api/auth` to this change.
- **Decision:**
  1. **`AuthFailureLimiter`** (`authRateLimit.ts`) sits in front of every operator-credential evaluation on the PUBLIC listener: `POST /api/auth`, and `requireAuth` (per-port cookie, legacy cookie, Bearer and deprecated `?token=`) for `/api/*` and `/ws/*`, WebSocket upgrades included. All of them share one limiter. Not throttled: the internal Unix socket (same-user only), and the statusline's `GET /api/agents/:id/self`, which checks a 256-bit per-agent token inside the route (nothing guessable).
  2. **Only DISTINCT wrong credentials count.** Each failed value is stored as an HMAC-SHA-256 under a random per-process key, truncated, and never stored or logged raw. A near-miss can be a typo of the real token, so even its digest must not be guessable offline. A value the address already failed with is not a new guess. A request that presents no credential makes no guess and isn't counted.
  3. **Per address:** 10 free distinct failures. Each further one locks the address for 1s·2^k, capped at 60s. While an address is locked, its requests get **429 + `Retry-After` before any credential is evaluated**, the right token included.
  4. **Global:** past 300 distinct failures per minute across all addresses, any address with a recent failure is refused until the rate falls. An address with a clean record is still evaluated.
  5. **A success clears the address.**
  6. **Bounded memory:** at most 10,000 address records (least recently seen evicted), idle ones forgotten after 15 minutes, and at most 32 failure hashes per address.
  7. **The address is the TCP peer**, never `X-Forwarded-For`. It is normalized so `::ffff:a.b.c.d` equals `a.b.c.d`, and **an IPv6 address is keyed by its /64**. One host routinely controls a whole /64, so rotating through it would otherwise give 10 free guesses per address and churn the 10k map (SecurityAudit's pre-review).
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
  - **On a shared host**, a local attacker and the operator share `127.0.0.1`, with the same up-to-60s effect.
  - **A distributed attacker** with many addresses is bounded by the global ceiling, not stopped.
  - **This does NOT make a weak token safe.** An attacker who evades the per-address limit is still held only by the global ceiling of 300 guesses/min (18k/h). At that rate a 4-char hex token (65,536 values) falls in about 3.6 hours and a 4-char lowercase-alphanumeric one (1.68M) in about 4 days. V2a turns minutes into hours or days. Only V2b (warning, banner, `autonomos token rotate`, refusal on new installs) closes live short tokens.
  - **Lockout DoS behind a reverse proxy** (Tailscale serve, nginx, an IAP or ssh forward). Every client arrives as the proxy's address, so anyone able to reach the proxy can keep that address locked. Because refusal happens BEFORE evaluation, the operator's own valid cookie from the same address gets 429 too. Exempting valid cookies isn't possible without creating an oracle, since the cookie value IS the token (ADR-117). The real fix is ADR-117's session-id cookie follow-up. A cheaper follow-up is an opt-in trusted-proxy setting that honors `X-Forwarded-For` only from configured loopback proxies. It is not the default.
- **Source:** Security audit phase 1 (SecurityAudit-Claude, V2) and ADR-117 follow-up 5. Brief from TeamLead@autonomOS to SecurityFix-Auth@autonomOS. PR `terry/security-auth-rate-limit`.
