## ADR-017: Simplified Deployment — Dev/Prod Split, No Tailscale Sidecar
**Date:** 2026-03-13
**Decided by:** Terry
**Source:** Claude Code session (Makefile simplification, PR #28)

**Context:** The Makefile had a single `make up MODE=dev|prod` command with embedded Docker Compose for a Tailscale sidecar container. This was complex, required Docker, and all development devices were already on the Tailscale network anyway. The prod instance on forge was also the development target, causing port conflicts.

**Decision:** Split into `make dev` (port 3101 + Vite HMR on 5173) and `make prod` (port 3100, built dashboard). Remove Docker Compose and Tailscale sidecar entirely. `DEPLOY_HOST` is configurable via `.env` (gitignored, per-machine).

**Key changes:**
- `make dev` — server on `:3101`, Vite dev server on `:5173` with proxy to `:3101`
- `make prod` — builds dashboard, serves everything on `:3100`
- `make deploy` — rsync to remote host, `DEPLOY_HOST` read from `.env`
- Deleted `deploy/` directory (docker-compose.yml, serve.json)
- No more Docker dependency for development or deployment

**Rationale:**
- All devices are on Tailscale — the sidecar was unnecessary complexity
- Separate ports (3100 prod, 3101 dev) allow running both simultaneously on the same machine
- `.env` for per-machine config is a well-understood pattern (already gitignored)
- Direct process management (`make prod`) is simpler than Docker for a single-binary server

**Alternatives:**
- **Keep Docker Compose** — Useful if deploying to machines without Tailscale, but adds Docker dependency for no current benefit.
- **Single port with mode flag** — What we had. But can't run dev and prod simultaneously.
- **Systemd service** — More robust for production, but premature for a personal tool. Can be added later.
