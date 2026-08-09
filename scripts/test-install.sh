#!/usr/bin/env bash
# Hermetic test of the install + CLI lifecycle.
#
# Runs in CI (.github/workflows/test-install.yml) and locally. Builds the
# bundle, computes SHA256SUMS, points install.sh at file:// URLs, installs to
# an isolated prefix, exercises status/start/stop, upgrade/rollback, then
# cleans up.
#
# HERMETICITY IS ENFORCED, NOT ASSUMED (2026-08-08 incident): $HOME is
# redirected to a throwaway dir for EVERY step after the build, because the
# CLI's service lookups (findInstalledService → launchctl bootout / systemctl
# stop) resolve service files against $HOME — a stop step running with the
# real $HOME boot(ed) out the operator's LIVE daemon. Guarding one section is
# not enough; the boundary is the whole script's environment. On top of the
# redirect, assert_real_daemon_untouched checks after every service-touching
# step that the operator's real daemon is still loaded (and attempts to
# restore it if a regression ever slips through).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PREFIX=/tmp/autonomos-install-test
TEST_CFG=/tmp/autonomos-install-cfg
TEST_PORT=7889
FIXTURE_PORT=7899
SERVER_LOG=/tmp/autonomos-test-server.log
STUB_DIR=""
FIXTURE_DIR=""
FIXTURE_PID=""
SVR=""

cleanup() {
  rm -rf "$TEST_PREFIX" "$TEST_CFG" "$ROOT/packages/server/dist/SHA256SUMS" 2>/dev/null || true
  [[ -n "$STUB_DIR" ]] && rm -rf "$STUB_DIR"
  [[ -n "$FIXTURE_DIR" ]] && rm -rf "$FIXTURE_DIR"
  [[ -n "$FIXTURE_PID" ]] && kill "$FIXTURE_PID" 2>/dev/null || true
  [[ -n "$SVR" ]] && kill -9 "$SVR" 2>/dev/null || true
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

# ── environment isolation (the hermeticity boundary) ─────────────────────
# Everything below runs the installed CLI, whose service operations resolve
# against $HOME. Snapshot the real daemon's state FIRST, then redirect HOME
# so no wrapper invocation can ever see the real service files. The build
# above deliberately ran with the real HOME (bun/vite caches live there).
REAL_HOME="$HOME"
REAL_UID=$(id -u)
REAL_JOB_LOADED=0
case "$(uname -s)" in
  Darwin)
    launchctl print "gui/$REAL_UID/com.autonomos.daemon" >/dev/null 2>&1 && REAL_JOB_LOADED=1
    ;;
  Linux)
    systemctl --user is-active autonomos.service >/dev/null 2>&1 && REAL_JOB_LOADED=1
    ;;
esac

rm -rf "$TEST_PREFIX" "$TEST_CFG"
mkdir -p "$TEST_PREFIX/home" "$TEST_CFG"
export HOME="$TEST_PREFIX/home"
export XDG_CONFIG_HOME="$HOME/.config"
export AUTONOMOS_CONFIG_DIR="$TEST_CFG"

# Fails (and tries to restore) if a test step unloaded the operator's real
# daemon. Skips silently where no real daemon exists (CI). Detection is a
# backstop — the HOME redirect above is the actual guard.
assert_real_daemon_untouched() {
  local label="$1"
  [[ "$REAL_JOB_LOADED" == "1" ]] || return 0
  case "$(uname -s)" in
    Darwin)
      if ! launchctl print "gui/$REAL_UID/com.autonomos.daemon" >/dev/null 2>&1; then
        echo "✗ HERMETIC VIOLATION after '$label': the real com.autonomos.daemon was unloaded!" >&2
        echo "  Attempting restore: launchctl bootstrap gui/$REAL_UID ..." >&2
        launchctl bootstrap "gui/$REAL_UID" "$REAL_HOME/Library/LaunchAgents/com.autonomos.daemon.plist" || true
        if launchctl print "gui/$REAL_UID/com.autonomos.daemon" >/dev/null 2>&1; then
          echo "  ✓ Restore succeeded — real daemon is loaded again." >&2
        else
          echo "  ✗ RESTORE FAILED — reload manually: launchctl bootstrap gui/$REAL_UID $REAL_HOME/Library/LaunchAgents/com.autonomos.daemon.plist" >&2
        fi
        exit 1
      fi
      ;;
    Linux)
      if ! systemctl --user is-active autonomos.service >/dev/null 2>&1; then
        echo "✗ HERMETIC VIOLATION after '$label': the real autonomos.service was stopped!" >&2
        echo "  Attempting restore: systemctl --user start autonomos.service" >&2
        systemctl --user start autonomos.service || true
        if systemctl --user is-active autonomos.service >/dev/null 2>&1; then
          echo "  ✓ Restore succeeded — real service is active again." >&2
        else
          echo "  ✗ RESTORE FAILED — start manually: systemctl --user start autonomos.service" >&2
        fi
        exit 1
      fi
      ;;
  esac
}

# ── install ──────────────────────────────────────────────────────────────

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
# No re-trap: cleanup() kills $SVR, and replacing the line-37 trap here would
# silently drop its failure-time server-log dump for everything below.

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
assert_real_daemon_untouched "autonomos stop"

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
assert_real_daemon_untouched "install-service --no-activate"

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
assert_real_daemon_untouched "uninstall-service"

