# Agent Hierarchy UI — Visualization Research

Research from 2026-03-28. Covers pixel office projects, observability dashboards,
and React library recommendations for visualizing agent hierarchies.

---

## Pixel Art / Virtual Office Projects

A booming trend with 7+ active open-source projects:

### claude-office (paulrobello) — Most Sophisticated
- Next.js + PixiJS + FastAPI + Zustand
- Boss agent (orchestrator) at top; subagents at desks
- **11 whiteboard modes**: org chart, video-call grid, tool usage pie chart, timeline
- Visual state: thought bubbles, speech bubbles, working/delegating/waiting
- [GitHub](https://github.com/paulrobello/claude-office)

### claw-empire (GreenSheep01201) — Closest to autonomOS Vision
- "Command Your AI Agent Empire from the CEO Desk"
- Departments: Planning, Development, Design, QA/QC, DevSecOps, Operations
- 600+ categorized skills with role/department/provider selection
- CEO directives via `$` prefix commands
- Telegram/Discord integration
- [GitHub](https://github.com/GreenSheep01201/claw-empire)

### agent-office (harishkotra)
- Phaser canvas + React overlay for panels
- Agents walk to desks, hold meetings, hire new members dynamically
- Thought bubbles showing current tool/action
- Key insight: **Phaser for spatial canvas, React for control panels**
- [GitHub](https://github.com/harishkotra/agent-office)

### pixel-claw (monkeystar0)
- Built for OpenClaw — pixel art office, retro game UI
- [GitHub](https://github.com/monkeystar0/pixel-claw)

### pixel-agents (pablodelucca)
- VS Code extension — terminal agents as pixel sprites
- [GitHub](https://github.com/pablodelucca/pixel-agents)

[Fast Company coverage](https://www.fastcompany.com/91497413/this-charming-pixel-art-game-solves-one-of-ai-codings-most-annoying-ux-problems)

---

## Observability Tool Approaches

### Langfuse Agent Graphs
- Visual flow graph inferred from observation timings
- Toggle between tree view and timeline view
- Color-coded observation types
- [Docs](https://langfuse.com/docs/observability/features/agent-graphs)

### AgentOps (CrewAI)
- Hierarchical span tree: session → agent → LLM calls → tool calls
- Session replay with step-by-step execution graph
- [GitHub](https://github.com/AgentOps-AI/agentops)

### Devin's Agents Tab
- Auto-appears when child sessions exist (progressive disclosure)
- Shows child agent status, todos, PRs

### Azure Managed Grafana
- Interactive node graph showing workflow structure
- Click-through from summary to per-agent detail

---

## React Library Recommendations

### Primary: React Flow (xyflow) — 24k stars
- Custom node types = React components (embed status icons, tool names, message bubbles)
- Animated edges for message flow visualization
- Zustand-based state management (matches autonomOS perfectly)
- Auto-layout with Dagre/ELK for org chart positioning
- MiniMap, Controls, Background plugins built in
- `npm install @xyflow/react`
- [reactflow.dev](https://reactflow.dev)

### Secondary: d3-org-chart — 140k monthly npm downloads
- Custom HTML per node → embed status badges
- Real-time update: `.data(newData).render()`
- [GitHub](https://github.com/bumbeishvili/org-chart)

### Spatial: PixiJS + React overlay
- Used by claude-office and agent-office
- PIXI handles canvas (sprites, animations)
- React handles UI panels layered on top
- Best for pixel-art office route

### Honorable mention: Cytoscape.js
- Breadthfirst layout for decision trees
- Handles cyclic graphs

---

## UX Patterns Worth Borrowing

**From pixel office projects:**
- Thought/speech bubbles showing current tool or action
- Desk metaphor — each agent has a "station" that pulses when active
- Spatial proximity = team relationship

**From observability tools:**
- Tree + timeline toggle (Langfuse)
- Parent span wraps child spans visually
- Click node → zoom to agent detail panel

**From Devin:**
- Hierarchy auto-activates only when child sessions exist — progressive disclosure

**From claw-empire:**
- Department grouping as swim lanes or colored sections
- Role/specialization as subtitle on each card

---

## Implementation Path for autonomOS

### Phase 1: Hierarchy Toggle in Sidebar
- Tree view using existing groups data + AgentStatusIcon
- Show team lead at top, workers below
- Lowest effort, immediate value

### Phase 2: React Flow Canvas Panel
- New panel type alongside terminal/preview
- Custom nodes: status icon, name, current tool, message snippets
- Animated edges for message flow
- Auto-layout with Dagre
- Click node → opens terminal in split view

### Phase 3: Spatial/Pixel Layer (Aspirational)
- PixiJS canvas underneath React UI
- Agents as sprites at desks
- Thought bubbles with current tool name
- React panels float above for control

### Missing Data for Hierarchy
- `parentSessionId?: string` on `ManagedSession` — tracks who spawned who
- When `create_agent` spawns a worker, record the parent
- Hierarchy view renders from that relationship

---

## Multi-Agent Orchestration Landscape Comparison

| Framework | Persistent | Team Lead Authority | Cross-Machine | Web UI |
|-----------|-----------|-------------------|--------------|--------|
| OpenClaw | Yes | Yes (depth-locked tools) | No | No |
| CC Agent Teams | No (crash = lost) | Yes (spawn + tasks) | No | No |
| CrewAI | No (ephemeral) | Sort of (unreliable) | No | No |
| Overstory | Yes (tmux) | Yes (3 layers) | No | No (TUI) |
| ccswarm | Yes (pool) | Yes (master layer) | No | No |
| **autonomOS** | **Yes** | **Yes (MCP tools)** | **Yes (forge)** | **Yes (React)** |

autonomOS is the only tool that combines persistent agents + cross-machine reach + web dashboard + inter-agent messaging. The hierarchy visualization is the next piece that makes this tangible.
