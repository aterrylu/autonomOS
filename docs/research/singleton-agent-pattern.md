# Singleton Agent Pattern — One Definition, One Running Process

## Question

Should autonomOS enforce that each agent definition can have at most one running session? How do other platforms handle this?

## Framing

This is NOT about persistent memory or identity transcending sessions — CC already handles its own context lifecycle (`/compact`, `/clear`). This is about **preventing duplicate instances** of the same logical agent and having a **config-on-disk** model (like systemd unit files) where you define agents ahead of time and activate/deactivate them.

## Finding: No coding agent platform enforces singleton agents

Every tool in the space uses "spawn and forget":

| Platform | Model | Singleton? |
|----------|-------|------------|
| **Claude Code** (Teams/subagents) | Ephemeral, spawn as many as you want | No |
| **oh-my-claudecode** | Up to 5 tmux workers, no dedup guard | No |
| **Overstory** | Ephemeral workers in git worktrees | No |
| **OpenHands / SWE-agent** | Each agent in its own Docker container | No (isolation, not singleton) |
| **Devin** | Isolated cloud VM per task | No |
| **Cursor / Windsurf / Copilot** | IDE-embedded, not multi-agent | N/A |
| **GitAgent** | Config/runtime separation but no singleton enforcement | No |

### Real bugs from lack of singleton enforcement

- **CC #17457** — Claude Code spawns 3 duplicate warmup agents every few minutes, burning ~60-70k tokens per cycle
- **CC #36800** — Duplicate channel plugin instances spawned mid-session, causing 409 Conflict errors. Reporter: "The duplicate spawn is a harness behavior... any channel plugin with an exclusive external resource would hit the same conflict."

## Infrastructure precedents

The singleton pattern is well-established in process management:

| Tool | Singleton? | Mechanism |
|------|-----------|-----------|
| **systemd** | Yes (default) | Each unit name is unique. `systemctl start foo` on running unit = no-op |
| **supervisord** | Yes (default) | Each `[program:x]` is unique. `numprocs=1` default |
| **launchd** (macOS) | Yes | Each plist label is unique |
| **Docker** | Partial | `container_name` prevents duplicates |
| **K8s Agent Sandbox** | Yes | `Sandbox` CRD = one agent definition → at most one pod. Suspend/resume |
| **PM2** | No | `pm2 start` can create duplicates — singleton was requested (#1265) but never implemented |

### K8s Agent Sandbox (most relevant)

Released March 2026, specifically for AI agents. The `Sandbox` CRD is literally "one agent definition = at most one running pod, with suspend/resume":
- `Sandbox` = agent definition (template, resources, constraints)
- `SandboxClaim` = transactional request to activate
- `SandboxTemplate` = reusable blueprint
- Controller manages exactly one pod per Sandbox
- Suspend = scale pod to 0, preserve PVC. Resume = scale back up

### Microsoft Agent Registry

Formal spec for agent catalogs. Registry stores agent metadata (name, capabilities, endpoint URLs). Two modes: pull (registry probes agents) and push (agents self-register). Includes validation to "prevent duplication." But it's a catalog, not a process manager — doesn't enforce singleton.

### ROS2

Does NOT enforce node name uniqueness — this is a known gap (design issue #187, still open). Many features implicitly rely on unique names but enforcement was never implemented. Users report unexpected duplication as a recurring pain point.

## Why the industry uses ephemeral agents

- Simplicity — spawn, use, discard. No state to manage
- Agents are cheap to create
- CC handles its own context lifecycle (`/compact`, `/clear`)
- No singleton coordination complexity
- Failure recovery is trivial — just start a new one

## Why singleton might still be right for autonomOS

- autonomOS is a **control plane**, not a harness. Like systemd, it needs to know what *should* be running
- The industry is young — duplicate agent bugs are already appearing (CC #17457, #36800)
- Singleton doesn't prevent ephemeral use — unregistered agents can still be spawned freely
- The config-on-disk model is just process management, not over-engineering
- Risk is proportional to complexity: simple "don't start if already running" check = low risk

## Assessment

The singleton pattern is validated by decades of infrastructure (systemd, supervisord, launchd) and now explicitly adopted for AI agents by Kubernetes Agent Sandbox. No coding agent platform does it yet, but the bugs proving the need are already appearing.

The key is keeping it simple: agent config on disk + "refuse to start if already running" + activate/deactivate toggle. Not a reconciliation loop, not a desired-state controller. A systemd unit file, not Kubernetes.

## Sources

- [Claude Code Issue #17457 — duplicate warmup agents](https://github.com/anthropics/claude-code/issues/17457)
- [Claude Code Issue #36800 — duplicate channel plugins](https://github.com/anthropics/claude-code/issues/36800)
- [K8s Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [K8s Agent Sandbox blog](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/)
- [Microsoft Agent Registry spec](https://microsoft.github.io/multi-agent-reference-architecture/docs/agent-registry/Agent-Registry.html)
- [GitAgent](https://github.com/open-gitagent/gitagent)
- [PM2 singleton issue #1265](https://github.com/Unitech/PM2/issues/1265)
- [ROS2 node uniqueness issue #187](https://github.com/ros2/design/issues/187)
- [systemd template singleton issue #14391](https://github.com/systemd/systemd/issues/14391)
