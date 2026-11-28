#!/usr/bin/env bash
# CI only: install the real Claude Code CLI for the L3 real-agent integration
# suites (agent-spawn-prompt, usage-queue, ... via helpers/test-server.ts),
# which spawn a real `claude` PTY against a mock Anthropic backend. Installing
# needs NO auth: they never call the real API (ANTHROPIC_BASE_URL points at the
# mock). Shared by test.yml's `check` and `node-floor` jobs so both run the
# same pinned CLI (ADR-163). Pinned for reproducibility; bump deliberately.
set -euo pipefail

CLAUDE_CODE_VERSION=2.1.168

if [[ -z "${CI:-}" ]]; then
  echo "ci-install-claude.sh: CI only (it installs globally and writes ~/.claude.json)" >&2
  exit 2
fi

npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# A freshly-installed claude shows a first-run onboarding/theme prompt that
# blocks the interactive PTY session (so SessionStart never fires). Seed the
# user config to mark onboarding complete, with the same fields a configured
# claude carries. Without this the L3 integration suite times out waiting for
# the first hook.
cat >"$HOME/.claude.json" <<JSON
{
  "hasCompletedOnboarding": true,
  "numStartups": 5,
  "theme": "dark",
  "lastOnboardingVersion": "${CLAUDE_CODE_VERSION}"
}
JSON
