#!/usr/bin/env bash
# CI guard for "an agent's runaway process takes the whole server down".
#
# Real kernel, real user systemd, the REAL rendered unit, the REAL OomGuard
# (scripts/oom-isolation/fixture-server.ts). A drop-in caps the unit's memory
# so the OOM happens inside the unit only; the runner box is never under global
# pressure. Three runs, so the test proves on THIS machine that it can fail:
#
#   A  the unit as rendered + the guard → only the runaway agent dies; the
#      server (same PID, no restart) and the sibling agent survive
#   B  the PRE-FIX unit (no OOMPolicy, no Delegate) → systemd stops the WHOLE
#      unit (the reported bug: OOMPolicy=stop is systemd's default)
#   C  the unit as rendered, guard OFF → the kernel kills the SERVER (it holds
#      more memory than the agent), which is what the OOM score raise prevents
#
# B and C must show the failure, or the guard isn't testing anything.
#
# Only for CI or a throwaway box: it runs `systemctl --user` on its own TEST
# unit and nothing else. Never run it on a machine with a live autonomOS
# service you care about unless you've read it (standing rule).
set -euo pipefail

if [[ "${CI:-}" != "true" && "${OOM_ISOLATION_ALLOW:-}" != "1" ]]; then
  echo "refusing: CI-only (set OOM_ISOLATION_ALLOW=1 on a throwaway Linux box)" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "refusing: Linux only" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT="autonomos-oomci.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TSX="${OOM_CI_TSX:-$ROOT/packages/server/node_modules/.bin/tsx}"
WORK="$(mktemp -d /tmp/oomci.XXXXXX)"
CAP_MB="${OOM_CI_CAP_MB:-700}"
FAIL=0

uid="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"

cleanup() {
  systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  rm -rf "$UNIT_DIR/$UNIT" "$UNIT_DIR/$UNIT.d"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── preconditions: asserted, never assumed (a vacuous pass is the risk) ──
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "precondition: no user systemd manager (CI: enable linger first)" >&2
  exit 1
fi
[[ "$(stat -fc %T /sys/fs/cgroup)" == "cgroup2fs" ]] || { echo "precondition: cgroup v2 required" >&2; exit 1; }
user_cg="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service"
grep -qw memory "$user_cg/cgroup.controllers" || { echo "precondition: user manager has no memory controller delegated" >&2; exit 1; }
echo "systemd: $(systemctl --version | head -1); user manager controllers: $(cat "$user_cg/cgroup.controllers")"

install_unit() { # variant
  local variant="$1" out="$WORK/$1"
  mkdir -p "$out" "$UNIT_DIR/$UNIT.d"
  "$TSX" "$ROOT/scripts/oom-isolation/render-unit.ts" "$TSX" \
    "$ROOT/scripts/oom-isolation/fixture-server.ts" "$out" >"$UNIT_DIR/$UNIT"
  grep -q '^OOMPolicy=continue$' "$UNIT_DIR/$UNIT" || { echo "rendered unit lacks OOMPolicy=continue" >&2; exit 1; }
  grep -q '^Delegate=yes$' "$UNIT_DIR/$UNIT" || { echo "rendered unit lacks Delegate=yes" >&2; exit 1; }
  if [[ "$variant" == B ]]; then
    # The pre-fix unit. All three lines go: with Delegate=yes alone systemd
    # already defaults OOMPolicy to continue (systemd.service(5)), so
    # dropping only OOMPolicy wouldn't reproduce the bug (measured).
    sed -i -e '/^OOMPolicy=/d' -e '/^Delegate=/d' -e '/AUTONOMOS_CGROUP_DELEGATED/d' "$UNIT_DIR/$UNIT"
  fi
  {
    echo "[Service]"
    echo "MemoryMax=${CAP_MB}M"
    echo "MemorySwapMax=0"
    echo "Environment=OOM_FIXTURE_OUT=$out"
    [[ "$variant" == C ]] && echo "Environment=OOM_FIXTURE_GUARD=off"
    true
  } >"$UNIT_DIR/$UNIT.d/ci.conf"
  systemctl --user daemon-reload
}

run_variant() { # variant expectation
  local v="$1" out="$WORK/$1"
  install_unit "$v"
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user start "$UNIT"
  local pid0=""
  for _ in $(seq 1 40); do
    [[ -f "$out/pids.json" ]] && break
    sleep 0.5
  done
  [[ -f "$out/pids.json" ]] || { echo "[$v] fixture never started"; journalctl --user -u "$UNIT" -n 30 --no-pager || true; return 1; }
  pid0="$(systemctl --user show "$UNIT" -p MainPID --value)"
  local server
  server="$(json "$out/pids.json" server)"
  # Wait for the outcome: the fixture's result, the server dying, or systemd
  # giving up on the unit.
  for _ in $(seq 1 120); do
    [[ -f "$out/result.json" ]] && break
    kill -0 "$server" 2>/dev/null || break
    local res nr
    res="$(systemctl --user show "$UNIT" -p Result --value)"
    nr="$(systemctl --user show "$UNIT" -p NRestarts --value)"
    [[ "$res" == "oom-kill" || "$nr" != "0" ]] && break
    sleep 0.5
  done
  sleep 2
  # Taken NOW, before the stop below kills everything anyway.
  local alive=0
  kill -0 "$server" 2>/dev/null && alive=1
  local res nr state pid1
  res="$(systemctl --user show "$UNIT" -p Result --value)"
  nr="$(systemctl --user show "$UNIT" -p NRestarts --value)"
  state="$(systemctl --user show "$UNIT" -p ActiveState --value)"
  pid1="$(systemctl --user show "$UNIT" -p MainPID --value)"
  echo "[$v] unit: state=$state result=$res restarts=$nr mainpid $pid0→$pid1"
  [[ -f "$out/result.json" ]] && echo "[$v] fixture: $(cat "$out/result.json")"
  journalctl --user -u "$UNIT" --since "-3min" --no-pager -o cat 2>/dev/null | grep -E "OOM|oom|fixture" | tail -5 || true
  echo "[$v] first server process alive at outcome: $alive"
  printf '%s %s %s %s %s %s\n' "$state" "$res" "$nr" "$pid0" "$pid1" "$alive" >"$out/unit"
  systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
}

check() { # description condition-exit-code
  if [[ "$2" == 0 ]]; then echo "  ✓ $1"; else echo "  ✗ $1"; FAIL=1; fi
}

# json FILE KEY[.KEY…] → the value (a plain lookup; no expression evaluation).
json() {
  python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k]
print(d)' "$1" "$2"
}

