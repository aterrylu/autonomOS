#!/bin/bash
# autonomOS Agent Telemetry Hook
# Called by Claude Code on PreToolUse, PostToolUse, Notification, Stop events
# Receives hook JSON on stdin, POSTs to autonomOS server
#
# Install globally in ~/.claude/settings.json:
# {
#   "hooks": {
#     "PreToolUse":  [{"hooks": [{"type": "command", "command": "~/.claude/hooks/autonomos-telemetry.sh"}]}],
#     "PostToolUse": [{"hooks": [{"type": "command", "command": "~/.claude/hooks/autonomos-telemetry.sh"}]}],
#     "Notification": [{"hooks": [{"type": "command", "command": "~/.claude/hooks/autonomos-telemetry.sh"}]}],
#     "Stop":        [{"hooks": [{"type": "command", "command": "~/.claude/hooks/autonomos-telemetry.sh"}]}]
#   }
# }

AUTONOMOS_URL="${AUTONOMOS_URL:-http://localhost:3001}"

# Read hook input from stdin
input=$(cat)

# Fire-and-forget POST to autonomOS server (don't block the agent)
# TODO: What fields to extract vs forward raw?
#   Option A: Forward entire JSON blob (simple, but noisy — raw tool inputs can be huge)
#   Option B: Extract key fields (event, tool, session_id, timestamp) — lighter, but loses detail
#   Option C: Forward raw but with a size cap, truncate tool_input if > N bytes
curl -s -X POST "${AUTONOMOS_URL}/api/events" \
  -H "Content-Type: application/json" \
  -d "$input" \
  --max-time 2 \
  >/dev/null 2>&1 &

# Return empty JSON — don't interfere with the agent's behavior
echo '{}'
