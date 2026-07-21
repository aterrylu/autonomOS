# Contributing to autonomOS

Thanks for your interest! autonomOS is a personal-tool-first project, but issues and PRs are welcome.

## Getting started

```bash
git clone https://github.com/aterrylu/autonomOS && cd autonomOS
cp -n .env.example .env   # optional config
bun install

make dev                  # API on :3101 + Vite HMR on :5173
```

You'll need **Node 20+** and the `claude` binary on your PATH (autonomOS spawns agent CLIs; Codex and Gemini are optional).

## Development workflow

| Command | What it does |
|---------|--------------|
| `make dev` | API server (watch) + Vite HMR — the day-to-day dev loop |
| `make check` | Lint (Biome) + typecheck (tsc) + server, CLI & dashboard tests — **run before every push** |
| `make fmt` | Auto-fix lint + formatting |
| `make hero` | Regenerate the README hero screenshot (see below) |

Run `make check` before you push — it mirrors CI exactly, so if it passes locally the PR's `check` job will too.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint):

```
feat:     new features
fix:      bug fixes
perf:     performance improvements
refactor: structural changes
docs:     documentation
research: research findings
```

Keep the subject imperative and concise; `commitlint` will flag anything malformed on commit.

## Pull requests

1. Branch off `main`, make your change, and open a PR against `main`.
2. **CI must pass** (lint, typecheck, tests across macOS + Linux) — never bypass with `--admin`.
3. **Resolve all review conversations** before merge (it's enforced on `main`).
4. PRs are **squash-merged** — your branch's commit history collapses to one commit, so don't worry about tidy intermediate commits.

## A few project conventions

- **Architectural decisions go in [`docs/DECISIONS.md`](docs/DECISIONS.md)** — append-only ADRs with context + rationale. If your change makes a non-obvious design choice, record it there.
- **Changing the dashboard UI? Re-run `make hero`.** The README hero (`docs/assets/hero.png`) is *generated*, not hand-captured — it must reflect the real product. Any visible change (layout, sidebar, org chart, status bar, themes, provider icons, usage bars) means re-shooting it and committing the updated PNG. See [`packages/dashboard/scripts/capture-hero.ts`](packages/dashboard/scripts/capture-hero.ts).
- **MCP tool schemas live in `packages/server/src/mcp/tools.ts`** — the single source of truth shared by both MCP transports. Don't define them elsewhere.
- **Terminology:** the UI says "agents"; the code says "sessions." Both mean the same managed PTY process.

See [`CLAUDE.md`](CLAUDE.md) for the full agent/developer guide and [`docs/`](docs/) for features, decisions, and vision.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
