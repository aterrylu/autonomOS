---
"@autonomos/server": patch
---

fix(notifications): kill the false-positive warning classes found by the live-install audit

The 2026-08-08 audit of Terry's running install found the notification panel
100% saturated with spurious SystemWarnings. This fixes the non-prompt-delivery
classes (prompt delivery is its own PR):

- **Channel-server "can't send messages" false alarm** — the one-shot 30s
  registration check flagged the entire resumed fleet on every restart-all
  (23 of 33 live panel notifications). Now probes on an escalating 30s/90s/180s
  schedule, warns only on the final miss, and RETRACTS the warning (new
  `retractSystemNotification`) with a corrective log line if the agent
  registers after all. Logic extracted to a testable `channelServerCheck` leaf
  module; the gateway reports the registration edge.
- **One-time schedules >24.8 days out fired immediately** — `setTimeout`'s
  int32 delay clamps to 1ms on overflow, so a far-future `once:` schedule ran
  at creation and self-disabled (observed live: two relay schedules months out
  ran instantly, TimeoutOverflowWarning in the log). Timers now chain through
  int32-sized hops.
- **Usage-poller offline stack spam** — an offline host wrote a 15-line
  network stack every poll cycle (~13% of the live rotating log). Failure
  logging is now edge-triggered: one line when a healthy poller starts
  failing, one line with the count when it recovers.
- **Scheduler nagged about a completed one-time `isolated` schedule** — the
  startup warning now skips one-time schedules that already fired and
  self-disabled (a completed artifact, not dormant intent); disabled-but-
  re-enableable ones still warn.
- **Rotating log now timestamps every line** (ISO-8601, file copy only —
  terminal echo stays clean). The audit had to reconstruct every event
  sequence from line adjacency; timestamps make the log correlatable.
