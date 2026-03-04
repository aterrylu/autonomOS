# autonomOS

A mission control platform for autonomous agents — observe, configure, and orchestrate agents across development tools and robotics.

## What is this?

autonomOS is a control plane that sits above agent runtimes (like [OpenClaw](https://github.com/openclaw/openclaw), Claude Code, and others) to provide:

- **Observability** — see what your agents are doing, token spend, task status, memory state
- **Configuration** — set up agents, workflows, schedules, and automation from one place
- **Orchestration** — coordinate multiple agents working together
- **Persistence** — agents that remember, learn, and run continuously

## Two Paths

### 💻 Dev Path
Interface with your existing agent tools (OpenClaw, Claude Code, etc.) as mission control — a unified dashboard for configuring, controlling, and observing all your agents.

### 🤖 Robot Path
A persistent agent platform for robotics — agents that interface with joint control, sensor inputs, and run continuously on robots. Inspired by platforms like dimensionalOS.

Both paths share the same core: persistent agents, orchestration, and observability.

## Status

🚧 Early exploration — architecture and research phase.

## Structure

```
packages/
  dashboard/    # Web UI — observability & control
  core/         # Shared agent abstractions
```

## License

TBD
