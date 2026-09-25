## ADR-023: VLA Runtime — Punted to Roadmap
**Date:** 2026-03-19
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** autonomOS has an aspirational "Robot Path" for persistent physical agents (home automation, robotics). This requires a fundamentally different runtime from the Claude Agent SDK: VLA (Vision-Language-Action) models run at 10–50Hz, output continuous motor commands, and require in-model temporal state (recurrent architectures or sliding frame windows) rather than software-managed context windows. The `AgentRuntime` abstraction (ADR-019) was designed to make this swap possible.

**Decision:** Punt VLA runtime to roadmap. The `AgentRuntime` interface is the seam — a `VLARuntime` implementation would replace `query()` with a high-frequency sensorimotor loop and a VLA-capable model (RT-2, π0, or equivalent). No work on this until the Dev Path agent platform is working end-to-end.

**Key architectural difference documented:**
- Text LLM agents: discrete episodic (cron ticks, context window as memory, software-managed history)
- VLA agents: continuous real-time (10–50Hz, in-model recurrent state, physical grounding)
- Visual memory for VLA: CLIP embeddings in vector DB (LanceDB) — no well-known OpenClaw-equivalent exists yet for visual-memory agent orchestration

**Rationale:**
- Robot path is aspirational. Dev path is the immediate priority.
- The `AgentRuntime` abstraction already provides the architectural seam — no premature VLA work needed now.
- VLA frameworks (RT-2, π0, OpenVLA) are rapidly evolving. Better to wait for the ecosystem to stabilize.

**Alternatives:**
- **Build VLA runtime now** — premature. No hardware to test against, no immediate use case.
- **Ignore robot path entirely** — the `AgentRuntime` abstraction costs nothing to keep and preserves the option.
