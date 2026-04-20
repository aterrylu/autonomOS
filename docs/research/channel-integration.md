# Telegram & Discord Channel Integration — Research & Recommendation

**Status:** Research complete, recommendation pending human approval
**Date:** 2026-04-20
**Author:** Feature worker (with input from OpenClaw@homelab, claude-code-guide subagent, primary CC docs)

## TL;DR

**Recommendation: Option B (lean on CC native channels) for MVP, Option C (hybrid + gateway adapters) for proactive outbound in Phase 2.**

Why: autonomOS **already** uses Claude Code's channel protocol (`server:autonomos` is a `claude/channel` capability server). Extending to Telegram/Discord is literally "add two strings to `settings.channels`" — no code change needed for inbound. Outbound proactive alerts (agent → Telegram chat it hasn't received a message from) is the only case that actually benefits from building our own adapter, and that's deferrable.

Total MVP effort: **~1 day** (dashboard settings UI + docs). Proactive outbound: **~3–5 days per platform**.

---

## 1. Premise Verification

### What's real (primary-source verified)

| Claim | Source | Verified? |
|---|---|---|
| CC has `--channels` flag | `code.claude.com/docs/en/channels` | ✅ Documented |
| CC has `--dangerously-load-development-channels` | same + `channels-reference` | ✅ Documented |
| `channelsEnabled` / `allowedChannelPlugins` managed settings | `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (local `node_modules`) | ✅ SDK types |
| Telegram/Discord/iMessage plugins shipped | `github.com/anthropics/claude-plugins-official/tree/main/external_plugins` | ✅ Repo exists |
| `claude.ai` login required (not API keys) | channels doc | ✅ Documented |
| Channels require CC v2.1.80+ | channels doc | ✅ (we're on 2.1.114) |
| Research preview (syntax may change) | channels doc § Research preview | ✅ Documented |

### What OpenClaw@homelab got wrong

The OpenClaw@homelab agent responded that they "don't recognize `tengu_harbor`, `--channels`, or `--dangerously-load-development-channels`." That's incorrect — our own codebase already uses both flags (see [`providers/claude-code.ts:136-146`](../../packages/server/src/providers/claude-code.ts)). They were either running an older CC version or unfamiliar with the feature. Their OpenClaw (Peter Steinberger's framework) context remains useful as a UX reference, see §3.

### Premise: confirmed

CC Channels is a real, documented, shipped feature. Option B is technically viable today.

---

## 2. Architecture Comparison

### The three options (and a fourth that fell out during investigation)

**Option A — autonomOS owns transport**
- Complete `packages/server/src/gateway/adapters/{telegram,discord}.ts` using grammY + discord.js
- Route inbound: Telegram webhook → `TelegramAdapter` → gateway router → delivers to session over our existing `server:autonomos` channel
- Route outbound: `send({to: "telegram://chat_id", ...})` → adapter.send() → Telegram API
- Credentials: autonomOS settings or env vars

**Option B — CC native channels**
- Install `plugin:telegram@claude-plugins-official` and `plugin:discord@claude-plugins-official` on the host once
- Add `"plugin:telegram@claude-plugins-official"` to `autonomos/settings.json → channels[]`
- Provider translates to `--channels plugin:telegram@claude-plugins-official` on every spawn (already plumbed)
- Inbound: CC's plugin polls Telegram, pushes `<channel source="telegram" chat_id="...">` into session
- Outbound: CC calls the plugin's reply tool (scoped to inbound context)

**Option C — Hybrid (my original framing)**
- CC owns transport (Option B for inbound)
- We layer `telegram://` URI routing in the gateway for outbound-only proactive sends
- Keeps agent-facing `send()` API consistent across all destinations

**Option D — autonomOS extends its own `server:autonomos` channel with platform tools** (emerged during investigation)
- Add `send_telegram(chat_id, text)` etc. as tools in `channel-server/index.ts`
- autonomOS owns Telegram/Discord credentials and a backing adapter
- Inbound still via CC plugins (or via our own notifications if we ditch plugins)
- Outbound: agent calls our existing MCP, we proxy to adapter

### Concrete tradeoff matrix

