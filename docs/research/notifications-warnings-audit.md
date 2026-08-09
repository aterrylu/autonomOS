# Notifications/Warnings Audit — Live Install (2026-08-08)

**Method:** Read the live rotating log (`~/.autonomos/logs/autonomos.log`, 12,395 lines) read-only, queried the running server's notification panel state (`GET /api/hooks/notifications`, read-only), and traced every observed warning to the code that executes it. The running artifact is tsx-from-source at `~/workspace/autonomOS` (launchd `com.autonomos.daemon`, pid 10748, up since Aug 3 00:34 UTC). The log spans several server builds; findings are classified against the **current uptime segment** (post line ~10588) unless noted.

**Headline:** The live notification panel holds **33 notifications — 100% `SystemWarning` — and every one is a false positive** from two receipt-verification mechanisms whose fixed grace windows race slow Claude Code TUI startup. Terry's instinct was right: these are (mostly) not real failures.

---

## REAL BUGS (fire when nothing is wrong / wrong behavior)

### 1. Prompt-delivery false alarms + confirmed DOUBLE-DELIVERY — `agents/promptDelivery.ts`
**Observed:** 10 of the 33 panel notifications (2 per agent: "Starting prompt was not submitted — re-delivered" + "Prompt re-delivery failed — the agent may be stuck and needs a manual nudge"). Fired for **every worker spawned this morning** (ReleaseTooling, ReleaseRollout, APIConsolidation, TerminalRender, PresetPillUI, NotificationsAudit). Historically ~15 more agents (DeliveryAck→#299, Shortcuts→#300, CapabilitiesDeprecate, …) were flagged "needs a manual nudge" and demonstrably completed their briefs.

**Direct proof of falseness:** the NotificationsAudit agent (the one writing this) is flagged "may be stuck" in the panel while executing its brief.

**Direct proof of double-delivery:** the NotificationsAudit agent received its starting brief **twice** — once as its opening prompt, once again mid-turn. The bracketed-paste fallback fired while the original CLI-arg prompt was still queued behind the booting TUI; both eventually submitted. The code's own comment says "double-submission is worse than a manual nudge" — and it is happening on every slow boot.

**Root cause (verified executing):** `SESSION_START_TIMEOUT_MS=15s` / `PROMPT_SUBMIT_TIMEOUT_MS=20s` / give-up +20s measure **TUI attach latency**, not delivery failure. Under a 6-agent concurrent spawn with a heavy plugin set, CC takes >40s from SessionStart (hook fires at process init) to input-attach (when the CLI-arg prompt actually submits). Log sequence for AppSecurityAudit: "giving up" → next lines: gateway connected + PermissionRequest. Auto-trust dialog dismissal ("channels … dismissed after 2 attempts") completes *before* the 20s warning, so dialogs aren't the whole latency — TUI/plugin boot is.

**The mechanism does catch real drops** — Shortcuts (57e5862c) had a genuinely dropped prompt and "prompt re-delivery confirmed (UserPromptSubmit)". So tune, don't delete.

**Proposed fix (M):**
- Don't paste on a fixed clock. Re-deliver only on a positive TUI-ready signal: auto-trust settled AND (new) a short quiet-period on PTY output — or at minimum pause/restart the 20s window when startup dialogs/usage-cap dialogs are known-active.
- Raise the give-up horizon (e.g. warn at 2–3 min, not 40s), and only push the `SystemWarning` if **no confirming hook event ever arrives** within that horizon — today any activity cancels tracking, so a longer window is nearly free.
- When a confirming event arrives after the paste's Enter already fired (the double-submit case), log a corrective line and (optionally) retract the panel notification (they're in-memory; removal is trivial).

### 2. Channel-server registration false alarm (mass spam on every restart) — `agents/runtime.ts` `scheduleChannelServerCheck`
**Observed:** 23 of the 33 panel notifications — "X can't send messages — its autonomos channel server never registered on the gateway". Fired for **18 agents at once** on the Aug 2 restart-all and 5 more on this morning's respawns. Log shows the lie directly: `57e5862c channel server never registered within 30000ms` followed 7 lines later by `agent 57e5862c… connected`.

**Root cause (verified executing):** one-shot 30s grace (`CHANNEL_SERVER_REGISTER_GRACE_MS`) starts at PTY spawn and races the same slow TUI boot as #1 (MCP subprocess launches only once CC is up; a ~20-agent thundering herd makes 30s routinely insufficient). The check is one-shot: it declares permanent failure ("outbound unavailable") on a transient state and never looks again.

**Proposed fix (S):**
- Re-probe instead of one-shot: check at 30s → if unregistered, re-check at 90s/180s; warn only after the final miss.
- Auto-retract: on the gateway registration edge for a previously-flagged agent, remove/annotate the panel notification and log "registered after Ns".
- (Optional) scale grace with concurrent-spawn count during boot sweeps.

