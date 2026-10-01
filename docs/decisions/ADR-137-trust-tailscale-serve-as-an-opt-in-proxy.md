## ADR-137: Trust tailscale serve as an opt-in proxy

- **Date:** 2026-10-01
- **Decided by:** Terry (human): "let's support the tailscale serve approach". He also asked that lockout notices show the Tailscale login, that trust-proxy combined with a non-loopback bind be refused, and that `token status` and the startup log state the mode. TeamLead@autonomOS relayed this and approved the stacking and the CI guards. SecurityFix-Auth@autonomOS measured tailscaled's header behavior, then designed and implemented this.
- **Context:**
  - `tailscale serve` is the canonical Tailscale way to publish a local service:
    - HTTPS with a real certificate;
    - no port open on any interface;
    - only tailnet members get in.
  - Behind it, every visitor reaches autonomOS from this machine: the TCP peer is `127.0.0.1`. The per-device protections (ADR-124 throttle, ADR-135 new-device lock and its known devices) exempt loopback, so every tailnet device would count as "this machine", and the lock that protects a weak token would never engage. ADR-136 therefore marked serve as "not yet".
  - Measured on tailscaled 1.102.3:
    - it always adds `X-Forwarded-For` with the visitor's tailnet IP, tagged nodes included;
    - it adds `Tailscale-User-Login` / `-Name` for user-owned nodes, but not for tagged nodes;
    - it **overwrites** any of these headers the visitor sent;
    - WebSocket upgrades carry them too.
- **Decision:**
  1. **Opt-in mode** `--trust-proxy=tailscale` / `AUTONOMOS_TRUST_PROXY=tailscale`. Off by default, and when off the headers are never read.
  2. **Identity rules when on** (`trustProxy.ts`, `clientIdentity`):
     - **Loopback peer with `X-Forwarded-For`:** the request came through serve. The device is that one address. A header that isn't exactly one valid IP is refused with 400 `BAD_PROXY_HEADER`. `Tailscale-User-Login` (made printable, at most 100 chars) is kept as context only.
     - **Loopback peer without the header:** this machine (the CLI, a local dashboard), trusted exactly as before.
     - **Any other peer:** identified by its TCP address. The headers are never read, so nothing on the network can claim another identity.
  3. **The throttle, the new-device lock and known devices all key off this identity.** The lock's log line names the last address and its Tailscale login, and known devices remember their login.
  4. **Boot refuses** trust-proxy combined with any network bind. The default bind (all interfaces) or a host list with a non-loopback entry would let the LAN reach autonomOS around serve, where a forged `X-Forwarded-For` would be ignored but serve's guarantees wouldn't apply.
  5. **For the weak-token rule (ADR-135 / V2b), trust-proxy counts as a network bind.** A new install behind serve refuses a weak token just as a network bind does.
  6. **The mode is stated in every place the operator looks:**
     - a startup log line;
     - `trustProxy` on `GET /api/auth/lock`;
     - `autonomos token status`, which asks the running server.
  7. **Service installs carry the mode:** `install-service --trust-proxy=tailscale` bakes it (other values are refused), and `install.sh` keeps it when re-rendering.
  8. **Serve becomes the RECOMMENDED remote setup** (README, guide, install output). The ADR-136 host list (`127.0.0.1,<tailnet address>`) remains the no-proxy alternative.
- **Rationale:**
  - **The headers are trustworthy only under two conditions:** the peer is loopback and nothing else reaches the port. The loopback check and the boot refusal enforce exactly those, so a forged header can only come from a program already running on this machine as a trusted local client.
  - **Opt-in,** because a loopback-bound server behind a reverse proxy other than tailscaled could receive visitor-controlled `X-Forwarded-For`. Only the operator knows serve is the proxy in front.
  - **The address is the identity and the login is context:** tagged nodes send no login, and the address is what the lock and known-device list already key on.
- **Alternatives considered:**
  - **Key identity on `Tailscale-User-Login`:** absent for tagged nodes, and shared by every device of one user, so a stolen laptop would inherit "known".
  - **Trust the headers whenever the peer is loopback, with no flag:** unsafe behind any other local proxy, and silent.
  - **Use `tailscale whois` on the peer:** the peer is always 127.0.0.1 behind serve, so there's nothing to look up. Querying the local API per request adds a dependency for what tailscaled already put in the request.
  - **Keep serve unsupported (ADR-136's stance):** leaves the canonical, HTTPS, no-open-port setup without per-device protection.
- **Residual risks:**
  - Any program on this machine can send `X-Forwarded-For` to loopback. It can't gain anything (loopback is already trusted, and a valid token is still required), but it can spend the new-device budget and engage the lock. That's a denial-of-service lever available only to software already running as the operator.
  - Serve sends the login of the person on the visiting device; it doesn't authenticate to autonomOS, which still requires the token.
- **Source:** SecurityFix-Auth@autonomOS session (PR 3 of the remote-access stack, on #480); Terry's decisions relayed by TeamLead@autonomOS on the agent channel; header behavior measured live against tailscaled 1.102.3.