# ── upgrade → rollback cycle (ADR-071) ───────────────────────────────────
# A fake v9.9.9 release (the real built tarball with a bumped version) served
# by a local HTTP stand-in for the GitHub releases API. Exercises the REAL
# `autonomos upgrade` end-to-end: fetch → SHA256 verify → atomic swap →
# marker rewrite, then `autonomos rollback` back.
#
# Service isolation comes from the script-wide $HOME redirect above — under
# the throwaway HOME, findInstalledService() finds nothing, so upgrade's
# restart path falls through to the pid-file branch (daemon stopped → no-op).
echo "==> Building fake v9.9.9 release fixture"
FIXTURE_DIR=$(mktemp -d)
REAL_TARBALL=$(basename "$(ls "$DIST"/autonomos-*.tar.gz | head -1)")
mkdir -p "$FIXTURE_DIR/bundle"
tar -xzf "$DIST/$REAL_TARBALL" -C "$FIXTURE_DIR/bundle"
node -e '
  const fs = require("fs");
  const f = process.argv[1] + "/package.json";
  const pkg = JSON.parse(fs.readFileSync(f, "utf-8"));
  pkg.version = "9.9.9";
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2));
' "$FIXTURE_DIR/bundle"
tar -czf "$FIXTURE_DIR/$REAL_TARBALL" -C "$FIXTURE_DIR/bundle" .
(cd "$FIXTURE_DIR" && shasum -a 256 "$REAL_TARBALL" > SHA256SUMS)

cat > "$FIXTURE_DIR/release-server.cjs" <<'FIXTURE'
// Local stand-in for the GitHub releases API + asset downloads.
const http = require("http");
const fs = require("fs");
const path = require("path");
const [dir, port, tarballName] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
http
  .createServer((req, res) => {
    if (req.url === "/repos/test-rel/autonomos/releases/latest") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tag_name: "v9.9.9",
          assets: [
            { name: tarballName, browser_download_url: `${base}/dl/${tarballName}` },
            { name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` },
          ],
        }),
      );
      return;
    }
    const dl = req.url.match(/^\/dl\/(.+)$/);
    if (dl) {
      const file = path.join(dir, dl[1]);
      if (fs.existsSync(file)) {
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.statusCode = 404;
    res.end("not found");
  })
  .listen(Number(port), "127.0.0.1", () => console.log("fixture up"));
FIXTURE
node "$FIXTURE_DIR/release-server.cjs" "$FIXTURE_DIR" "$FIXTURE_PORT" "$REAL_TARBALL" &
FIXTURE_PID=$!
for _ in $(seq 1 10); do
  curl -sf "http://127.0.0.1:$FIXTURE_PORT/repos/test-rel/autonomos/releases/latest" >/dev/null 2>&1 && break
  sleep 0.5
done

INSTALLED_VERSION=$("$WRAPPER" --version)
echo "==> Installed version: $INSTALLED_VERSION"
[[ -f "$TEST_PREFIX/share/autonomos/install.json" ]] || {
  echo "✗ install.json marker not written by install.sh"; exit 1;
}
grep -q '"mode": "bundle"' "$TEST_PREFIX/share/autonomos/install.json" || {
  echo "✗ install.json marker lacks bundle mode"; exit 1;
}
echo "==> ✓ install.json marker present"

echo "==> Running 'autonomos upgrade' against the fixture release"
AUTONOMOS_RELEASE_API_URL="http://127.0.0.1:$FIXTURE_PORT" \
  AUTONOMOS_RELEASE_REPO="test-rel/autonomos" \
  "$WRAPPER" upgrade
UPGRADED_VERSION=$("$WRAPPER" --version)
[[ "$UPGRADED_VERSION" == "9.9.9" ]] || {
  echo "✗ Expected version 9.9.9 after upgrade, got: $UPGRADED_VERSION"; exit 1;
}
[[ -d "$TEST_PREFIX/share/autonomos.previous" ]] || {
  echo "✗ .previous not kept after upgrade"; exit 1;
}
grep -q '"installedBy": "upgrade"' "$TEST_PREFIX/share/autonomos/install.json" || {
  echo "✗ upgrade did not rewrite the install.json marker"; exit 1;
}
echo "==> ✓ Upgraded $INSTALLED_VERSION → 9.9.9 (marker rewritten, .previous kept)"

echo "==> Re-running upgrade (should be up-to-date, no-op)"
UP_TO_DATE_OUT=$(AUTONOMOS_RELEASE_API_URL="http://127.0.0.1:$FIXTURE_PORT" \
  AUTONOMOS_RELEASE_REPO="test-rel/autonomos" \
  "$WRAPPER" upgrade)
echo "$UP_TO_DATE_OUT" | grep -q "Already on the latest" || {
  echo "✗ Second upgrade wasn't a no-op"; echo "$UP_TO_DATE_OUT"; exit 1;
}
echo "==> ✓ Up-to-date no-op OK"

echo "==> Running 'autonomos rollback'"
"$WRAPPER" rollback
ROLLED_BACK_VERSION=$("$WRAPPER" --version)
[[ "$ROLLED_BACK_VERSION" == "$INSTALLED_VERSION" ]] || {
  echo "✗ Expected $INSTALLED_VERSION after rollback, got: $ROLLED_BACK_VERSION"; exit 1;
}
echo "==> ✓ Rolled back to $INSTALLED_VERSION"

assert_real_daemon_untouched "full run"
echo ""
echo "✅ All install/CLI tests passed."
