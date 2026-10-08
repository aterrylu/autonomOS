## ADR-153: tailscale serve over an owner-only unix socket

- **Date:** 2026-10-08
- **Decided by:** TeamLead@autonomOS approved the structural fix ("the identity headers are read ONLY on the owner-only socket; loopback TCP goes back to never read headers") and the five-point design, adding that the 400 must name the exact command and that plain loopback browsing must be pinned unaffected. It also made this a v0.8.0 release blocker, so #488's TCP form never ships. SecurityAudit-Claude found the residual (#488). SecurityFix-Auth@autonomOS measured the platforms, then designed and implemented this.
- **Supersedes:** ADR-140 (part: trusting X-Forwarded-For / Tailscale-User-Login from any loopback TCP peer)
- **Context:**
  - ADR-140 trusted Tailscale's identity headers on any request from a loopback TCP peer, because `tailscale serve` connects from 127.0.0.1.
  - A TCP peer carries no uid, so any program of any user on the machine could send those headers. On a multi-user host another account could pick its apparent tailnet address and spend the global new-device budget, which locks out the operator's new devices. ADR-140 recorded that as a residual and named the fix: `tailscale serve` can proxy to a unix socket.
  - Measured on 2026-10-08 (Tailscale 1.102.3, macOS App Store build, from a second tailnet node):
    - the App Store build's proxy runs in the sandboxed IPNExtension as the operator, not as root;
    - a socket in `/tmp` gave **502**;
    - a socket inside its app-group container (`~/Library/Group Containers/<team>.group.io.tailscale.ipn.macos`, a 0700 folder the operator owns) gave **200**, with X-Forwarded-For passed through;
    - a quoted path with a space (`"unix:…/Group Containers/…"`) is accepted.
    - On Linux and standalone macOS, tailscaled runs as root and can reach any path.
- **Decision:**
  1. **With `--trust-proxy=tailscale`, autonomOS also listens on a unix socket**, chmod 0600, and **identity headers are trusted only on requests that arrive there.** Connections are marked when accepted, before any request is parsed, so a request can't claim the mark. On the socket, X-Forwarded-For must be exactly one valid IP, else 400 `BAD_PROXY_HEADER`. The login stays context only.
  2. **Loopback TCP is "this machine", and its headers are never trusted.** A loopback TCP request that **carries** X-Forwarded-For or Tailscale-User-Login means `tailscale serve` still points at the port. It is **refused with 400 `SERVE_NOT_ON_SOCKET`**, and the message contains this install's exact `tailscale serve --bg unix:<path>` command. Treating it as local would make every tailnet visitor this machine and silently disable the lock: fail closed. A local forger only gets itself a 400. Plain local browsing, with no identity headers, is unaffected.
  3. **The default path depends on the platform:**
     - macOS with the App Store Tailscale (its app-group folder exists): that folder, `aos-<port>.sock`, one file per port;
     - otherwise: `<config dir>/serve.sock`;
     - `--serve-socket=<path>` / `AUTONOMOS_SERVE_SOCKET` overrides either.
     - A path over the OS limit (about 103 bytes) is refused, naming the override.
     - A stale socket file is removed; a live one, or a non-socket at the path, is never taken over.
  4. **The exact command is printed wherever the operator looks**: the startup log, `serveCommand` on `GET /api/auth/lock`, `autonomos token status`, and the 400. It's quoted when the path has spaces, so it pastes into a shell as-is.
  5. **If the socket can't be opened, that's loud and fails closed.** TCP serve is still refused, so nothing is silently weakened.
  6. **Installs:** `install-service` bakes an explicit `--serve-socket` (refusing a path with whitespace, which a service file can't carry; the default needs no flag), and `install.sh` keeps it on update.
  7. **Unchanged from ADR-140:** trust-proxy is opt-in; boot refuses it with a network bind; for the weak-token rule it counts as a network bind; the new-device lock and throttle key off the visitor's tailnet address.
- **Rationale:**
  - **The socket's permission is the uid check a TCP peer can't provide.** Only the owner and root (tailscaled), or the operator's own sandboxed Tailscale extension, can connect.
  - **Failing closed on TCP keeps a stale `serve --bg <port>` setup from silently disabling the lock.** The refusal names the fix, so the cost is one command.
  - **The App Store path comes from measurement, not assumption**: `/tmp` was refused and the group container worked.
  - **#488's TCP form never shipped** (this lands before v0.8.0), so no deployed setup breaks. The only box running trust-proxy had no serve config.
- **Alternatives considered:**
  - **Keep TCP header trust and document the residual**: leaves a forge open to any local user, and the measurement showed the socket works on every platform we ship.
  - **Treat TCP-with-headers as plain local**: silently turns every serve visitor into a trusted local device, the worst failure mode.
  - **Check the TCP peer's uid (e.g. via `lsof` or `/proc/net/tcp`)**: platform-specific, racy, and slow on every request. The socket does the same job in the kernel.
  - **A socket in `/tmp` on macOS**: measured 502 under the App Store sandbox.
- **Source:** SecurityFix-Auth@autonomOS session; TeamLead@autonomOS approval on the agent channel; SecurityAudit-Claude's #488 residual; live probe against tailscaled 1.102.3 (App Store) with a second tailnet node, serve config restored to "No serve config" afterwards.
