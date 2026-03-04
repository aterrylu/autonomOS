# Vision

## What is autonomOS?

A **mission control platform for autonomous agents**. Not an agent runtime itself — a **control plane** that sits above agent runtimes (OpenClaw, Claude Code, future custom ones) and provides unified observability, configuration, and orchestration.

Think of it like Kubernetes for agents — K8s doesn't care what's in the container, it just orchestrates. autonomOS doesn't care if the agent is coding or driving a robot — it just orchestrates.

## The Problem

**Claude Code** is amazing for single-session coding but has no memory, no automation, no orchestration across sessions.

**OpenClaw** has orchestration (cron jobs, memory, multi-channel routing) but isn't deeply integrated into the dev workflow — there's no dashboard, no unified view of what's happening.

**The gap:** There's no persistent, orchestrated control plane that lets you see, configure, and manage all your agents from one place — whether they're coding agents on your laptop or autonomous agents on a robot.

## Two Paths

### 💻 Dev Path (Starting Here)
Interface with existing agent tools as mission control:
- Dashboard to observe agent activity, token spend, task status, memory state
- Configure and control OpenClaw, Claude Code sessions from one place
- Eventually: start agents, edit cron jobs, manage memory from the UI

### 🤖 Robot Path (Aspirational)
A persistent agent platform for robotics:
- Agents that interface with joint control, sensor inputs as topics (inspired by dimensionalOS)
- Always-running agents on physical hardware
- Same control plane patterns as the dev path, different substrate

Both paths share the same core need: **persistent agents, orchestration, and observability.**

## Principles

- **Observe first, control later** — start read-only, earn trust before adding writes
- **Don't reinvent** — build on OpenClaw for now, diverge only when the architecture doesn't fit
- **Personal tool first** — ship for one user (Terry), generalize later
- **Agent-agnostic** — shouldn't be locked to one agent type or runtime
- **Both paths share core** — abstractions should work for dev agents AND robots

## Target Users

- Developers who use multiple AI coding agents and want a unified control plane
- Robotics hobbyists who want persistent agents on their robots
- Power users of tools like OpenClaw/Claude Code who want observability and orchestration

## Starting Point

Phase 1 is a **dashboard** connected to OpenClaw — read agent status, sessions, cron jobs, memory state. Pure observability. No control yet.

The repo also serves as a learning hub — research on competing platforms, agent orchestration patterns, and robotics middleware feeds into the architecture decisions.

## Open Questions

- What are the core abstractions? (What is an "agent" in autonomOS?)
- Tech stack for the dashboard?
- How deep should OpenClaw integration go before we consider diverging?
- How do the dev path and robot path share code without over-abstracting?
- What does the robot agent interface look like? (topics, sensors, actuators)
