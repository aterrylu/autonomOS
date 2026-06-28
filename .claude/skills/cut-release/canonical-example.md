# Canonical example — the `/release` transformation contract

This is the **source-of-truth few-shot anchor** for the `/release` skill. It is the
exact `v0.3.0` pair: the mechanical changelog body that
[`scripts/release-notes.ts`](../../../scripts/release-notes.ts) emits (the
"floor of correctness", see ADR-044), and the friendly themed/emoji body Terry
approved for the GitHub Release (the "ceiling of friendliness").

When you run `/release`, study this pair, then reproduce the **same kind of
transformation** on the new mechanical body. The OUTPUT below IS the spec — match
its structure, density, and tone. Do not try to be cleverer than it.

---

## INPUT — mechanical body (what `bun scripts/release-notes.ts` prints)

One concise line per unique PR, grouped by changeset severity (`### Minor
Changes` / `### Patch Changes`). This is the verbatim floor.

```markdown
### Minor Changes

- [#220](https://github.com/aterrylu/autonomOS/pull/220) `1446cc6` — feat!: remove view mode and non-xterm terminal renderers (xterm-only)
- [#228](https://github.com/aterrylu/autonomOS/pull/228) `ccf7e64` — feat(codex): per-agent app-server daemon + --remote TUI (inter-agent comm A1)
- [#231](https://github.com/aterrylu/autonomOS/pull/231) `ca49095` — feat(mcp): expose provider in create_agent (spawn Codex/Gemini agents)
- [#232](https://github.com/aterrylu/autonomOS/pull/232) `f6b2ad2` — feat: queue-send on usage-limit clear
- [#234](https://github.com/aterrylu/autonomOS/pull/234) `172ef43` — feat(gateway): native inbound for Codex agents (A2)
- [#236](https://github.com/aterrylu/autonomOS/pull/236) `1369058` — feat(codex): live agent status from the app-server event stream (A3)
- [#237](https://github.com/aterrylu/autonomOS/pull/237) `9b94bb7` — feat(codex): resume prior conversation across server/daemon restart (A5)
- [#239](https://github.com/aterrylu/autonomOS/pull/239) `67c440d` — feat(usage-queue): at-limit toggle button + timed simulation demo mode
- [#242](https://github.com/aterrylu/autonomOS/pull/242) `01531b8` — feat(dashboard): per-provider agent icons with settings picker

### Patch Changes

- [#208](https://github.com/aterrylu/autonomOS/pull/208) `06389b0` — fix(desktop): bundle runtime .mjs scripts into the server bundle
- [#209](https://github.com/aterrylu/autonomOS/pull/209) `290fe5c` — fix(server): re-deliver silently-dropped starting prompts via delivery receipt
- [#218](https://github.com/aterrylu/autonomOS/pull/218) `e711630` — fix(claude-usage): validate session key on save + honest, category-specific errors
- [#219](https://github.com/aterrylu/autonomOS/pull/219) `e8e8c77` — fix(claude-usage): query the chat org, not memberships[0]
- [#221](https://github.com/aterrylu/autonomOS/pull/221) `a8ff45a` — feat(claude-usage): zero-touch session via in-memory cookie harvest
- [#222](https://github.com/aterrylu/autonomOS/pull/222) `f58eace` — fix(dashboard): route OSC 52 copy through an insecure-context fallback
- [#224](https://github.com/aterrylu/autonomOS/pull/224) `1ae5bd5` — feat(dashboard): confirm OSC 52 auto-copy with a toast
- [#225](https://github.com/aterrylu/autonomOS/pull/225) `c269afe` — fix(dashboard): move copy toast to the bottom-right corner
- [#227](https://github.com/aterrylu/autonomOS/pull/227) `e4f033f` — fix(deploy): serve fresh dashboard on hosted deploys + staleness guardrail
- [#230](https://github.com/aterrylu/autonomOS/pull/230) `5b1855c` — fix(codex): run agents with danger-full-access (no bubblewrap)
- [#233](https://github.com/aterrylu/autonomOS/pull/233) `e0dc6ba` — fix(usage-queue): warn each pane on cred failure, not just the first
- [#235](https://github.com/aterrylu/autonomOS/pull/235) `5a97031` — feat(usage-queue): dev-gated usage-limit simulation control for demos
- [#243](https://github.com/aterrylu/autonomOS/pull/243) `a24b0a1` — fix(dashboard): show Codex live status in create-agent panel
```

