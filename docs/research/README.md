# Research

Study of integration targets, competitors, and open-source projects we're modeling off of.

Each subfolder is a project. Drop findings, notes, architecture breakdowns, and assessments there.

## Projects

### Integration Targets
- **[openclaw/](openclaw/)** — Our current agent runtime. Understand internals to build on top of it.
- **[dimensionalOS/](dimensionalOS/)** — Robot nav-stack + agent platform. Inspiration for the robot path. Also has OpenClaw integration.

### Evaluations
- **[agent-memory/](agent-memory/)** — Should autonomOS add an agent memory system? Landscape + hands-on spikes + phased recommendation (2026-09).

### Competition / Reference
- **[mission-control/](mission-control/)** — builderz-lab/mission-control. Similar concept — study their approach.

## How to Add Research

1. Create a folder: `docs/research/<project-name>/`
2. Add a `README.md` with overview, links, and your assessment
3. Add deep-dive notes as separate files (e.g., `architecture.md`, `api.md`)
4. Update the project list above
