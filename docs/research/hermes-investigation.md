# Hermes Agent investigation — and daemon-style agent support in autonomOS

> **Date:** 2026-04-19
> **Author:** Claude (feature-worker), at Terry's direction
> **Status:** Research — no code changes
> **Scope:** Primary: Nous Research's **Hermes Agent**. Secondary: revisiting **OpenClaw** in light of current state, and the architectural question of how autonomOS could support daemon-style agents generally.

## TL;DR

- **"Hermes agent" disambiguated** → **Nous Research's Hermes Agent** (`github.com/NousResearch/hermes-agent`) — launched Feb 25, 2026; ~95K GitHub stars in ~7 weeks; v0.10 (git tag `v2026.4.16`, "Tool Gateway" release) released 2026-04-16. Not to be confused with the **Hermes 4/4.3** *model* series (separate product).
- **Runtime model** → **daemon-style**, closer to OpenClaw than Claude Code. The CLI (`hermes`), gateway daemon (`hermes gateway`), and ACP JSON-RPC mode (`hermes acp`) are three parallel entry points over a shared `AIAgent` core. The CLI is **not** a thin client over the daemon; they share only SQLite state + skills/memory on disk. See §3.
- **Fit with current autonomOS** → **poor**. Our `AgentProvider` interface (`packages/server/src/providers/index.ts`) is tightly coupled to the CLI-spawn-via-PTY model. Hermes and OpenClaw do not satisfy its shape. See §6.
- **Recommendation** → **pursue-conditional.** *(a)* Close the loop on the existing 3 CLI providers first. *(b)* If we want daemon-style support at all, introduce a **second abstraction** (`SessionProvider` or similar) in `packages/core/` rather than bending `AgentProvider`. *(c)* Of the two daemon-style candidates, **Hermes's ACP stdio mode is the cheapest bridge** — it gives us structured JSON-RPC events over stdin/stdout, similar enough to our PTY+hooks mental model to slot in without a full architectural rewrite. See §7–§9.
- **Effort** → XS to prototype ACP stdio adapter for Hermes (~1–2 days, read-only session surfacing). M–L to build a proper daemon `SessionProvider` abstraction that covers both Hermes gateway and OpenClaw (~1–2 weeks).

---

## 1. Disambiguation

"Hermes" is overloaded. Candidates considered:

| Candidate | Is this what Terry meant? |
|---|---|
| **Nous Research — Hermes Agent** (agent framework) | ✅ Yes. Matches "very, very popular recently": ~95K stars in 7 weeks, v0.10 shipped 3 days ago. |
| Nous Research — Hermes 4 / 4.3 (LLM model) | ❌ The underlying model family; used *by* Hermes Agent but a separate product. |
| Other "Hermes" CLIs / agent tools | ❌ None surfaced with comparable traction in web search. |

Confirmed with Terry on 2026-04-19 before going deep.

### Hermes Agent in one paragraph

> *"The agent that grows with you"* — a self-improving, multi-platform, multi-provider autonomous agent daemon. Written in Python (+ some TypeScript for web UI components). MIT licensed. Runs locally on Linux/macOS/WSL2/Termux. Installs via `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`. Positioned explicitly as an OpenClaw rival.

Source: [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), [hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/), [v2026.4.16 release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.16).

---

## 2. Why Terry is asking

autonomOS's current provider abstraction (`packages/server/src/providers/{claude-code,codex,gemini-cli}.ts`) assumes the same model for all three agents:

1. There is a CLI binary (`claude`, `codex`, `gemini`).
2. We spawn it as a subprocess under `node-pty`.
3. We control it via CLI flags (`--session-id`, `--append-system-prompt`, `--settings`, `-c mcp_servers...`, etc).
4. We observe it via **hook events** that POST lifecycle JSON back to our server (`HOOK_CMD` → `curl $AUTONOMOS_SERVER/api/hooks/$SESSION_ID`).
5. Session state lives in JSONL transcripts we can tail-scan (`titleCache.ts`).
6. Each agent is **one PTY-one session-one process**.

Claude Code, Codex, and Gemini CLI all fit this mold. Hermes Agent and OpenClaw **do not** — both are daemon-style runtimes where the process topology is fundamentally different. Terry's question: can we (and should we) extend autonomOS to support them?