| Dimension | A (DIY) | B (CC plugins) | C (Hybrid) | D (autonomOS channel extension) |
|---|---|---|---|---|
| **Engineering effort** | High (~1–2 wks) | **~1 day** | ~3–5 days | ~3–5 days |
| **Inbound flow** | Our adapter → gateway → session | **CC plugin → `<channel>` tag** | CC plugin (via B) | CC plugin OR our own push |
| **Outbound context-bound (reply in thread)** | ✅ via adapter | ✅ via plugin reply tool | ✅ via plugin | ✅ via plugin |
| **Outbound proactive (arbitrary chat)** | ✅ via adapter | ❌ plugin reply scoped to inbound | ✅ via adapter (outbound only) | ✅ via our new tool |
| **Resume continuity** | ✅ (settings persist) | ✅ (settings persist, provider re-reads) | ✅ | ✅ |
| **Permission relay (approve from phone)** | ❌ we'd need to reimplement | ✅ **free from plugins** | ✅ free | Free if we reimplement |
| **Credentials management** | Ours (new settings fields) | **CC's `~/.claude/channels/`** | Both (split) | Ours |
| **Lock-in risk** | None (we own it) | Research preview, syntax may change | Low (adapter is escape hatch) | Low |
| **Compliance: Team/Enterprise gate** | N/A (bypass org policy) | ⚠️ `channelsEnabled` admin-gated | ⚠️ same | N/A |
| **Auth requirement** | N/A | ⚠️ `claude.ai` login required | ⚠️ same for inbound | N/A |
| **Feature breadth** | What we build | Full pairing flow, sender allowlist, permission relay, iMessage bonus | Full (via plugins) + ours | Ours only |
| **Debuggability** | Our logs | CC plugin logs (less visibility) | Split | Our logs |

### Where A genuinely wins: compliance-gated environments

If an enterprise deployment has `channelsEnabled: false` and admins won't flip it, Option B is dead. Option A works anywhere. But this is autonomOS's own deployment at Terry's scale — we control the gate.

### Where A genuinely loses: auth + maintenance

Anthropic maintains the official plugins. We'd have to maintain:
- Telegram long-polling loop + offset persistence
- Discord gateway WebSocket + resume logic (Discord WS churns; OpenClaw reports leaks every 30 min)
- Sender allowlist + pairing flow
- Token rotation, error handling, rate limits
- iMessage (not even a bot — macOS DB + AppleScript)

That's a lot of undifferentiated work.

---

## 3. OpenClaw UX Teardown

