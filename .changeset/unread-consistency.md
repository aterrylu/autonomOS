---
"@autonomos/server": patch
---

fix: unread (#num) badge and the bell panel now agree; codex turns show with content (F3)

The sidebar row's unread count and the notification bell panel read different
sets: the sidebar counted ALL unread events (Stop, Notification, PermissionRequest,
SendUserMessage, SystemWarning) while the panel filtered to SendUserMessage/
SystemWarning. So a Stop/Notification/PermissionRequest unread showed "N" on the
row and "No notifications" in the panel.

Now ONE predicate (isUserFacingNotification) gates BOTH surfaces:
- A raw turn-end `Stop` is withheld from both — it's activity, already surfaced by
  the working/idle status + lastActivityAt, not a notification. (CC-visible change:
  a CC agent's unread is now messages + warnings + permission-asks + notifications,
  no longer +1 per bare turn.)
- Notification and PermissionRequest are now SHOWN in the panel (previously a
  permission ask was a phantom count with an empty panel).

Codex (which fires no hooks) gets its turns counted the right way, superseding
#358's content-less Stop: at the working→idle boundary the gateway reads the
agent's reply off its rollout JSONL and appends it as a user-facing "AgentMessage"
notification, so a codex turn both counts AND shows with content — like a CC
SendUserMessage. Best-effort (no reply readable yet → no notification, never a
crash). The panel gained plain-language fallbacks for message-less events.