### 3. One-time schedules >24.8 days out fire IMMEDIATELY — `scheduler.ts:290` `addOneTimeJob`
**Observed:** two `TimeoutOverflowWarning: 1347…ms does not fit into a 32-bit signed integer. Timeout duration was set to 1.` The two values differ by 3,659,380ms ≈ **61 minutes — exactly the gap between the two `shortcuts-*-relay` one-time schedules' recorded runs** (Jul 29 09:10:47 and 10:11:47). Both ran ~instantly and self-disabled (`fireAndDisableOneTime`).

**Root cause (verified in source):** `setTimeout(…, delayMs)` with unguarded `delayMs = target − now`. Past 2^31−1 ms (~24.86 days) Node clamps to 1ms → the schedule fires **now** instead of at its target, then disables itself — silent data loss of the scheduled intent, plus the message lands months early.

**Proposed fix (S):** chain-arm: if `delayMs > MAX_INT32`, `setTimeout(re-arm, MAX_INT32)` (or re-evaluate daily); optionally warn at create-time for absurd dates. ~10 lines + test.

### 4. `ERR_HTTP_HEADERS_SENT` ×5 — HTTP MCP serving via @hono/node-server
**Observed:** one historical cluster (log lines 4204–4240) bracketing a single "MCP session initialized/closed" — a double header write in `responseViaResponseObject` when an MCP client connected over HTTP. Zero occurrences in the current uptime.

**Classification:** real defect, low frequency, harmless so far (response raced, connection survived). **Flag for routing:** the fix sits in `mcp.ts`/route serving, which may be APIConsolidation's lane. Size S–M once reproduced with an MCP client against an isolated instance.

---

## NOISE-BUT-CORRECT (right condition, too loud)

### 5. `[claude-usage] usage fetch failed` — 111 occurrences ≈ 1,600 log lines (13% of the log)
Network-down/asleep periods make the usage poller log a full 15-line `impit` stack **every poll cycle**. Correct signal, terrible volume. **Fix (S):** log one line on the up→down edge, one on recovery; drop the stack (or log it once).

### 6. `[auto-trust] "channels" dialog not confirmed dismissed after 5 attempts — giving up`
Log-only; affected agents (Branding, CodexGemini, Dispatcher, TeamLead@Agents+DL) proceeded normally — the dialog was dismissed but the confirmation needle wasn't observed (TUI redraw timing). Leave, or tune the needle. Not in the panel.

### 7. Scheduler isolated-mode startup warning fires for a DISABLED schedule
`1 schedule(s) target the removed "isolated" mode and cannot run: pr-reviewer-deepseek-migration` — that schedule is `enabled: false` and `once:` in the past; it can never run regardless. Harmless once-per-boot line, but it nags about a no-op. **Fix (XS):** skip disabled schedules in the warning — or Terry just deletes the stale file. 

---

## LEGIT SIGNALS (leave as-is)

- `[gateway] agent "TeamLead" not found or not connected` (×16 total) — the truthful ADR-064 ack doing its job: senders using a wrong short name (`agent://TeamLead` instead of `agent://TeamLead@autonomOS`) or messaging a dead agent.
- `[prompt-delivery] … prompt re-delivery confirmed` (Shortcuts) — the mechanism catching a genuinely dropped prompt. This is why fix #1 tunes rather than deletes.
- `[hooks]` status transitions, `[gateway] connected/disconnected`, `[usage-queue] limit cleared → sent Enter` — informational, accurate, reasonable volume.
- `needs_input (notification_type=permission_prompt)` on bypass agents — MCP-approval prompts; expected (see codex-usage work).

## ALREADY FIXED — verified absent in current uptime
- **Template `autonomousMode` migration spam** (77 historical lines): `warnOncePerVersion` landed; 0 occurrences since the Aug 3 restart.
- **Codex prompt-delivery false "may have failed to boot"** (#287/ADR-057 capability gate): 0 occurrences in current segment.

## Cross-cutting observability gap
**The rotating log has no timestamps.** Every correlation in this audit had to be inferred from line adjacency. One-line fix in the log sink (prefix ISO timestamp); makes every future audit cheaper. Size XS. Recommended regardless of which fixes are picked.

---

## Summary table

| # | Item | Class | Panel impact | Size |
|---|------|-------|--------------|------|
| 1 | Prompt-delivery false alarm + double-delivery | Real bug | 10/33 today | M |
| 2 | Channel-server one-shot 30s false alarm | Real bug | 23/33 | S |
| 3 | One-time schedule int32 overflow → fires now | Real bug | 0 (silent) | S |
| 4 | ERR_HTTP_HEADERS_SENT on HTTP MCP | Real bug (rare) | 0 | S–M (route lane?) |
| 5 | Usage-poller stack spam | Noise-but-correct | 0 (log only) | S |
| 6 | Auto-trust dismiss-confirm miss | Noise-but-correct | 0 (log only) | XS–S |
| 7 | Isolated-mode warning for disabled schedule | Noise-but-correct | 0 (log only) | XS |
| 8 | Log has no timestamps | Observability gap | — | XS |

Fixing #1 + #2 alone removes 100% of the current notification-panel volume.
