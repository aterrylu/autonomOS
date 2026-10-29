#!/usr/bin/env bash
# Does an installed/built server BUNDLE really spawn an agent PTY?
#
#   scripts/smoke-bundle-spawn.sh <bundle-dir>
#
# Boots the bundle's own server (`node <bundle>/index.js start`, foreground) in
# a throwaway world: fake HOME, short temp config dir, random token, ephemeral
# loopback port. Spawns one agent whose `claude` is a stub that stays alive,
# and requires it to still be RUNNING ~3s later.
#
# Why: on macOS node-pty posix_spawn()s a separate `spawn-helper`. If the
# bundle ships it without +x, or points helperPath at the build machine's
# node_modules, every spawn fails ("posix_spawnp failed", or on Apple Silicon
# a child that dies at once), while install, start and status all look fine.
# test-install.sh never spawned an agent, so nothing caught it (#532).
#
# Never touches a real service: no launchd/systemd verbs, no :3100, the server
# is stopped by its exact PID.
set -euo pipefail

BUNDLE="${1:?usage: smoke-bundle-spawn.sh <bundle-dir>}"
BUNDLE="$(cd "$BUNDLE" && pwd)"
[[ -f "$BUNDLE/index.js" ]] || { echo "✗ no index.js in $BUNDLE"; exit 1; }

WORK="$(mktemp -d /tmp/aos-smk.XXXXXX)"     # short: the control socket path is capped
FAKE_HOME="$WORK/home"; CFG="$WORK/c"; STUB="$WORK/bin"; CWD="$WORK/cwd"
mkdir -p "$FAKE_HOME/.claude" "$CFG" "$STUB" "$CWD"
SVR=""
cleanup() {
  # Agents outlive a server stop by design (they resume), so stop the stub
  # agents themselves, by their recorded pids, before the server.
  if [[ -f "$WORK/agent-pids" ]]; then
    while read -r p; do kill "$p" 2>/dev/null || true; done <"$WORK/agent-pids"
  fi
  # The server runs in its own process group, so its probe children (which
  # can still write into the fake HOME) stop with it.
  if [[ -n "$SVR" ]]; then
    kill -TERM -- "-$SVR" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -- "-$SVR" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$SVR" 2>/dev/null || true
    wait "$SVR" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# A `claude` that stays alive only when spawned AS AN AGENT (every agent spawn
# passes --session-id) and records its pid so cleanup can stop it. Any other
# call (the server's version/runtime probes) answers and exits at once; a
# sleeping probe would outlive the server. Liveness is what's under test.
cat >"$STUB/claude" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ "\$a" == "--session-id" ]]; then
    echo \$\$ >>"$WORK/agent-pids"
    exec sleep 120
  fi
done
echo "2.1.999 (smoke stub)"
STUB
chmod +x "$STUB/claude"

PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
[[ "$PORT" != "3100" ]] || { echo "✗ refusing port 3100"; exit 1; }
TOKEN="smoke-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
LOG="$WORK/server.log"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ -x "$BUNDLE/spawn-helper" ]]; then
    echo "==> spawn-helper is executable"
  else
    echo "✗ $BUNDLE/spawn-helper is missing or not executable"; exit 1
  fi
fi

echo "==> Booting the bundle on 127.0.0.1:$PORT (isolated)"
# perl setpgrp: its own process group (macOS has no setsid(1)), for cleanup.
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' \
  env -u CLAUDE_CONFIG_DIR -u AUTONOMOS_INTERNAL_SOCKET \
  HOME="$FAKE_HOME" CLAUDE_CONFIG_DIR="$FAKE_HOME/.claude" \
  AUTONOMOS_CONFIG_DIR="$CFG" AUTONOMOS_TOKEN="$TOKEN" \
  PATH="$STUB:$PATH" \
  node "$BUNDLE/index.js" start --port="$PORT" --host=127.0.0.1 >"$LOG" 2>&1 &
SVR=$!

api() { curl -sf -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/host" >/dev/null 2>&1 && break
  kill -0 "$SVR" 2>/dev/null || { echo "✗ server exited during boot"; tail -40 "$LOG"; exit 1; }
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/host" >/dev/null || { echo "✗ server never answered"; tail -40 "$LOG"; exit 1; }

echo "==> Spawning an agent"
RESP="$(api -X POST "http://127.0.0.1:$PORT/api/agents" \
  -d "{\"name\":\"smoke\",\"provider\":\"claude-code\",\"workingDirectory\":\"$CWD\"}")" || {
  echo "✗ POST /api/agents failed"; tail -40 "$LOG"; exit 1; }
ID="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write((r.agent??r).id??"")' "$RESP")"
[[ -n "$ID" ]] || { echo "✗ no agent id in: $RESP"; exit 1; }

sleep 3
STATUS="$(api "http://127.0.0.1:$PORT/api/agents/$ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);process.stdout.write(String((r.agent??r).status))})')"
if [[ "$STATUS" != "running" ]]; then
  echo "✗ agent is '$STATUS' 3s after spawn (expected running): the PTY didn't stay up"
  grep -iE "posix_spawn|spawn-helper|EACCES|ENOENT|crash" "$LOG" | tail -10 || true
  exit 1
fi
if grep -qiE "posix_spawnp failed" "$LOG"; then
  echo "✗ server log shows posix_spawnp failed"; exit 1
fi
echo "==> ✓ agent $ID is running 3s after spawn (bundle spawns PTYs)"
