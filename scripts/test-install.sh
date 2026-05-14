#!/usr/bin/env bash
# Hermetic test of the install + CLI lifecycle.
#
# Runs in CI (.github/workflows/test-install.yml) and locally. Builds the
# bundle, computes SHA256SUMS, points install.sh at file:// URLs, installs to
# an isolated prefix, exercises status/start/stop, then cleans up.
#
# Does NOT touch the user's real ~/.autonomos/, real ~/Library/LaunchAgents/,
# or real ~/.config/systemd/user/ — install-service runs with --no-activate
# under a test prefix.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PREFIX=/tmp/autonomos-install-test
TEST_CFG=/tmp/autonomos-install-cfg
TEST_PORT=7889
SERVER_LOG=/tmp/autonomos-test-server.log
STUB_DIR=""

cleanup() {
  rm -rf "$TEST_PREFIX" "$TEST_CFG" "$ROOT/packages/server/dist/SHA256SUMS" 2>/dev/null || true
  [[ -n "$STUB_DIR" ]] && rm -rf "$STUB_DIR"
}
trap 'rc=$?; if [[ $rc -ne 0 ]] && [[ -f "$SERVER_LOG" ]]; then echo ""; echo "=== server log (failure dump) ==="; tail -50 "$SERVER_LOG"; echo "================================="; fi; cleanup; exit $rc' EXIT

cd "$ROOT"

# ── claude stub for CI (provider validation requires `claude` in PATH) ───
# The runtime check in run.ts exits the server if claude-code can't be
# resolved. CI runners don't have claude installed. Provide a stub so the
# daemon can start; agent spawning would fail at runtime, but the lifecycle
# tests here don't spawn agents.
if ! command -v claude >/dev/null 2>&1; then
  STUB_DIR=$(mktemp -d)
  cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CI stub. The real Claude Code CLI isn't installed; this exists only so the
# server's provider validation passes.
echo "claude (test stub)"
STUB
  chmod +x "$STUB_DIR/claude"
  export PATH="$STUB_DIR:$PATH"
  echo "==> Installed claude stub at $STUB_DIR (CI environment without real Claude Code CLI)"
fi

# ── build ────────────────────────────────────────────────────────────────
echo "==> Building dashboard + bundle + tarball"
bun --filter @autonomos/dashboard build >/dev/null
bun packages/server/build/embed-dashboard.ts >/dev/null
TARBALL=1 bun packages/server/build/build-binary.ts >/dev/null

DIST="$ROOT/packages/server/dist"
(cd "$DIST" && shasum -a 256 autonomos-*.tar.gz > SHA256SUMS)

# ── install ──────────────────────────────────────────────────────────────
rm -rf "$TEST_PREFIX" "$TEST_CFG"
mkdir -p "$TEST_PREFIX" "$TEST_CFG"

echo "==> Running install.sh hermetically"
INSTALL_PREFIX="$TEST_PREFIX" \
  BUNDLE_URL="file://$DIST" \
  SKIP_INSTALL_SERVICE=1 \
  bash "$ROOT/scripts/install.sh"

WRAPPER="$TEST_PREFIX/bin/autonomos"
[[ -x "$WRAPPER" ]] || { echo "✗ Wrapper not found at $WRAPPER"; exit 1; }
echo "==> ✓ Wrapper installed at $WRAPPER"

# ── --help works ─────────────────────────────────────────────────────────
echo "==> Verifying --help"
"$WRAPPER" --help | grep -q "autonomos <command>" || {
  echo "✗ --help output didn't match"; exit 1;
}
echo "==> ✓ --help OK"

# ── start daemon in background ───────────────────────────────────────────
# AUTONOMOS_TOKEN overrides ~/.autonomos/token resolution, keeping the test
# hermetic from the user's real auth token (token file lives outside
# AUTONOMOS_CONFIG_DIR by design — it's per-machine, not per-worktree).
TEST_TOKEN="test-token-1c-hermetic-$$"
echo "==> Starting daemon on port $TEST_PORT"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" AUTONOMOS_TOKEN="$TEST_TOKEN" \
  "$WRAPPER" start --port="$TEST_PORT" >"$SERVER_LOG" 2>&1 &
SVR=$!
trap "cleanup; kill -9 $SVR 2>/dev/null || true" EXIT

# Wait for the daemon to start
for i in $(seq 1 30); do
  if AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" status >/dev/null 2>&1; then
    echo "==> ✓ Daemon up after ${i}s"
    break
  fi
  sleep 1
done

# ── status check ─────────────────────────────────────────────────────────
echo "==> Verifying status"
STATUS_OUT=$(AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" status)
echo "$STATUS_OUT" | grep -q "running" || {
  echo "✗ Status didn't report running"; echo "$STATUS_OUT"; exit 1;
}
echo "$STATUS_OUT" | grep -q "port:     $TEST_PORT" || {
  echo "✗ Status didn't report port $TEST_PORT"; echo "$STATUS_OUT"; exit 1;
}
echo "==> ✓ Status OK"

# ── HTTP probe ───────────────────────────────────────────────────────────
echo "==> HTTP probe /api/host"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/api/host")
[[ "$HTTP_CODE" == "200" ]] || { echo "✗ /api/host returned $HTTP_CODE"; exit 1; }
echo "==> ✓ /api/host returned 200"

# ── /api/system/version (Phase 1C addition) ──────────────────────────────
echo "==> Verifying /api/system/version"
VERSION_JSON=$(curl -sf -H "Authorization: Bearer $TEST_TOKEN" \
  "http://127.0.0.1:$TEST_PORT/api/system/version")
echo "  $VERSION_JSON"
echo "$VERSION_JSON" | grep -q '"version"' || {
  echo "  FAIL: /api/system/version did not return a version field"; exit 1;
}
echo "  ✓ /api/system/version OK"

# ── stop ─────────────────────────────────────────────────────────────────
echo "==> Stopping daemon"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" stop
sleep 1

# Confirm
STATUS_AFTER=$(AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" status || true)
echo "$STATUS_AFTER" | grep -q "not running" || {
  echo "✗ Status didn't transition to 'not running'"; echo "$STATUS_AFTER"; exit 1;
}
echo "==> ✓ Daemon stopped, status reports 'not running'"

# ── install-service --no-activate (don't load into real launchd/systemd) ─
echo "==> install-service --no-activate under test prefix"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" install-service \
  --prefix="$TEST_PREFIX" --no-activate --bin="$WRAPPER" --force
case "$(uname -s)" in
  Darwin)
    [[ -f "$TEST_PREFIX/Library/LaunchAgents/com.autonomos.daemon.plist" ]] || {
      echo "✗ Plist not written"; exit 1;
    }
    ;;
  Linux)
    [[ -f "$TEST_PREFIX/.config/systemd/user/autonomos.service" ]] || {
      echo "✗ Unit not written"; exit 1;
    }
    ;;
esac
echo "==> ✓ Service file written"

# ── uninstall-service ────────────────────────────────────────────────────
echo "==> uninstall-service"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" uninstall-service \
  --prefix="$TEST_PREFIX"
case "$(uname -s)" in
  Darwin)
    [[ ! -f "$TEST_PREFIX/Library/LaunchAgents/com.autonomos.daemon.plist" ]] || {
      echo "✗ Plist still present after uninstall"; exit 1;
    }
    ;;
  Linux)
    [[ ! -f "$TEST_PREFIX/.config/systemd/user/autonomos.service" ]] || {
      echo "✗ Unit still present after uninstall"; exit 1;
    }
    ;;
esac
echo "==> ✓ Service file removed"

echo ""
echo "✅ All install/CLI tests passed."
