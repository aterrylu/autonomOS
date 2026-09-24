# Phase 1 spec: memory as an optional external backend behind the autonomOS MCP surface (2026-09-12)

**Status:** design only, no build. Supersedes the Phase 1 sketches in [`README.md`](README.md) §4 and [`external.md`](external.md) §3a for the parts they overlap.

Locked by Terry across the three rounds: backend = **mem0 OSS** (mem0 Platform as the hosted variant), embeddings = **vendor image as shipped** (API-key path, no rebuild), Claude Code's native auto-memory = **leave it alone**, scopes = fleet + project + agent, writes = direct and attributed, wording = verbatim by default.

The reframe that shapes this document: *memory is a feature of autonomOS, an open-source product other people install.* Terry's laptop-plus-forge layout is one topology among many. So the design target is a stranger who ran `curl … | bash`, has Claude Code and maybe Codex, may or may not have Docker, and must get a fully working autonomOS **whether or not** they ever turn memory on.

---

## 1. Principles

1. **Off by default; absent is first-class.** An install without memory is 100% functional and never shows a broken tool, a red probe, or a prompt about Docker. Enabling memory is an explicit act.
2. **One backend adapter, three ways to reach it.** The server talks to mem0 through one adapter interface. Whether the mem0 server was started by autonomOS, runs on another machine, or is the hosted Platform is a configuration difference, not a code path.
3. **Attribution is ours.** Backends store whatever `agent_id` they are handed. Every write passes through the channel server, which stamps the gateway-verified agent identity. Agents never hold the backend key.
4. **Secrets follow the env-preset pattern.** Declared by name, keyed by a human in the dashboard, masked on every read, never settable from an MCP tool, never solicited in chat (ADR-067).
5. **Verbatim by default.** `infer=false` on every write unless the caller explicitly asks for consolidation.
6. **Digest, not dependency.** What an agent sees at spawn is derived from a `recall` at that moment; nothing memory-related is persisted on the agent record.

---

## 2. The install story for a stranger

Three modes, selected in Settings → Memory (dashboard) or by `autonomos memory …` verbs. `mode: "off"` is the shipped default.

| Mode | Who it is for | What autonomOS does | Requirements |
|---|---|---|---|
| **off** (default) | everyone, initially | nothing: tools hidden, no digest, no probe | none |
| **managed** | single-machine users who want it to "just work" | writes a pinned `docker-compose.yml` into `$configDir/memory/`, runs `docker compose up -d`, health-checks, stores the URL and a generated service key in settings | **Docker** (Docker Desktop, OrbStack, colima, or rootless docker on Linux) + one embeddings API key |
| **external** | multi-machine users, people who already run mem0, teams | stores a server URL + API key; probes it | a reachable mem0 OSS server (started by anything, on any machine) |
| **platform** | users who want zero ops | stores the mem0 Platform key; adapter targets `api.mem0.ai` | a mem0 Platform account (Hobby free, Starter $19/mo) |

Multi-machine collapses into **external**: run `managed` on one box (or anywhere), point the others at its URL. That is Terry's forge/laptop layout and it needs no special casing.

### `autonomos memory` verbs (CLI, mirrors the dashboard)

```
autonomos memory status            # mode, URL (masked key), probe result, counts, image digest
autonomos memory enable --managed  # checks docker, writes compose, pulls pinned images, starts, probes
autonomos memory enable --external <url>   # then: key it in the dashboard
autonomos memory enable --platform         # then: key it in the dashboard
autonomos memory disable           # hides tools, stops digest; managed: `docker compose stop` (data kept)
autonomos memory backup <file>     # managed: pg_dump through the compose db container
autonomos memory restore <file>
autonomos memory import-claude-code [--project <name>]   # one-way seed from ~/.claude/projects/<slug>/memory/
autonomos memory reindex           # no-op for mem0; reserved
```

`enable --managed` is the only verb with a hard external prerequisite. Its failure path is a **message, not a crash**: "Memory (managed) needs Docker. Install Docker Desktop or OrbStack, or use `--external <url>` to point at a mem0 server you run elsewhere." The rest of autonomOS is untouched.

### What the managed compose contains

