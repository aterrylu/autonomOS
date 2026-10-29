## ADR-158: Remove the tailscale serve trust-proxy mode

- **Date:** 2026-10-29
- **Decided by:** Terry (human): "serve option A: remove the Tailscale-serve mode". He keeps the direct tailnet bind. Relayed by TeamLead@autonomOS. SecurityFix-Auth@autonomOS implemented it.
- **Supersedes:** ADR-140 (the trust-proxy decision, in full), and the serve parts of ADR-153 (its PR, #530, closes unmerged)
- **Context:**
  - ADR-140 (#488) added `--trust-proxy=tailscale`: behind `tailscale serve`, autonomOS took a visitor's identity from X-Forwarded-For / Tailscale-User-Login when the TCP peer was loopback.
  - SecurityAudit-Claude found that any local process, of any user, could forge those headers, because a TCP peer carries no uid. ADR-153 (#530) moved the trust onto an owner-only unix socket. It was signed off but held.
  - Terry reaches autonomOS with ADR-139's direct tailnet bind (`--host=127.0.0.1,<tailnet IP>`). There every visitor arrives from its own 100.x (or fd7a:…) address, so no header is needed and nothing can be forged. He chose to remove serve support rather than ship either form.
  - Neither form was ever in a release (latest v0.7.0); this unblocks v0.8.0.
- **Decision:**
  1. **Remove the mode:** the `--trust-proxy` / `AUTONOMOS_TRUST_PROXY` option, `trustProxy.ts` and its guard middleware, the header-derived identity, the Tailscale-login context in the lock (`knownLogins`, `lastFailure.login`, `lastFailureLogin`, the login in the lock log line and in the dashboard's Details), the `trustProxy` field on `GET /api/auth/lock`, the `token status` line, the install-service / install.sh passthrough, the docs that recommended serve, and "trust-proxy counts as a network bind" in the weak-token rule.
  2. **The device is always the TCP peer.** `rawPeerAddress` / `peerAddress` read the socket only; no header changes them.
  3. **A leftover setting is refused loudly, never ignored silently:**
     - **The server** refuses to start (exit 2) when `--trust-proxy` or a non-empty `AUTONOMOS_TRUST_PROXY` is present, and says what to do instead (the `--host` list, `tailscale serve reset`). The flag is still parsed, only so that message replaces a generic "unknown option".
     - **`install-service --trust-proxy`** is refused with the same pointer.
     - **`install.sh`** re-renders an existing service WITHOUT the flag and prints why. An update therefore never crash-loops on a flag nobody can use.
     - Ignoring it silently would be worse than refusing: with serve still pointed at the port, every tailnet visitor would arrive as "this machine", exempt from the new-device lock.
  4. **Upgrade behavior.** No release ever contained `--trust-proxy`: v0.7.0 (2026-09-19) predates #488 (2026-10-08), checked against the tag. So bundle installs, and the in-app updater that applies release bundles, never see it. The only installs that can carry it are source installs that tracked `main` in between:
     - **`off` / `none` / empty** asked for what is now the only mode. They're accepted, with one info line saying the setting can be removed.
     - **Any other value, or a bare flag**, refuses to start (point 3). A bare `--trust-proxy` counts as present without swallowing the next argument, such as `--host=…`.
     - **`install.sh`**, re-rendering a unit that still carries the flag, first asks Tailscale whether serve forwards to that port. If it does, it **stops without changing the unit**: the old version keeps running, and it prints `tailscale serve reset` plus the `--host=127.0.0.1,$(tailscale ip -4)` command. Otherwise it drops the flag with a notice. Re-rendering while serve still forwarded would make every tailnet visitor "this machine" (SecurityAudit, #548).
  5. **Kept:**
     - ADR-139's host list and everything in it (extra listeners, retry, the address-in-use warning, the name-resolution check);
     - the exact (non-/64) keying of Tailscale IPv6 addresses in the throttle (it applies to direct-bind visitors);
     - the new-device lock (ADR-148).
     - The docs say plainly that a reverse proxy on the same machine isn't supported, and why.
  6. **A CI guard keeps the header-trust path from coming back:**
     - a server/source scan fails if `X-Forwarded-For` or `Tailscale-User-Login` is read outside tests;
     - a real-server test sends those headers from loopback TCP and checks they never become an identity;
     - tests cover the refusals.
- **Rationale:**
  - **The direct bind already gives per-device identity with nothing to forge**: the address comes from the network, not a header. That's the setup in use.
  - **Removing an unshipped feature is cheaper and safer than keeping a second identity path** that only one configuration needs. The socket version was sound but adds surface (a socket, per-platform paths, a fail-closed rule) for a setup nobody runs.
  - **Refusing a leftover setting loudly matches the failure it prevents**, and install.sh's drop keeps updates working.
- **Alternatives considered:**
  - **Merge ADR-153's socket version (#530)**: sound and signed off, but it keeps code and docs for a mode Terry doesn't use. It can come back from #530 if serve is ever wanted.
  - **Ship #488 marked experimental**: ships the any-local-uid forge knowingly.
  - **Ignore a leftover flag with a warning**: with serve still pointed at the port, every visitor silently counts as this machine.
- **Source:** Terry's decision relayed by TeamLead@autonomOS on the agent channel (2026-10-29); SecurityAudit-Claude's #488 finding; the #530 thread.