---

## 3. Hermes Agent — architectural answers

> **Provenance note:** Filenames, line counts, skill counts, and percentage claims in this section are cited from Hermes's public architecture documentation, release notes, and third-party write-ups — **not verified against a local checkout**. Figures like "~10K lines, `cli.py`" or "118 skills" should be read as "on the order of, per official sources as of 2026-04-19." If any integration work follows this doc, reconfirm against the repo at that point.

### 3.1 Runtime model

Hermes is **multiple entry points over a shared core**, not a single runtime shape:

| Entry point | What it is | Process topology |
|---|---|---|
| `hermes` / `hermes chat` | Interactive TUI CLI (~10K lines, `cli.py`) | One process per invocation; holds its own `AIAgent` instance |
| `hermes gateway` / `hermes gateway run` | Long-running daemon (~9K lines, `gateway/run.py`) | One process serving many sessions; `AIAgent` per incoming message |
| `hermes acp` | ACP stdio server — JSON-RPC 2.0 over stdin/stdout | One process per editor session |
| Batch runner / API server | Also share the core | — |
| **Tool Gateway** (v0.10) | *Not* a messaging gateway — it's a subscription-backed API aggregator (web search, image gen, TTS, browser) over Nous Portal OAuth | Conceptually separate from the messaging gateway |

Critically: the **CLI is not a thin client over the daemon**. Both the CLI and the gateway hold their own `AIAgent` instances. They share only:
- SQLite session store (`~/.hermes/`)
- Skills / memory on disk (`~/.hermes/skills/`, memory files)
- Config (`~/.hermes/config.yaml`, `auth.json`)

Source: [Architecture docs](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture).

**Implication for autonomOS:** there is no "spawn a Hermes process and hook it" primitive equivalent to `claude --session-id X --settings {...}`. The natural unit is either a gateway daemon (one per user) or an ACP stdio child (one per session).

### 3.2 Process & session model

- **Session store:** SQLite + FTS5 (`hermes_state.py`) — *not* JSONL transcripts. Sessions have lineage tracking (parent/child across compressions), per-platform isolation, and atomic writes with contention handling.
- **Resume:** `--resume` / `--continue` flags; `hermes sessions` subcommand for browse/export/prune/rename/delete.
- **State dir:** `~/.hermes/` — config, skills, webhook subscriptions, auth, sessions DB.
- **Shared across entry points:** start a session via CLI, continue it via Telegram — works because they read the same SQLite.

Source: [CLI Commands Reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands).

### 3.3 Event / hook system — *the* key question

Hermes has **two hook systems, neither HTTP-based like Claude Code**. This is the single biggest divergence from our current model.

**(a) Gateway Event Hooks** — file-based Python handlers:
- Location: `~/.hermes/hooks/<name>/`
- Each hook is a directory with `HOOK.yaml` (declares subscribed events) + `handler.py` (async/sync Python function).
- Events: `gateway:startup`, `session:start`, `session:end`, `session:reset`, `agent:start`, `agent:step`, `agent:end`, `command:*`.
- **No HTTP webhooks, no shell-command hooks.** Everything is in-process Python.

**(b) Plugin Hooks** — programmatic, CLI + gateway:
- Registered via `ctx.register_hook()` in a plugin's `register()`.
- Events: `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`.
- Only `pre_llm_call` can inject context; others are fire-and-forget.

**Inbound webhooks exist** (`hermes webhook` — receives POSTs from GitHub/GitLab/Stripe to trigger agent runs) but they are the *inverse* of what autonomOS needs. Hermes does **not emit outbound lifecycle webhooks**.

Source: [Event Hooks docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks), [Webhooks (inbound)](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks).

