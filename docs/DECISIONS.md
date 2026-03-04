# Architectural Decision Records

Append-only log of project decisions. Newest at bottom.
Each entry includes context, rationale, alternatives considered, and source.

---

## ADR-001: Monorepo Structure
**Date:** 2026-03-03
**Decided by:** Terry + Nox
**Source:** Discord #🧭the-bridge (Mission Control category)

**Context:** Need a repo structure that supports two divergent paths (dev tooling + robotics) while sharing core abstractions.
**Decision:** Monorepo with `packages/` directory. `packages/dashboard/` for web UI, `packages/core/` for shared types and abstractions. Additional packages added as needed.
**Rationale:** Single repo keeps everything discoverable. Packages can diverge (robot-specific vs dev-specific) while sharing core types. Same pattern used successfully in the aquarium project.
**Alternatives:** Separate repos per path (too fragmented early on), single flat project (doesn't scale).

---

## ADR-002: Start with Observability, Add Control Later
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Dashboard could try to do everything at once — observe, configure, and control agents.
**Decision:** Phase 1 is read-only observability. Phase 2 adds control/configuration.
**Rationale:** Observability is safer (no destructive actions), teaches us what data matters, and is useful immediately. Control requires deeper integration and more careful design.
**Alternatives:** Build control first (risky without understanding the data), build both simultaneously (too much scope).

---

## ADR-003: Build on OpenClaw, Diverge If Needed
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Could build a custom agent runtime from scratch or extend an existing one.
**Decision:** Use OpenClaw as the agent runtime for now. autonomOS sits above it as a control plane. May fork/diverge later if OpenClaw's architecture doesn't fit.
**Rationale:** OpenClaw already handles agent config, cron jobs, memory, multi-channel routing. No need to rebuild that. Focus energy on the control plane layer that's missing.
**Alternatives:** Build custom runtime from day one (premature), fork OpenClaw immediately (unnecessary complexity).

---

## ADR-004: Name — autonomOS
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Needed a name that reflects agent-first, autonomous operation, and works for both dev and robotics paths.
**Decision:** `autonomOS` — autonomous + OS. Capitalization emphasizes "OS" (operating system for agents).
**Rationale:** Directly communicates the concept. Works as a CLI name, repo name, and brand. GitHub org `Autonomos` is taken (case-insensitive) but `aterrylu/autonomOS` as a repo is available.
**Alternatives:** mission-control (plain), cortex (taken in many contexts), conductor (too narrow — implies only orchestration), fleet (too robot-specific).
