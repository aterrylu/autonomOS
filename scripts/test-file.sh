#!/usr/bin/env bash
# Run one (or a few) server/script test files the safe way:
#
#   scripts/test-file.sh packages/server/src/__tests__/foo.test.ts [more files]
#
# - A default per-test timeout (TEST_TIMEOUT_MS, 5 min) plus --test-force-exit:
#   a test stuck on an await FAILS, named, and the process EXITS even if a
#   leaked handle (socket, server, timer) would keep it alive — the timeout
#   alone marks the test failed but leaves such a process running. Ad-hoc
#   `tsx --test <file>` runs have neither; when the agent's shell gave up on
#   one, its node child was left orphaned and hung for days (four seen at
#   once, 5-6 days old).
# - git's location variables stripped, as in `make check`: inside a git hook a
#   fixture `git init` would otherwise act on the real repo (core.bare flip).
#
# It does NOT take the machine-wide slot: one file is light. Full runs use
# `make check`, load runs `make load-test`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
  -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_PREFIX -u GIT_NAMESPACE \
  "$ROOT/packages/server/node_modules/.bin/tsx" --test --test-force-exit \
  --test-timeout="${TEST_TIMEOUT_MS:-300000}" "$@"