The vendor's `server/docker-compose.yaml` shape, pinned and narrowed: `mem0/mem0-api-server` **by image digest** (tags move; the OSS server is published from the monorepo without semver tags of its own — pin the digest in a constant next to the Claude Code / Codex version pins), `pgvector/pgvector:pg17` by digest, both bound to `127.0.0.1:<free port>` chosen at enable time (never `:3100`), a named volume `autonomos-memory-pgdata`, `restart: unless-stopped`, env from a generated `.env` (0600): `POSTGRES_PASSWORD` (generated), `ADMIN_API_KEY` (generated, this becomes the service key autonomOS uses), `MEM0_DEFAULT_LLM_MODEL` unused when `infer=false` but the image insists on an LLM key at boot — see §7, and the embeddings key the user supplied.

Supervision is **Docker's**, not launchd/systemd: `restart: unless-stopped` survives reboots wherever Docker itself autostarts. autonomOS only probes and reports. This avoids the per-platform service-unit matrix for a second daemon, at the price that "Docker is not running" is a state the dashboard must render.

---

## 3. Config surface

Additions to `settings.json` (typed in `settings.ts`, edited through the existing Settings panel):

```jsonc
"memory": {
  "mode": "off" | "managed" | "external" | "platform",
  "serverUrl": "http://127.0.0.1:18888",        // managed: written by enable; external: user
  "secretKeys": ["MEMORY_API_KEY", "OPENAI_API_KEY"],   // declared names; values in secrets, 0600, masked on read
  "embeddings": { "provider": "openai" | "gemini", "model": "text-embedding-3-small" },
  "defaultScope": "project",                     // what remember() uses when scope is omitted
  "digest": { "enabled": true, "maxItems": 40, "maxTokens": 2500 },
  "allowInfer": false                            // whether remember(infer:true) is honoured
}
```

Secrets ride the env-preset mechanism verbatim (`secretKeys` + `secrets`, `maskEnvPreset`-style redaction, human-only write via the REST route, MCP write surface omits `secrets`). The Settings panel shows "MEMORY_API_KEY: set (…a1b2)" the way the Presets tab does. Keys are consumed **only** by the server-side adapter; they are never placed in an agent's env.

**Data-locality statement (goes in the user guide and the Settings panel help text):** in `managed` and `external` modes the memory text itself stays in the user's Postgres, but **every remembered text and every query is sent to the configured embeddings provider** (OpenAI or Gemini with the vendor image as shipped). In `platform` mode everything is stored by mem0. Users who need nothing to leave the box must rebuild the vendor image for a local embedder (documented as an advanced recipe, not a supported mode).

---

## 4. Runtime design

### Adapter

`packages/server/src/memory/adapter.ts` defines one interface and three implementations that differ only in base URL and auth header:

```ts
interface MemoryBackend {
  probe(): Promise<{ ok: boolean; detail?: string }>;
  remember(w: { text: string; scope: Scope; agent: string; project?: string; infer?: boolean; meta?: Record<string, string> }): Promise<{ id: string }>;
  recall(q: { query: string; scopes: Scope[]; agent: string; project?: string; limit?: number }): Promise<MemoryHit[]>;
  forget(id: string, agent: string): Promise<void>;
  list(scope: Scope, agent: string, project?: string): Promise<MemoryHit[]>;
}
```

Scope mapping onto mem0's flat fields (the same for OSS and Platform): `agent` scope → `user_id: "agent:<name>"`; `project` → `user_id: "project:<name>"`; `fleet` → `user_id: "fleet"`; always `agent_id: <caller>` and `metadata: { scope, author, project, ts }`. Recall across scopes is one call per scope (mem0 filters are flat), merged and labelled. The shim dedups raw writes by exact text within a scope (OSS `infer=false` does not).

A fourth implementation, **`NullBackend`**, is what `mode: "off"` resolves to. It is not a stub for tests; it is the production object for every install that has not enabled memory, and it makes every call site total.

### Tool surface

Three tools in `mcp/tools.ts`, following the four-place recipe from the codebase survey (`validation.ts` Zod → `tools.ts` JSON copy → channel-server `case` → `mcp.ts` registration) plus the committed `dist.mjs` rebuild:

- `recall(query, scope?: "agent"|"project"|"fleet"|"all")` — `readOnlyHint: true` (Codex `writes` mode never prompts; add to the `READ_ONLY` set in the annotations test).
- `remember(text, scope?, infer?)` — mutating, no hint. Routed over the **gateway WebSocket** (like `send`), not `serverFetch`, so the caller identity is the gateway-verified session.
- `forget(id)` — mutating; only the author or the operator may delete.

