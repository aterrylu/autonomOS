#!/usr/bin/env bash
# Run a command with a whole-run wall-clock bound, in its OWN process group.
#
#   scripts/run-bounded.sh <seconds> <command> [args...]
#
# Used by scripts/ci-gate-lock.sh for the run that holds the machine-wide test
# slot. A pre-push gate's test runner once hung 48 min at 0% CPU (a test file
# finished but leaked a live handle) while HOLDING the slot: other agents
# queued behind it and a push gave up. Now, past the bound, the run's whole
# process group gets SIGTERM, then SIGKILL 10s later; the test files still
# running are named; and the exit code is 124, like timeout(1). The lock frees
# as soon as the holder exits.
#
# Portable: macOS has no setsid/timeout, so job control (set -m) gives the
# command its own process group.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <seconds> <command> [args...]" >&2
  exit 64
fi
BOUND=$1
shift

fired=$(mktemp "${TMPDIR:-/tmp}/run-bounded.XXXXXX")
cleanup() { rm -f "$fired"; }

# Our own termination stops the group AND the watchdog: a killed gate never
# leaves its test runner behind, and never leaves the watchdog's sleep holding
# the caller's output open (the reader hang described below). Installed BEFORE
# the command starts: a gate killed in the gap between starting the command
# and arming the trap would otherwise die bare and leave the group running.
# $pid/$watchdog are read when the trap FIRES; empty until set.
pid=""
watchdog=""
trap '[ -n "$pid" ] && kill -TERM -- -"$pid" 2>/dev/null; [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null; cleanup; exit 143' TERM INT HUP

owner=$$
set -m # background jobs get their own process group (pgid = their pid)
(
  # Parent-death watcher, INSIDE the command's group: if this runner dies
  # without running its trap (SIGKILL: a crash, or a parent killing the
  # gate's whole process group), the command's group would otherwise keep
  # running in its own group, holding the lock's fd and with no watchdog. The
  # watcher notices within a second and stops the group (itself included).
  (
    while kill -0 "$owner" 2>/dev/null; do sleep 1; done
    kill -KILL 0 2>/dev/null
  ) &
  exec "$@"
) &
pid=$!
set +m

(
  # The sleep must die WITH this watchdog: left running, it would hold the
  # caller's stdout/stderr open for the whole bound, so anything reading the
  # run's output (lefthook) would wait the full bound after every run.
  trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
  # Count the bound in 1s steps and leave as soon as the runner is gone: one
  # long sleep outlived a runner killed with SIGKILL (no trap), holding the
  # lock's fd and the caller's output for the whole bound.
  left=$BOUND
  while [ "$left" -gt 0 ]; do
    kill -0 "$owner" 2>/dev/null || exit 0
    sleep 1 &
    sleeper=$!
    wait "$sleeper"
    left=$((left - 1))
  done
  kill -0 "$pid" 2>/dev/null || exit 0
  echo fired >"$fired"
  {
    echo ""
    echo "[run-bounded] run exceeded ${BOUND}s; stopping its whole process group."
    stuck=$(ps -A -o pid=,pgid=,etime=,args= 2>/dev/null |
      awk -v g="$pid" '$2 == g' |
      grep -E '\.test\.(ts|tsx|mjs|js)' || true)
    if [ -n "$stuck" ]; then
      echo "[run-bounded] still running (a test that hangs, or finished but leaked a handle):"
      echo "$stuck" | cut -c1-300 | sed 's/^/[run-bounded]   /'
    fi
  } >&2
  kill -TERM -- -"$pid" 2>/dev/null
  sleep 10
  kill -KILL -- -"$pid" 2>/dev/null
) &
watchdog=$!

wait "$pid"
rc=$?
# Sweep what's left of the command's group: the parent-death watcher, and
# anything the command left running (a leaked test process holding the lock).
kill -KILL -- -"$pid" 2>/dev/null
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
if [ -s "$fired" ]; then
  cleanup
  echo "[run-bounded] stopped after the ${BOUND}s bound; the machine-wide slot is free again." >&2
  exit 124
fi
cleanup
exit "$rc"
