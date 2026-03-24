#!/bin/bash
# autonomos-relay.sh — Generic hook relay for autonomOS dashboard
#
# Relays ALL Claude Code hook events to the autonomOS server.
# Only activates when AUTONOMOS_SERVER is set (i.e., sessions spawned
# by the dashboard). Sessions started outside autonomOS are unaffected.
#
# Install: copy to ~/.claude/hooks/ and register in settings.json
# for every hook event type with async: true.

# Exit silently if not running under autonomOS
[ -z "${AUTONOMOS_SERVER:-}" ] && exit 0
[ -z "${AUTONOMOS_SESSION_ID:-}" ] && exit 0

# Read event JSON from stdin (Claude Code pipes it)
EVENT_JSON=$(cat)

# Fire-and-forget POST to the server. Silent on failure, 2s timeout.
curl -sf --max-time 2 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$EVENT_JSON" \
  "${AUTONOMOS_SERVER}/api/hooks/${AUTONOMOS_SESSION_ID}" \
  >/dev/null 2>&1 &

exit 0