**Implication:** to replicate autonomOS's current hook-relay semantics, we'd need to **drop a custom Python hook** in `~/.hermes/hooks/autonomos/` that re-POSTs events to `$AUTONOMOS_SERVER/api/hooks/$SESSION_ID`. This is a one-time install per host, not a per-session flag. Compare to the Gemini model (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` env var → `~/.autonomos/gemini-settings.json`) — similar pattern, but Python instead of JSON.

### 3.4 Auth

**Strict BYOK.** Hermes proxies nothing — "requests go directly from your machine to your chosen provider."

- 25+ providers supported: openrouter, nous, openai-codex, copilot, copilot-acp, anthropic, gemini, google-gemini-cli, qwen-oauth, huggingface, zai, kimi-coding, minimax, deepseek, nvidia, xai, ollama-cloud, bedrock, ai-gateway, opencode-zen, opencode-go, kilocode, xiaomi, arcee, alibaba, and custom.
- Keys in `.env` / `config.yaml`; OAuth credentials in `auth.json`.
- Local Ollama via Custom Endpoint → `http://localhost:11434/v1`.
- **Nous Portal subscription** (OAuth) unlocks the v0.10 Tool Gateway (bundled web search / image gen / TTS / browser use).
- **Credential pools:** `hermes auth` rotates multiple keys for the same provider.

Source: [Providers docs](https://hermes-agent.nousresearch.com/docs/integrations/providers/), [Ollama integration](https://docs.ollama.com/integrations/hermes).

### 3.5 Permission / approval model

Three modes via `approvals.mode` in `~/.hermes/config.yaml`:

- **manual** — always prompt.
- **smart** — auxiliary LLM auto-approves low-risk commands.
- **off** — YOLO.

Tooling:

- Built-in dangerous-command regex (`rm -r`, `curl | sh`, etc).
- **Tirith** — Rust-based content-level scanner (homograph URLs, terminal injection). Exit 0 = allow, exit 1 = block.
- **Scopes:** Once / Session / Permanent (stored in `command_allowlist` in config.yaml).
- **Container bypass:** Docker/Modal/Singularity backends auto-bypass approval — "container itself serves as the security boundary."
- **Gateway approval flow:** `contextvars` + `threading.Event` — blocks the agent thread and awaits human response **through the same messaging platform that initiated the session** (approve via Telegram reply, etc.)

**External approval delegation is not documented.** Routing approvals into the autonomOS dashboard would require either a plugin hook intercepting `pre_tool_call` or a custom messaging adapter that pretends to be a chat platform.

Source: [Security docs](https://hermes-agent.nousresearch.com/docs/user-guide/security/), [DeepWiki writeup](https://deepwiki.com/NousResearch/hermes-agent/5.4-security-and-command-approval).

### 3.6 Terminal backends

"Terminal" here means **execution sandbox**, not a TTY. Six backends:

| Backend | What it is |
|---|---|
| **local** | Direct `subprocess` on host |
| **Docker** | Containerized sandbox per session |
| **SSH** | Remote machine exec |
| **Daytona** | Cloud dev environment |
| **Singularity** | HPC-style container runtime |
| **Modal** | Serverless/Firecracker microVM — hibernates when idle |

This is a **pluggable executor interface** (`terminal_tool.py` + `tools/environments/`) — the agent issues shell commands against whichever backend is configured per session. Conceptually: Claude Code's Bash tool with 6 sandbox flavors.

Source: [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture).

### 3.7 Messaging integrations

One daemon, 18 platform adapters:

```
Platform event → Adapter.on_message() → MessageEvent
  → GatewayRunner._handle_message() → authorize → resolve session key
  → create AIAgent → run_conversation() → gateway/delivery.py → reply
```

Files live under `gateway/platforms/`. `hermes pairing` manages DM access codes; `hermes whatsapp` does QR pairing. WhatsApp needs a separate Signal-like bridge process.

Note the **semantic overlap with autonomOS's own gateway** (`packages/server/src/gateway/`). We already have a URI-based router; Hermes already has 18 platform adapters. There's a world where integrating Hermes means autonomOS *delegates* all messaging to Hermes's gateway instead of duplicating it — a substantial re-architecture.

Source: [Gateway docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).

### 3.8 Skills system

- **File-based, progressive-disclosure** markdown files loaded on demand.
- **Compatible with agentskills.io open standard** (portable across Hermes, Claude Code, Cursor, Codex, etc.).
- **118 bundled skills in v0.10.0** (MLOps, GitHub, research, scraping, code execution).
- Format: directory with `SKILL.md` (YAML frontmatter + body) + optional reference material/templates/scripts.
- Location: `~/.hermes/skills/` is the source of truth.
- **Self-authored:** the agent writes new skills during use — the v0.10 claim is "self-created skills cut research task time by 40% versus a fresh agent instance."
- **Skills Hub** (external, security-scanned): [hermeshub.xyz](https://www.hermeshub.xyz/).

Source: [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills).

### 3.9 Open source status & codebase

- **MIT licensed**, [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
- **Python 87.6%, TypeScript 8.2%** (TS for web components).
- Main entry points: `cli.py` (~10K lines), `gateway/run.py` (~9K lines), `run_agent.py` (shared `AIAgent`).
- Key directories: `gateway/platforms/`, `gateway/hooks.py`, `tools/environments/`, `skills/`.

### 3.10 Precedent: hermes-workspace

[outsourc-e/hermes-workspace](https://github.com/outsourc-e/hermes-workspace) (500+ stars) is **directly analogous to autonomOS's dashboard**:

- React/TypeScript PWA — chat, terminal, memory, skills, inspector.
- **Does not spawn Hermes processes** — connects to a running gateway daemon.
- Connection: HTTP to `http://127.0.0.1:8642` (configurable via `HERMES_API_URL`) + **SSE streaming** for real-time agent output.
- API surface: OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models`, plus Hermes-specific endpoints for sessions / memory / skills that light up automatically when the gateway exposes them; degrades to basic chat if not.
- Startup: user runs `hermes gateway run` in one terminal, `pnpm dev` for the workspace in another.

**This is the integration pattern to mirror for Hermes, *not* the Claude Code spawn-and-hook pattern.**

---

## 4. OpenClaw — revisiting in light of current state

**ADR-003: Build on OpenClaw, Diverge If Needed** ([DECISIONS.md:32](../DECISIONS.md), 2026-03-03) committed to building on OpenClaw. An extensive research folder ([`docs/research/openclaw/`](./openclaw/), 2026-03-04) documents the runtime in detail — 7 files covering architecture, sessions/memory, plugin SDK, integration points, and `autonomos-integration.md`.

### 4.1 What changed since then

ADR-003 was never actually implemented. Between 2026-03-04 and 2026-04-19, the active investigation pivoted to **CLI-spawn multi-provider support** (see the prior `multi-provider-support.md` investigation dated 2026-04-11 — note: that file is currently untracked in git and may not be visible on this branch). The current `providers/index.ts` registers:

```ts
["claude-code", claudeCodeProvider],
["codex", codexProvider],
["gemini-cli", geminiCliProvider],
```

No OpenClaw. The "OpenClaw as substrate" plan was quietly superseded by "autonomOS spawns CLI agents directly."

This is worth a new DECISIONS.md entry — either formally superseding ADR-003 or clarifying the scope. See §10 for open questions.

### 4.2 OpenClaw architecture in one paragraph

> TypeScript/Node.js, MIT, `github.com/openclaw/openclaw`. Gateway daemon (systemd/LaunchAgent) binds `ws://127.0.0.1:18789`. Node 24 recommended. Single workspace at `~/.openclaw/workspace/`; config `~/.openclaw/openclaw.json`. Sessions persisted as JSONL transcripts in `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`. Memory in Markdown (`SOUL.md`, `MEMORY.md`, `USER.md`, `AGENTS.md`) + SQLite FTS/vector indices. CLI subcommands (`openclaw gateway`, `openclaw agent`, `openclaw message send`, `openclaw pairing approve`, etc) are thin clients to the daemon. **No per-lifecycle-event hook relay** — the WebSocket Gateway Protocol itself is the de-facto event surface. 50+ gateway RPC methods, 25 plugin lifecycle hooks, 22+ channels; reportedly ~345K stars per the [Digital Applied 2026 benchmark](https://www.digitalapplied.com/blog/openclaw-hermes-codex-cli-coding-agent-benchmark-2026).

Source: existing research at [docs/research/openclaw/](./openclaw/).

### 4.3 Hermes vs OpenClaw at a glance

| Dimension | Hermes Agent | OpenClaw |
|---|---|---|
| Language | Python (87%) + TS (UI) | TypeScript / Node.js |
| License | MIT | MIT |
| Launched | 2026-02-25 | Late 2025 (as Clawdbot/Moltbot) |
| Stars (Apr 2026) | ~95K | ~345K |
| Skills philosophy | **Self-authored** (agent writes its own) | **Human-authored** via ClawHub marketplace |
| Memory | 3-layer + SQLite FTS5 | Markdown (`SOUL.md`) + SQLite vector |
| Primary API | HTTP + SSE (gateway); JSON-RPC stdio (ACP) | **WebSocket only** (`ws://127.0.0.1:18789`) |
| Session ID surface | `~/.hermes/` SQLite + `hermes sessions` CLI | JSONL per agent + Gateway Protocol `sessions:list` |
| Approval delegation | Per-platform (Telegram reply, etc); no external API | Delegable via channels + `openclaw pairing approve` |
| Observability hooks | Python file-hooks in `~/.hermes/hooks/` | No lifecycle-hook relay; tail WS events + JSONL |
| Security posture | Built-in scanner (Tirith) + container sandboxes | Third-party reports of a March 2026 CVE cluster and malicious-skills campaign in ClawHub — see [Digital Applied](https://www.digitalapplied.com/blog/openclaw-hermes-codex-cli-coding-agent-benchmark-2026) and [The New Stack](https://thenewstack.io/persistent-ai-agents-compared/). **Not independently verified in this doc — warrants a security review before any embed decision.** |

Both are "persistent local agent daemons." The split: Hermes bets on *learning depth*, OpenClaw bets on *ecosystem breadth*.

---

## 5. Architectural comparison matrix

Reframing the core question on shared axes:

| Dimension | Claude Code | Codex CLI | Gemini CLI | **Hermes Agent** | **OpenClaw** |
|---|---|---|---|---|---|
| Runtime unit | CLI subprocess | CLI subprocess | CLI subprocess | Gateway daemon + CLI + ACP stdio | Gateway daemon + thin CLI |
| Process-per-session? | Yes (PTY) | Yes (PTY) | Yes (PTY) | No (daemon owns many) | No (daemon owns all) |
| Session ID | `--session-id` flag | auto | auto | SQLite-assigned | OpenClaw-assigned |
| State store | JSONL per project | JSONL | JSONL | SQLite + FTS5 | JSONL + SQLite vector + Markdown |
| Hook relay mechanism | `--settings` inline JSON (13 events) | `~/.codex/hooks.json` + `--enable codex_hooks` (5 events) | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` → JSON (11 events) | Python files in `~/.hermes/hooks/<name>/` (8 events) | None — subscribe to WS events |
| System prompt injection | `--append-system-prompt` flag | `-c instructions=...` flag | Prepend to user prompt | `config.yaml` + skills + bootstrap md | Markdown bootstrap files (workspace-global) |
| MCP support | `--mcp-config` flag (per-session) | `-c mcp_servers...` flags | Same settings file | MCP registry (plugin) | MCP registry |
| Integration surface | Flags + hooks | Flags + file-install hooks | Env + file-install hooks + prepend | Plugin SDK + HTTP/SSE + ACP JSON-RPC | WebSocket Gateway Protocol |
| Approval delegation | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` | Internal; per-platform only | Delegable via channels |
| Fits `AgentProvider`? | ✅ perfect fit | ✅ fit | ✅ fit | ❌ fundamentally different | ❌ fundamentally different |

The first three rows are the key divergence. Our current `AgentProvider` is a function of `(options) → PtyHandle`. Hermes and OpenClaw break that at the first step.

---

## 6. Where the current `AgentProvider` abstraction breaks

Looking at `packages/server/src/providers/` (read 2026-04-19):

```ts
// index.ts
const providers = new Map<string, AgentProvider>([
  ["claude-code", claudeCodeProvider],
  ["codex", codexProvider],
  ["gemini-cli", geminiCliProvider],
]);
```

Each provider exposes:

| Method | Purpose | Works for daemon-style? |
|---|---|---|
| `resolveBinary()` | Find the CLI binary | ❌ For Hermes we'd resolve `hermes` but *the daemon is already running* — we don't want to exec a new one per session. |
| `buildArgs(options)` | Construct CLI argv from generic `SpawnOptions` | ❌ For OpenClaw there are no per-session CLI args; the session exists inside the daemon. |
| `buildEnv(sessionId, agentName)` | Construct env vars | Partially — still needed for child processes (ACP stdio), but meaningless for an already-running gateway. |
| `attachStartupWatcher?` | Auto-dismiss CC's trust/channels prompts via PTY data | ❌ No PTY in daemon model. |
| `capabilities` object | Static capability flags | ✅ fits either model. |

The assumption baked into every line of these files: **one session = one PTY child process spawned by autonomOS**. Hermes and OpenClaw both say "no, I'm a daemon you talk to." You can't glue that into `AgentProvider` without the seams showing.

### What we'd need for daemon-style support

A second abstraction — call it `SessionProvider` — with a different shape:

```ts
interface SessionProvider {
  name: string;
  displayName: string;
  capabilities: Capabilities;          // shared with AgentProvider

  // Lifecycle
  connect(): Promise<Connection>;      // e.g. WebSocket, HTTP+SSE, or ACP stdio
  createSession(options): Promise<SessionHandle>;
  resumeSession(id): Promise<SessionHandle>;
  destroySession(id): Promise<void>;

  // Observation
  subscribeToEvents(id, cb): Unsubscribe;   // lifecycle events
  readTranscript(id, opts): Promise<Transcript>;

  // Control
  sendMessage(id, msg): Promise<void>;
  abortSession(id): Promise<void>;

  // One-time setup (analogous to writeGeminiSettings)
  installHostConfig?(): Promise<void>;  // e.g. drop the autonomOS Python hook into ~/.hermes/hooks/
}
```

`AgentProvider` would continue to serve the three CLI providers unchanged. The server code currently tied to PTY handles (status derivation, messaging, etc) would need a small plumbing change to work against a unified `SessionHandle` — that's the integration-cost elephant.

---

## 7. Integration assessment — Hermes

Three realistic integration paths, in order of increasing scope:

### Path A — ACP stdio adapter (XS, prototype-worthy)

- `hermes acp` speaks JSON-RPC 2.0 over stdin/stdout.
- Very similar to our existing PTY+hooks mental model: spawn a child, read structured events from stdout.
- **Fits surprisingly well into `AgentProvider`** — `buildArgs` → `["acp"]`, `attachStartupWatcher` unused, `buildEnv` passes config. Observation layer needs a JSON-RPC parser instead of hook HTTP POSTs.
- Limitation: ACP is per-session and editor-focused. Doesn't give us Hermes's long-lived memory/skills benefits.
- **Effort: ~1–2 days** for a read-only proof of concept that surfaces Hermes sessions in the autonomOS sidebar.

### Path B — Gateway-daemon connector (M, production-worthy)

- Mirror the hermes-workspace playbook: let the user run `hermes gateway run` themselves, autonomOS connects via HTTP + SSE to `http://127.0.0.1:8642`.
- Drop a custom Python hook at `~/.hermes/hooks/autonomos/HOOK.yaml` + `handler.py` that POSTs events to `$AUTONOMOS_SERVER/api/hooks/...` — preserves the hook-relay semantics we rely on.
- Add a `SessionProvider` abstraction as described in §6.
- Handles all of Hermes's messaging integrations, memory, skills, scheduled runs natively — autonomOS becomes a dashboard on top.
- **Effort: ~1–2 weeks.** Biggest risk is approval-flow mismatch (§3.5).

### Path C — Deep integration (L, speculative)

- autonomOS *delegates* its existing messaging gateway to Hermes's 18 platform adapters.
- Would obsolete large parts of `packages/server/src/gateway/platforms/` (if those exist as sketches).
- High architectural churn, high payoff. Not recommended without a separate design review.
- **Effort: several weeks.** I'd oppose unless we decide autonomOS's identity is "orchestrator for Hermes daemons" vs "orchestrator for any agent."

---

## 8. Integration assessment — OpenClaw

See existing [`autonomos-integration.md`](./openclaw/autonomos-integration.md) for the detailed plan. Summary of what's different from Hermes:

- **WebSocket-only** (no SSE, no JSON-RPC over stdio equivalent). Adapter would be a pure WS client.
- **No hook relay** — observability is WS events + JSONL tails.
- **Approval delegation** *is* first-class (channels), which is a modest advantage over Hermes.
- **Security posture concern** — third-party reports (per [Digital Applied](https://www.digitalapplied.com/blog/openclaw-hermes-codex-cli-coding-agent-benchmark-2026), [The New Stack](https://thenewstack.io/persistent-ai-agents-compared/)) cite a March 2026 CVE cluster and a malicious-skills campaign in ClawHub. Not independently verified here; warrants a security review before any embed. Sandbox if we proceed.
- Effort: similar to Hermes Path B (~1–2 weeks) once the `SessionProvider` abstraction exists.

---

## 9. Recommendation

**Pursue-conditional — but not now, and not both.**

### Short term (1–2 sprints)

- ✅ **Finish the current CLI multi-provider push** (Codex + Gemini + Claude Code polish). The MultiProvider@autonomOS agent's work should land first.
- ✅ **Write a new DECISIONS.md entry** clarifying the current stance: autonomOS is a spawn-and-hook orchestrator for CLI agents. ADR-003's "build on OpenClaw" plan was superseded in practice; make it explicit. (Out of scope for this PR — see §10.)
- ⏸️ **Do not integrate Hermes or OpenClaw yet.** The `AgentProvider` abstraction is still being refined under load from 3 real CLI providers.

### Medium term — if there's demand

- 🟡 **Prototype Hermes ACP stdio** (Path A, ~1–2 days). Low-risk way to validate the mental model. Lands under existing `AgentProvider` with minimal contortion.
- 🟡 **Only if Path A feels valuable** → design a `SessionProvider` abstraction (§6) and implement Hermes Path B + OpenClaw in parallel. This is the "we want daemon agents" commitment.

### Not recommended

- ❌ Bolt Hermes or OpenClaw into the existing `AgentProvider` by making `resolveBinary()` a no-op and inventing per-provider lifecycle hooks. That's how abstractions rot.
- ❌ Path C (delegate messaging to Hermes). Requires a deeper product conversation about what autonomOS *is*, not a research doc.

### Why Hermes over OpenClaw if we pick one

1. **ACP stdio mode** offers a much cheaper first integration than OpenClaw's WS-only surface.
2. **Python file-hooks** are closer to our existing hook-command mental model than OpenClaw's "subscribe to WS events."
3. **Security posture** — OpenClaw's recent CVE cluster and malicious-skills reports (cited in §4.3 and §8, based on third-party reporting; not independently verified) would warrant a pre-embed security review. Hermes has no comparable reporting surfaced in this research. Treat this reason as contingent on confirming those reports.
4. **Momentum** — Hermes is the newer, faster-growing project; OpenClaw's weekend-hacker origin has shifted to foundation governance.

---

## 10. Open questions for Terry

1. **ADR-003 status** — do you want me to draft a superseding decision record, or is that team-lead work?
2. **Multi-provider scope** — is "finish Codex/Gemini CLI support" the right stopping point, or is the broader plan to cover daemon-style agents sooner?
3. **Who owns Hermes integration** if we go ahead? A fresh worker, or extension of MultiProvider@autonomOS's scope?

---

## Sources

Hermes Agent:
- [NousResearch/hermes-agent (GitHub)](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/)
- [v2026.4.16 release notes (v0.10 Tool Gateway)](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.16)
- [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [ACP Editor Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [Security / Command Approval (DeepWiki)](https://deepwiki.com/NousResearch/hermes-agent/5.4-security-and-command-approval)
- [Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [outsourc-e/hermes-workspace (third-party web UI precedent)](https://github.com/outsourc-e/hermes-workspace)

OpenClaw:
- [openclaw/openclaw (GitHub)](https://github.com/openclaw/openclaw)
- [docs.openclaw.ai](https://docs.openclaw.ai/)
- [The New Stack — OpenClaw vs Hermes](https://thenewstack.io/persistent-ai-agents-compared/)
- [Digital Applied benchmark 2026](https://www.digitalapplied.com/blog/openclaw-hermes-codex-cli-coding-agent-benchmark-2026)
- [Turing Post — Hermes vs OpenClaw](https://www.turingpost.com/p/hermes)
- [freeCodeCamp — Build and Secure a Personal AI Agent with OpenClaw](https://www.freecodecamp.org/news/how-to-build-and-secure-a-personal-ai-agent-with-openclaw)
- Prior autonomOS research: [`docs/research/openclaw/`](./openclaw/)

Prior autonomOS research referenced:
- `docs/research/multi-provider-support.md` (authored 2026-04-11; currently untracked in git — may not be on this branch)
- [`docs/DECISIONS.md` — ADR-003](../DECISIONS.md)
