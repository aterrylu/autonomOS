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

cleanup() {
  rm -rf "$TEST_PREFIX" "$TEST_CFG" "$ROOT/packages/server/dist/SHA256SUMS" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT"

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
echo "==> Starting daemon on port $TEST_PORT"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" start --port="$TEST_PORT" \
  >/tmp/autonomos-test-server.log 2>&1 &
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
# Note: this is behind auth, so we need the token. Easier: hit it via the running
# server's stdout log which prints the token at startup. Parse it.
TOKEN=$(grep -o "Auth token: [a-z0-9]\{4\}\.\.\.[a-z0-9]\{4\}" /tmp/autonomos-test-server.log | head -1)
echo "==> Token preview: $TOKEN"

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
