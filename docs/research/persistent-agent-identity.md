# Persistent Agent Identity — 1:1 Agent:Process Model

## Question

Should autonomOS eliminate the concept of "sessions" entirely and treat every managed process as a persistent named agent with a 1:1 agent-to-process mapping?

## Finding: No coding-agent platform does this

Surveyed the landscape as of March 2026. No AI coding agent platform implements a 1:1 persistent agent model where agents survive process restarts with continuous identity.

### What exists

| Platform | Model | Notes |
|----------|-------|-------|
| **oh-my-claudecode** | Ephemeral sessions | ralph-loop keeps one session running, but no persistent identity |
| **EverythingClaudeCode** | Ephemeral subagents | 36 agents are CC's Agent tool (subprocesses), NOT persistent. Memory persists via "Instinct" files |
| **Overstory** | Ephemeral orchestration | 4-layer hierarchy (Coordinator/Lead/Builder/Scout), SQLite WAL mail, agents spawn per-task |
| **OpenClaw** | Session-based | Open issue #19780 requesting persistent agents, not implemented |
| **CC Mirror/gstack/Ruflo** | Ephemeral | Session multiplexers, no identity persistence |

### Closest analogs (outside coding agents)

| System | Model | Relevance |
|--------|-------|-----------|
| **K8s Agent Sandbox** | Pod = agent, survives restarts | Infrastructure-level 1:1 mapping |
| **Letta/MemGPT** | Stateful agents with persistent memory | LLM framework, "stateful agents are the missing link" |
| **ROS2 nodes** | Named processes with lifecycle management | Robotics — closest architectural match |
| **Digital twins (IoT)** | Virtual entity = physical device, always exists | IoT — same conceptual model |
| **SoulSpec** | "Sessions end but identity shouldn't" | Specification for persistent agent identity |

### Arguments FOR persistent identity

- **Letta team**: "Stateless API calls are the biggest limitation holding back AI agents"
- **SoulSpec**: Identity should transcend individual conversations
- **PermaMind**: Persistent context prevents the "Groundhog Day" problem
- **LangChain forum**: Enterprise users want agents that remember project context across sessions

### Arguments AGAINST persistent identity

- **Security researchers**: Persistent agents accumulate attack surface
- **Anthropic** (own research): Long-running agents suffer compounding errors — "fresh start" is a feature
- **"Is Forgetting a Feature?"**: Memory corruption over time, stale context worse than no context

## Assessment

autonomOS's 1:1 model is validated by infrastructure (K8s), robotics (ROS2), and agent research (Letta, SoulSpec), but novel in the coding-agent space. The key insight: **persistent identity ≠ persistent context**. The agent remembers who it is and what it's responsible for, but each activation gets fresh code context.

## Relevance to autonomOS: HIGH

Validates the design:
- Eliminate "sessions" from the mental model — everything is an agent
- `~/.autonomos/agents/{slug}/agent.json` = persistent identity
- CC session = activation of an agent (ephemeral runtime, persistent identity)
- Agent can be `active` (running) or `inactive` (defined but not running)