OpenClaw@homelab described their actual OpenClaw (Peter Steinberger's framework) setup. What's transferable:

**What OpenClaw does well:**
1. **Single JSON file as source of truth** (`~/.openclaw/openclaw.json`). No divergent sources. All plugins in one `plugins.entries` map.
2. **Gateway hot-reload for config edits** — token changes don't require a restart. Plugin add/remove does, but it's deferred until active tasks finish.
3. **Uniform pipeline**: cron, heartbeat, Telegram DM → all spawn the same worker pair. New trigger types don't need special-casing.
4. **Declarative delivery routing**: tasks specify `delivery.channel` + `delivery.to`, task code is channel-agnostic.
5. **Failure alerts with separate routing** (`--failure-alert-channel`, `--failure-alert-cooldown`). Success and failure can go to different destinations.

**What autonomOS already has (or could reach easily):**
- ✅ Single settings source: `~/.autonomos/settings.json → channels[]`
- ✅ URI-based routing: `agent://`, `telegram://`, `broadcast://` — declarative, channel-agnostic `send()`
- ❌ Hot-reload of channel config changes (currently requires session restart)
- ❌ Schedule-level delivery routing (we have `target: "isolated"` or `agent:name` but no generic `delivery.channel`)
- ❌ Separate failure alerting

**What's worth copying into autonomOS:**
- Dashboard Settings panel: "Channels" section, toggle per plugin, shows status (installed / paired / active sessions)
- Schedule config: optional `delivery: { channel, to }` field so a scheduled agent output can post to Telegram automatically
- Failure alerts: optional `failureAlert: { channel, to, cooldownSec }` — big quality-of-life win for oncall-style workflows

**What's worth improving on:**
- OpenClaw crash-loops on dual systemd units (they just fixed this) — our single-process architecture avoids it
- Discord WS stale-socket reconnect churn — if we go Option A, we inherit this; if Option B, Anthropic eats it

---

## 4. Resume Continuity

This was flagged as load-bearing. Here's the mechanical truth.

### How resume works today (`packages/server/src/index.ts:241-289`)

```
Server boot
  → getPersistedSessions() returns running sessions from sessions.json
  → for each: createSession({ resumeSessionId: p.claudeSessionId, ... })
  → createSession → provider.buildArgs(options)
  → buildArgs → getSettings().channels → pushes --channels / --dangerously-load-development-channels
```

**Critical property**: `buildArgs` reads settings fresh every spawn. There's no "snapshot of channel flags at first-spawn" to go stale.

### What survives restart for each option

**Option A (DIY adapters):**
- autonomOS settings → adapter config → re-connects on boot via `initGateway()`
- Per-session routes in `settings.routes` (already exists in type) → restored via `setRoutes()`
- Works identically across restart ✅

**Option B (CC plugins):**
- `settings.channels` includes `plugin:telegram@claude-plugins-official` → re-applied on every spawn
- Credentials at `~/.claude/channels/telegram/.env` persist on host
- Sender allowlist at `~/.claude/channels/telegram/access.json` persists
- Pairing state: survives (it's in `access.json`)
- **What does NOT survive**: in-session permission grants (e.g. if a user paired mid-session without persisting). But pairing writes to disk, so even that's fine.

**Verdict: both options are resume-safe.** The current autonomOS persistence model (global settings, per-session metadata only) is **already** structured correctly for Option B — no schema changes required.

### Code changes required for each option

**Option B (MVP):**
```
packages/server/src/settings.ts          — no change (already supports channels[])
packages/server/src/providers/claude-code.ts  — no change (already wires flags)
packages/dashboard/src/panels/SettingsPanel.tsx  — ADD: channels section UI
docs/setup/channels.md                   — NEW: pairing flow how-to
```
Actual required code: **just the dashboard UI**. Everything else works today.

**Option A (adapter completion):**
```
packages/server/src/gateway/adapters/telegram.ts  — replace stub with grammY impl
packages/server/src/gateway/adapters/discord.ts   — replace stub with discord.js impl
packages/server/src/settings.ts          — ADD: gateway.telegram.botToken, gateway.discord.botToken
packages/server/src/gateway/index.ts     — already initGateway()-aware
packages/dashboard/src/panels/SettingsPanel.tsx  — ADD: adapter config UI
```
Plus tests, token rotation, error handling, rate limits. Several days minimum per adapter.

---

## 5. Spawning New Channels (Bonus)

Terry's question: "How can Claude Code spawn additional channels and hook them up to new sessions in autonomOS?"

### Current reality (CC's model)

- Channel plugins are **host-level**: installed once via `/plugin install X@claude-plugins-official`, credentials in `~/.claude/channels/X/.env`
- **Per-session activation**: each session's `--channels` list decides which installed plugins are active for that PTY
- **No runtime add**: a running session cannot add a new channel. You restart the session with updated `--channels`.

### autonomOS mapping

The global `settings.channels[]` applies to **every** spawned session. This is intentionally simple but coarse-grained: if Terry wants "only the AtlasFinanceOps team-lead has Telegram, nobody else," the global model doesn't express that.

### Proposed UX improvements (future work)

**Level 1 — global settings toggle (MVP):**
- Dashboard Settings → Channels section
- Checkbox per installed plugin (populated via `claude plugin list --json` or similar)
- Toggle writes to `settings.channels` → next spawn gets it

**Level 2 — per-template channels:**
- Template JSON adds `channels: string[]` field (merged with global)
- `create_agent(template: "support-lead")` inherits the template's channels
- Same mental model as `capabilities` today

**Level 3 — per-session override:**
- `create_agent({ channels: [...] })` parameter takes precedence
- MCP tool exposure: agents can spawn child agents with specific channel access

**Level 4 — runtime add (long-tail):**
- Requires session restart (CC limitation) — not worth building a "dynamic add" illusion
- Better: fork the session with new flags (`--fork-session` already supported)

Start with Level 1. Levels 2–3 become important when autonomOS hosts multiple customers/tenants.

### The "Claude Code spawns a new channel from inside a session"

**Answer: it can't, natively.** A running CC session has no MCP tool to install new channel plugins for itself or for a sibling session. This is a CC product gap, not an autonomOS one.

What autonomOS **could** do is expose an `install_channel(plugin, target_agent)` MCP tool that:
1. Installs the plugin at host level (`claude plugin install X` via subprocess)
2. Appends to target's channel list in our settings (or forks the target with new flags)

This is possible but low-ROI unless Terry has a specific use case driving it. Recommend deferring.

---

## 6. Recommendation

### Pick: **Option B for MVP → Option C (hybrid) if/when proactive outbound matters**

### Reasoning

1. **Option B is free.** We've already committed to CC channels architecturally (our `server:autonomos` IS a channel). The provider, settings, persistence, and auto-trust are all wired. MVP is dashboard UI + docs.

2. **The "outbound proactive" gap is narrow.** Today, every use case I can think of that autonomOS has in-flight (scheduled tasks, agent-to-agent comms, dashboard notifications) works with Option B:
   - Scheduled agent finishes a task → can reply to the Telegram DM that triggered it (plugin reply tool)
   - Cross-agent send stays within `agent://` URIs (gateway, unchanged)
   - Dashboard already sees everything via the observability fan-out
   The only genuine gap: **unsolicited alerts to a specific chat** (e.g., "every Monday 9am, tell the #general Discord channel the oncall rotation"). Deferrable.

3. **Permission relay is a killer feature we get for free.** The CC channel protocol supports `claude/channel/permission` — approve/deny tool use from Telegram on your phone. Rebuilding that in Option A is significant work we'd rather avoid.

4. **Research preview is a real risk, but managed.** Anthropic notes `--channels` syntax may change. Our provider is a single function; migrating to a new syntax is a one-line change. We shouldn't design around this risk; we should be ready to respond to it.

5. **Option C is the escape hatch.** When proactive outbound becomes a requirement, we complete the existing adapter stubs for *outbound only*. Inbound stays on CC plugins. This is the smallest marginal cost to unlock the missing capability without rebuilding inbound.

### What I'm NOT recommending (and why)

- **Pure Option A**: too much recreating of what Anthropic maintains, loses permission relay.
- **Pure Option D (extend server:autonomos)**: conceptually clean but duplicates the Telegram/Discord plumbing Anthropic already ships.

### Implementation phases

**Phase 1 (MVP) — ~1 day:**
- Install `telegram` and `discord` plugins on the autonomOS host
- Add a "Channels" section to dashboard Settings panel
  - List installed plugins (from `claude plugin list`)
  - Toggle to include/exclude from `settings.channels[]`
  - "Pair bot" instruction tooltip linking to CC docs
- README + `docs/setup/channels.md` for the end-to-end setup
- Test: restart server → spawned sessions receive Telegram inbound
- **Risk**: `channelsEnabled` org policy on Team plans. Document the admin flip.

**Phase 2 (proactive outbound) — ~3–5 days per platform, only if needed:**
- Flesh out `packages/server/src/gateway/adapters/telegram.ts` with grammY (outbound-only, just `send()`)
- Same for `discord.ts` with discord.js (REST `POST /channels/{id}/messages`, no WS intents needed for outbound-only)
- Credentials in `settings.gateway.telegram.botToken` (new fields) — can reuse the same bot token as the CC plugin
- Route `telegram://chat_id` and `discord://guild/channel` via existing `routeToPlatform()` (already in `router.ts:265`)
- No change to inbound — plugins continue to own it

**Phase 3 (nice-to-haves, later):**
- Per-template channel allowlists
- Scheduled task `delivery.channel` field (OpenClaw-inspired)
- Failure-alert routing (OpenClaw-inspired)
- Permission relay surfaced in dashboard UI (observability of pending approvals)

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| CC changes `--channels` syntax in research preview | Isolated in `providers/claude-code.ts:136-146`; one-line fix |
| `channelsEnabled` blocks on Team plans | Document admin flip; fall back to Option A if org refuses |
| Plugin pairing UX is clunky (user DMs bot, code, `/plugin:access pair`) | Document clearly; optionally automate via our own subprocess wrapper later |
| iMessage plugin is macOS-only | Out of scope for cloud deployments; surface as "only if running on Mac" |
| Prompt injection via channel | CC plugins already gate on sender allowlist; we rely on that |
| Research preview = potential removal | Low probability (Anthropic has invested a lot); monitor |

### Estimated effort

- **Phase 1 MVP**: ~1 engineer-day (dashboard UI, docs, manual testing)
- **Phase 2 outbound**: ~3 engineer-days per platform (probably Telegram first, Discord second)
- **Phase 3 polish**: opportunistic, 1–3 days of small PRs

---

## 7. Implementation Handoff (Phase 1 MVP)

**Scope**: Enable per-session Telegram and Discord channels via CC plugins, no autonomOS transport code.

### Files to touch

| File | Change |
|---|---|
| `packages/dashboard/src/panels/SettingsPanel.tsx` (or equivalent) | Add "Channels" section with toggles |
| `packages/server/src/api/channels.ts` (new) | API: `GET /api/channels/installed` (runs `claude plugin list --json`), `POST /api/channels/enable` (writes `settings.channels`) |
| `docs/setup/channels.md` (new) | End-to-end: install plugins, pair bot, verify inbound |
| `README.md` | Link to setup docs |

### Files NOT to touch

- `packages/server/src/providers/claude-code.ts` — flag wiring already correct
- `packages/server/src/settings.ts` — `channels[]` already supported
- `packages/server/src/persisted.ts` — resume already correct
- `packages/server/src/gateway/adapters/*` — Phase 2 territory

### Tests / success criteria

1. Install `telegram` plugin on host: `claude plugin install telegram@claude-plugins-official` completes without error
2. Configure token: `/telegram:configure <BotFather token>` inside a CC session, verify `~/.claude/channels/telegram/.env` is written
3. In dashboard Settings → Channels, enable Telegram
4. Spawn a new agent via dashboard — verify PTY spawn args include `--channels plugin:telegram@claude-plugins-official`
5. DM the bot from Telegram → pairing code appears in terminal
6. Run `/telegram:access pair <code>` in session → verify access gated to sender
7. Send a message from Telegram → agent receives `<channel source="telegram" ...>` event → replies via plugin tool → reply appears in Telegram
8. Restart `autonomos-server` → session auto-resumes → verify Telegram channel still active (second DM from your account reaches the agent)
9. Disable Telegram in Settings → new spawns lack `--channels` flag
10. Discord parity with steps 1–8 via `plugin:discord@claude-plugins-official`

### Edge cases the next worker should handle

- User enables Telegram in settings but hasn't installed the plugin yet → surface an actionable error ("Run `claude plugin install telegram@claude-plugins-official` first")
- `claude plugin list` fails or times out → show "Could not query installed plugins" with retry
- Phantom channel entry (e.g., stale `plugin:X` that's no longer installed) → warn, don't hard-fail spawn
- The autonomOS server itself needs `claude.ai` login (channels require it) — add to setup preflight

### Documentation to add

Create `docs/setup/channels.md`:
- Prerequisites: CC ≥ 2.1.80, claude.ai login, Bun installed, Team/Enterprise admin has flipped `channelsEnabled`
- Bot creation: BotFather for Telegram, Developer Portal for Discord
- Install + configure + pair flow
- Security reminders (allowlist-only, sender gating, prompt injection)
- Troubleshooting: bot doesn't respond, pairing code times out, sessions not receiving events

### Future worker — if Phase 2 gets greenlit

Start from `packages/server/src/gateway/adapters/stub.ts` — the protocol is already defined. Implement `connect`, `send`, leave `onMessage` no-op (inbound stays on plugins). Store tokens in settings with `anthropicAuthToken`-style encryption-at-rest pattern. Reference OpenClaw's offset persistence for Telegram long-polling *if* we extend to inbound.

---

## Appendix: Primary Sources

- [CC Channels overview](https://code.claude.com/docs/en/channels) — authoritative feature doc
- [CC Channels reference (build your own)](https://code.claude.com/docs/en/channels-reference) — MCP contract, permission relay, sender gating
- [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins) — Telegram, Discord, iMessage, fakechat plugin sources
- [`@anthropic-ai/claude-agent-sdk/sdk.d.ts`](../../packages/server/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.90_zod@4.3.6/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) — local SDK type defs for `channelsEnabled` / `allowedChannelPlugins`
- [`packages/server/src/providers/claude-code.ts:136-146`](../../packages/server/src/providers/claude-code.ts) — current flag wiring in autonomOS
- [`packages/server/src/channel-server/index.ts:187`](../../packages/server/src/channel-server/index.ts) — our own `claude/channel` capability declaration
- OpenClaw@homelab (async message, 2026-04-20) — OpenClaw UX reference