This input has **22 unique PRs**. The OUTPUT below contains all 22 — none dropped,
none invented. That invariant is non-negotiable (see the skill's guardrail step).

---

## OUTPUT — friendly body (what `/release` writes to the GitHub Release)

Note the moves that turn the floor into the ceiling:

1. **A one-paragraph lede** naming the release's headline themes.
2. **Themed `## ` sections with a leading emoji** — grouped by *what the work does
   for the user*, NOT by changeset severity. Related PRs cluster (all the Codex
   work together, all the usage-limit work together) regardless of minor/patch.
3. **Each PR becomes a bullet**: a leading emoji, then
   `**[#NNN](url) — Short imperative title.**`, then one or two sentences of
   friendly, concrete explanation of what it does and why it matters.
4. **PRs reordered by theme**, not by number. Breaking changes are called out in
   prose (see #220).
5. **A `---` then the fixed footer** (install / desktop / auto-update / sign-off).
   This footer is stable boilerplate — reproduce it verbatim every release.

```markdown
A big release — Codex agents are now a first-class citizen alongside Claude Code, the dashboard handles Claude usage limits gracefully, copy-to-clipboard finally works on remote deployments, and a bunch of polish landed throughout.

## 🤖 Codex agents land as a first-class provider

Codex agents now behave like Claude Code agents in autonomOS — same dashboard, same status, same messaging.

- 🛠️ **[#228](https://github.com/aterrylu/autonomOS/pull/228) — Per-agent Codex daemon + `--remote` TUI.** Each Codex agent runs a dedicated `codex app-server` sidecar plus a `--remote` terminal — the foundation that everything else below builds on.
- 📬 **[#234](https://github.com/aterrylu/autonomOS/pull/234) — Codex agents can receive messages from other agents.** `send()` to a Codex agent now drops a message into its thread, just like a Claude Code agent.
- 🟢 **[#236](https://github.com/aterrylu/autonomOS/pull/236) — Live busy/idle status for Codex.** No more flat "running" — status icons reflect what the agent is actually doing.
- 💾 **[#237](https://github.com/aterrylu/autonomOS/pull/237) — Codex agents resume across server restarts.** Conversation and memory survive a daemon restart instead of forking into a fresh empty thread.
- 🔓 **[#230](https://github.com/aterrylu/autonomOS/pull/230) — Codex runs with full access (no bubblewrap).** Fixes the "could not find bubblewrap on PATH" warning on Linux. autonomOS is the trust boundary.
- 🎯 **[#243](https://github.com/aterrylu/autonomOS/pull/243) — Create-agent panel correctly shows Codex has live status.** The capability row was incorrectly hardcoded to "via hooks" — Codex sources status from its event stream instead.

## ✨ Spawn any provider from anywhere

- 🌐 **[#231](https://github.com/aterrylu/autonomOS/pull/231) — `create_agent` MCP tool now takes a `provider` field.** Agents (like Dispatcher) can spawn Codex or Gemini, not just Claude Code.
- 🎨 **[#242](https://github.com/aterrylu/autonomOS/pull/242) — Per-provider agent icons in the dashboard.** New "Agent Icons" setting picks between provider+status or status-only icons. Defaults to provider+status so you can tell agents apart at a glance.

## ⏰ Hit your Claude usage limit? autonomOS waits for you

- 🚦 **[#232](https://github.com/aterrylu/autonomOS/pull/232) — Queue-send on usage-limit clear.** Type your next prompt while capped, click the hourglass, and autonomOS hits Enter for you the moment the limit lifts — even with no dashboard open.
- 🔘 **[#239](https://github.com/aterrylu/autonomOS/pull/239) — At-limit toggle UI.** The button only appears when you're actually capped, with clear on/off state and a built-in simulation mode for demos.
- 🚨 **[#233](https://github.com/aterrylu/autonomOS/pull/233) — Per-pane credential-failure warnings.** Each armed pane now gets its own warning when credentials break, instead of only the first one.
- 🧪 **[#235](https://github.com/aterrylu/autonomOS/pull/235) — Dev/QA usage-limit simulation control.** Demo the queue-send feature without burning a real limit.

## 🔑 Claude Usage plugin is now zero-touch

- ✨ **[#221](https://github.com/aterrylu/autonomOS/pull/221) — Auto-detect your Claude session, no manual cookie paste.** Claude Code injects the cookie; a SessionStart hook relays it; the plugin uses it. Works on any install once an agent has run.
- ✅ **[#218](https://github.com/aterrylu/autonomOS/pull/218) — Validate your session key on save.** No more false "Saved!" for keys that don't actually work. Errors are categorized — credential vs transient — with the right action button.
- 🏢 **[#219](https://github.com/aterrylu/autonomOS/pull/219) — Query the right organization.** Fixes a 403 for anyone who's also used the Anthropic API — the plugin now picks the org with chat/Max access instead of `memberships[0]`.

## 📋 Copy from the terminal — even on remote deployments

- 🌍 **[#222](https://github.com/aterrylu/autonomOS/pull/222) — OSC 52 copy works on remote (plain-HTTP) deployments.** `navigator.clipboard` is undefined in insecure contexts; the dashboard now falls back to an off-screen `<textarea>` + `execCommand("copy")`.
- 🎉 **[#224](https://github.com/aterrylu/autonomOS/pull/224) — "Copied N chars" toast confirms auto-copy.** No more silent OSC 52 copies — you see when something hit the clipboard.
- 📍 **[#225](https://github.com/aterrylu/autonomOS/pull/225) — Toast moved to bottom-right corner.** Less visually intrusive.

## 🧹 Big cleanup — terminal-only

- 💥 **[#220](https://github.com/aterrylu/autonomOS/pull/220) — Removed "view mode" and all non-xterm renderers.** Terminal (xterm.js) is now the only view and the only renderer. The `/api/conversation` route, the Ghostty renderer, and 5 dead dependencies are gone — slimmer bundle, simpler mental model. (Breaking change: `terminalRenderer` setting is silently dropped.)

## 🩹 Reliability fixes

- 🪟 **[#208](https://github.com/aterrylu/autonomOS/pull/208) — Statusline + MCP channel-server bundle into the desktop app.** Two runtime-loaded scripts were missing from the bundle — desktop spawns silently lost statusline + agent messaging tools. Fixed with a manifest + boot-time warnings + smoke-test gate.
- 📨 **[#209](https://github.com/aterrylu/autonomOS/pull/209) — Silently-dropped starting prompts get re-delivered.** Delivery-receipt tracking re-injects the prompt via PTY paste when `UserPromptSubmit` never arrives. Auto-trust watcher uses needle-verified Enters now instead of blind bursts.
- 🚀 **[#227](https://github.com/aterrylu/autonomOS/pull/227) — Hosted deploys always serve a fresh dashboard.** `make prod` removes stale embedded artifacts; `make deploy` doesn't ship them; the server logs bundle ID + mtime; the dashboard warns when its tab is older than what the server is serving.

---

📦 **Install:** `curl -fsSL https://raw.githubusercontent.com/aterrylu/autonomOS/main/scripts/install.sh | sh && autonomos start`
🖥️ **Desktop app:** download the universal DMG from the assets below
🔄 **Auto-update users (v0.2.0):** the desktop app will update itself on next launch

Thanks for using autonomOS! 💛
```

---

## The fixed footer (reproduce verbatim every release)

Only the parenthetical version in the auto-update line changes — it names the
**previous** released version (here `v0.2.0`, since this is the `v0.3.0` body), so
existing desktop users know their build will self-update. Everything else is
stable boilerplate:

```markdown
---

📦 **Install:** `curl -fsSL https://raw.githubusercontent.com/aterrylu/autonomOS/main/scripts/install.sh | sh && autonomos start`
🖥️ **Desktop app:** download the universal DMG from the assets below
🔄 **Auto-update users (v<PREV>):** the desktop app will update itself on next launch

Thanks for using autonomOS! 💛
```