**Visibility when memory is off.** The channel server receives `AUTONOMOS_MEMORY_ENABLED=0|1` in its env at spawn and **omits the three tools from `ListTools`** when off. Agents in an install without memory never see them, so Codex never prompts for them and no agent wastes a turn discovering "memory unavailable". `MCP_INSTRUCTIONS` gains a short conditional section; the `mcp-instructions-sync` test's rule (every tool in `ALL_TOOLS` appears in the prose) is satisfied because the tools remain in `ALL_TOOLS` and the prose mentions them under an "if memory is enabled" heading. Agents spawned before memory was enabled keep the old prose until respawn, which is the same behaviour every tool addition has today.

### Digest at spawn

When enabled, `buildSystemPrompt` appends a **Memory** section: `recall` of the agent's own scope and its project scope (project = the agent record's `project`, else the cwd's repo name), rendered as one line per hit with author and date, capped by `digest.maxItems`/`maxTokens`. Derived at every spawn, never stored on the record (so `respawnAgent` cannot lose it). This is also the only memory path that reaches **Gemini** agents today (the channel server does not launch under Gemini's PTY mode; see the survey).

### Absent-backend behaviour

| Situation | Tools | Digest | Dashboard | Anything else |
|---|---|---|---|---|
| `mode: off` | hidden | none | Memory settings show "Off — enable" | zero footprint |
| enabled, backend healthy | live | fresh | pane + green probe | — |
| enabled, backend unreachable (Docker stopped, network down, key revoked) | `recall`/`remember` return a plain tool error: "Memory backend unavailable (probe failed at <time>)"; nothing fabricated; `remember` is **not** queued for later replay (a stale replay is worse than an honest failure) | **last successful digest for that agent is cached at `$configDir/memory-cache/<agentId>.md` and injected with a "stale as of <time>" header**; no cache → section omitted | red probe in the status bar; Memory pane shows the probe detail and the fix hint per mode | spawn, messaging, scheduling, everything else unaffected |
| enabled, probe slow | bounded: probe 2 s, `recall` 5 s, `remember` 5 s; timeouts render as the unavailable case | | | spawn is never blocked by memory: the digest recall runs with the same 5 s bound and falls back to the cache |

### Dashboard

- **Settings → Memory**: mode selector, URL, secret entry (masked), embeddings provider/model, default scope, digest toggle, `allowInfer`, data-locality note, "Test connection".
- **Memory pane** (new `ActivePane` variant, `PresetsPanel` as the structural analogue; remember `isValidActivePane` and the two persisted pane carriers): scope tabs (fleet / project / agent), list with author + date, search box (calls `recall`), delete, and a one-click **"Import from Claude Code"** that runs the seed job for the selected project.
- **Status bar**: a small memory indicator via the existing dashboard plugin registry (`connection-status` is the analogue): green/red/off.

### Claude Code's native memory

Left alone, per Terry. Two touchpoints only: the one-way **import** (seed job) and a line in the guide explaining that Claude Code agents also keep a local per-repo memory that Codex/Gemini do not see, and that anything the fleet should know goes through `remember`.

---

## 5. Test strategy

- **No Docker in CI.** The adapter interface gets a `FakeMem0Server` (an in-process HTTP server speaking the OSS REST shape: `/memories`, `/search`, `/memories/{id}`) so the tool → gateway → adapter → REST path is exercised end-to-end without a container, per the real-agent test philosophy (fake only the far side). `NullBackend` is tested as the default resolution of a settings file with no `memory` key.
- **Mutation-style checks on the honesty properties:** the unavailable path must return an error, not an empty array (a test that swaps the fake for a refusing server and asserts the tool result text); the digest cache header must carry the timestamp; `remember` over the REST path (the wrong path) must be rejected so the attribution guarantee is placement-tested, not just logic-tested.
- **Tool-surface guards**: drift test entries for the three tools, `recall` in `READ_ONLY`, `remember`/`forget` asserted **not** read-only, `ListTools` omits all three when `AUTONOMOS_MEMORY_ENABLED=0`.
- **Config isolation**: the managed compose dir and cache dir resolve through `getConfigDir()` per call, so the #350 guard applies.
- **One real spawn QA** before the PR (house rule): enable managed mode on an isolated instance (own config dir, own port, own compose project name), spawn a Claude Code and a Codex agent, `remember` from one, `recall` from the other, kill the container, confirm the tool error and the stale digest, restart, confirm recovery.