# Assertions below must all report, not abort at the first failure.
set +e

# ── A: the real unit + guard ──
run_variant A
read -r state res nr pid0 pid1 alive <"$WORK/A/unit"
r="$WORK/A/result.json"
echo "A — the fix:"
[[ -f "$r" ]]; check "the fixture recorded the agent's exit (server alive to write it)" $?
if [[ -f "$r" ]]; then
  [[ "$(json "$r" agentA.signal)" == "SIGKILL" ]]; check "the runaway agent was SIGKILLed" $?
  [[ "$(json "$r" agentA.verdict)" == "oom" ]]; check "…and attributed to THAT agent as an OOM kill" $?
  [[ "$(json "$r" agentBAlive)" == "True" ]]; check "the sibling agent survived" $?
  # MainPID is tsx's wrapper; the server is the process pids.json named at start.
  [[ "$(json "$r" serverPid)" == "$(json "$WORK/A/pids.json" server)" ]]; check "the server is the same process that started (never restarted)" $?
fi
[[ "$state" == active && "$nr" == 0 && "$pid0" == "$pid1" && "$alive" == 1 ]]; check "the unit stayed up: active, no restart, same MainPID, server alive" $?

# ── B: without OOMPolicy (the bug) ──
run_variant B
read -r state res nr pid0 pid1 alive <"$WORK/B/unit"
echo "B — the bug reproduces with the pre-fix unit:"
[[ "$res" == oom-kill || "$nr" != 0 || "$pid0" != "$pid1" ]]; check "systemd stopped the whole unit (result=$res restarts=$nr)" $?

# ── C: guard off ──
run_variant C
r="$WORK/C/result.json"
read -r state res nr pid0 pid1 alive <"$WORK/C/unit"
echo "C — without the guard the kernel picks the server:"
[[ "$alive" == 0 ]]; check "the server process was the OOM victim" $?

if [[ "$FAIL" != 0 ]]; then
  echo "OOM isolation guard FAILED" >&2
  exit 1
fi
echo "OOM isolation guard passed (A survives; B and C show the failures it prevents)."
