# Zo Computer

**Type:** Competitive reference / potential integration target -- personal AI cloud server platform
**URL:** [zo.computer](https://zo.computer) | [GitHub org](https://github.com/zocomputer) (mostly closed-source)
**Version studied:** v1.2.1 (latest release as of 2026-03-05)
**Researched:** 2026-03-05

## What It Is

Zo Computer is a **personal cloud server powered by AI** -- a "reimagined personal computer for the cloud era." Each user gets a dedicated Linux server (containerized) with AI agent capabilities, file storage, web hosting, and 50+ built-in tools. Users interact via web UI, desktop app, SMS, or email. The AI agent can schedule tasks, build websites, manage files, run shell commands, and integrate with third-party services (Gmail, Notion, Linear, Airtable, etc.).

Zo evolved from **Substrate**, an agentic inference platform for developers (2023-2024) that optimized multi-step AI workloads as DAGs. The founders pivoted from developer-focused inference to consumer-facing "AI computer" in 2024-2025, keeping the infrastructure expertise but broadening the audience to "the next billion developers."

**Team:** Co-founded by Rob Cheung (founding engineer at Substack) and Ben Guo (8 years at Stripe), who met on the early Venmo team in 2013. Small team based in Brooklyn, NY. Backed by Lightspeed, South Park Commons, Craft Ventures, Guillermo Rauch (Vercel), and Immad Akhund (Mercury).

**Core thesis:** Every person should own their own AI-powered server. Rather than SaaS apps, you get a persistent Linux machine with AI that builds, hosts, and automates on your behalf.

## Why We Care

Zo occupies a different layer than autonomOS but has interesting overlaps. It's not an agent *observability* platform -- it IS an agent platform. Where autonomOS observes/orchestrates existing agent sessions (Claude Code, Codex, etc.), Zo provides the entire compute environment where agents run. The MCP server capability is the key integration surface.

| Need | Zo Provides | Gap |
|------|------------|-----|
| Session observability | Agent conversations viewable in UI | No cross-session analytics, no cost breakdown per session |
| Session control | Full control via chat UI, SMS, API | No multi-agent orchestration view |
| Agent scheduling | Built-in cron-like agent scheduler | Simple time-based only, no workflow DAGs |
| Multi-provider | Claude Code, Codex, BYOK (OpenAI, Anthropic, etc.) | Provider is opaque -- no provider-level metrics |
| MCP server | Exposes 50+ tools via MCP endpoint | One-directional: Zo as MCP server, not consumer |
| Hosting | Full Linux server with web hosting, custom domains | Not relevant to autonomOS's mission |
| Skills system | 60+ skills in open registry, community contributions | Skills are prompt-based, not code plugins |
| File/storage | 100GB per user, desktop sync | Not relevant to autonomOS |
| Cost tracking | AI credit usage visible | No per-model breakdown, no time-series |
| API | REST API with streaming (SSE), 50+ endpoints | Well-documented, could integrate |
| Open source | Skills registry and some utilities (MIT) | Core platform is closed-source |

## Investigation Checklist

- [x] Product overview -- personal AI cloud server with 50+ tools
- [x] Company background -- ex-Venmo/Substack/Stripe founders, Substrate pivot
- [x] Funding -- Lightspeed, South Park Commons, Craft Ventures, angels
- [x] Architecture -- containerized Linux servers, snapshot/restore, dynamic scaling
- [x] AI model support -- multi-model (language, image, video, transcription), BYOK
- [x] Agent system -- scheduled agents with cron-like triggers, background execution
- [x] Skills system -- open registry, SKILL.md format, 60+ skills, community contributions
- [x] MCP server -- exposes tools via `https://api.zo.computer/mcp` with Bearer auth
- [x] Claude Code integration -- runs Claude Code on Zo server, provider toggle
- [x] API surface -- REST API, SSE streaming, 50+ endpoints across 10 domains
- [x] GitHub presence -- 32 repos, mostly utilities; core platform is closed-source
- [x] Pricing -- Free ($0), Basic ($18/mo), Pro ($64/mo), Ultra ($200/mo)
- [x] Licensing -- Skills registry is MIT; core platform is proprietary/closed-source

## Deep Dives

- **[architecture.md](architecture.md)** -- Infrastructure, tech stack, agent model, MCP integration
- **[autonomos-integration.md](autonomos-integration.md)** -- What to learn, what to use, integration strategy
- **[licensing.md](licensing.md)** -- Open-source components vs proprietary core

## Key Numbers

| Metric | Value |
|--------|-------|
| GitHub repos (org) | 32 (mostly utilities, not core platform) |
| Skills registry | 60+ skills (MIT licensed) |
| Main repo stars | 15 |
| API endpoints | 50+ across 10 domains |
| Built-in tools | 50+ (file, shell, web, integrations, media) |
| AI providers | Multi-model + BYOK (OpenAI, Anthropic, Cerebras, Groq, etc.) |
| Pricing tiers | 4 (Free/Basic/Pro/Ultra: $0-$200/mo) |
| Server specs (Pro) | 16 cores, 128GB RAM, 100GB+ storage |
| Integrations | Gmail, Calendar, Notion, Linear, Airtable, Dropbox, Spotify, Telegram |
| Core platform license | Proprietary (closed-source) |
| Skills registry license | MIT |
| Desktop platforms | macOS, Windows, Linux |
| Releases | 19 (as of Mar 2026) |

## Assessment for autonomOS

**Relevance: MEDIUM** -- Zo is not directly comparable to autonomOS. It's a *platform where agents run*, not a *control plane for observing agents*. However, two aspects are genuinely valuable:

1. **MCP server as integration point.** Zo exposes 50+ tools via MCP. autonomOS could connect to a user's Zo server as an MCP client, effectively gaining access to all of Zo's tools (file management, web browsing, integrations, hosting) without reimplementing them. This is the most concrete integration opportunity.

2. **Skills registry as a pattern.** The open `SKILL.md` format for packaging agent capabilities is a clean, portable pattern. autonomOS could adopt a similar approach for configuring agent behaviors -- skills as markdown-defined capability bundles rather than code plugins.

**Key insight:** Zo and autonomOS solve different problems at different layers. Zo is the "computer" (infrastructure + runtime); autonomOS is the "mission control" (observability + orchestration). They could be complementary -- autonomOS could orchestrate agents that run on Zo's infrastructure.

**Critical limitation:** Zo's core platform is closed-source and proprietary. There's no way to run it locally or self-host. Integration is limited to their API and MCP endpoint. This makes Zo a *service dependency*, not a *reference implementation* we can study deeply.

**Comparison with other research subjects:**

| Capability | Mission Control | CC-Insights | YepAnywhere | Zo Computer | autonomOS Needs |
|-----------|----------------|-------------|-------------|-------------|-----------------|
| Session discovery | Scans JSONL | Spawns subprocess | FileWatcher + scanner | N/A (is the platform) | Both scan + spawn |
| Session control | Read-only | Full bidirectional | Full bidirectional | Chat/SMS/API | Bidirectional + orchestration |
| Multi-agent | Via OpenClaw | Subagent events | Independent sessions | Independent agents | Coordinated teams |
| Agent scheduling | None | None | None | Built-in cron | Workflow-based scheduling |
| MCP support | None | None | None | Server (50+ tools) | Client + server |
| Hosting | None | None | None | Full Linux hosting | Not needed |
| Skills/plugins | None | None | None | 60+ skill registry | Plugin SDK |
| Open source | MIT | GPLv3 | MIT | Proprietary | MIT preferred |
| Tech stack | Next.js | Flutter/Dart | Hono/React/TS | Unknown (closed) | Web (Next.js/Svelte) |