---

## 6. Phasing and size

| Phase | Scope | Size |
|---|---|---|
| **1a — core** | adapter + `NullBackend` + settings schema + secrets plumbing + three tools (four places + bundle rebuild) + gateway routing for `remember` + digest with cache + probe + status-bar indicator + `FakeMem0Server` tests + ADR | **M** (1–2 weeks) |
| **1b — managed mode** | `autonomos memory enable/disable/status/backup/restore`, compose generation with digest pins, Docker detection and messaging, port selection | **S–M** (3–5 days); the cross-platform Docker surface is the risk |
| **1c — dashboard** | Settings → Memory, Memory pane, Import-from-Claude-Code button, guide page `docs/guide/10-memory.md` (coordinate with Onboarding@autonomOS), `make hero` if the sidebar changes | **S–M** |
| **2 — later** | `allowInfer` "consolidate" path using mem0's extraction; capture nudges on PreCompact/SessionEnd; a Codex/Gemini seed from their own memory files; a local-embedder recipe | — |

1a ships before 1b: with `external` and `platform` modes alone the feature is complete for anyone who can run or buy a mem0 server; `managed` is convenience.

---

## 7. What the product frame makes harder (flagged, not solved)

1. **Docker as an optional dependency is a support surface.** Docker Desktop vs OrbStack vs colima vs rootless docker differ in socket paths, autostart, and `host.docker.internal`. The installer today checks Node and Claude Code only. `enable --managed` must detect (`docker info`), explain, and never assume. Linux servers without a desktop session need the user to make Docker autostart; that is out of our hands and must be documented.
2. **The mem0 OSS server image's boot requirements.** It expects an LLM key env even when every write is `infer=false` (it constructs the LLM client unconditionally, per the re-scan). Managed mode may need to pass a placeholder or the same key as embeddings; this must be verified against the pinned image during 1b, and if the image refuses to boot without a *valid* key, the data-locality statement widens (an LLM provider key exists on the box even if unused).
3. **Vendor image = OpenAI or Gemini embeddings only.** Users who want fully local memory get an advanced recipe, not a mode. If demand appears, a rebuilt image with Ollama support becomes a maintained artifact of ours, which erodes the "maintained by someone else" argument.
4. **Pinning by digest means we own upgrades.** A mem0 server upgrade may carry Postgres migrations; `autonomos memory upgrade` (out of Phase 1) would have to run them. Until then, the pinned digest is frozen per autonomOS release and noted in the changelog.
5. **Platform-tier limits.** Hobby's 1,000 retrievals per month is below what a fleet doing a digest per spawn will use; the guide must say Starter is the realistic floor.
6. **Gemini agents are digest-only** until the channel-server launch gap under Gemini's PTY mode is closed (CodexGemini initiative). Stated in the ADR and the guide.
7. **Multi-machine still means one server.** Nothing here replicates; laptop-offline use is not provided by mem0 or any candidate. The guide should say so plainly.
8. **The Memory pane is a visible dashboard change** → `make hero` and the README screenshot must be refreshed when 1c lands.

---

## 8. ADR to record at build time

Title: **"Memory is an optional external backend behind the autonomOS MCP surface."** Decisions to capture: mem0 OSS as the backend with the Platform as the hosted variant; off by default with `NullBackend` as the production default; the three modes; verbatim-by-default with `allowInfer` gated in settings; attribution enforced by the channel server via the gateway identity; secrets on the env-preset pattern; digest derived per spawn and cached on disk for the unavailable case; Claude Code native memory left alone with a one-way import; Docker supervision delegated to Docker's restart policy; the digest-pinning and upgrade ownership; alternatives considered (custom store — README; redirecting Claude Code memory — `coexistence.md`; Honcho/cognee — `external.md`).

## 9. Open items for Terry before 1a starts

1. Default `defaultScope`: `project` (recommended: it matches how the existing 134 facts were written) or `fleet`?
2. Should `platform` mode ship in 1a, or only `external` + `managed` (keeps the first release self-host-only and avoids documenting a paid tier)?
3. Managed-mode port policy: fixed default (e.g. `18888`) or always a free port written to settings?
4. Guide placement: a new `10-memory.md`, or a section in `06-permissions-and-settings.md`? (Onboarding@autonomOS to weigh in.)
