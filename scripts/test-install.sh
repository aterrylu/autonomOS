#!/usr/bin/env bash
# Hermetic test of the install + CLI lifecycle.
#
# Runs in CI (.github/workflows/test-install.yml) and locally. Builds the
# bundle, computes SHA256SUMS, points install.sh at file:// URLs, installs to
# an isolated prefix, exercises status/start/stop, upgrade/rollback, then
# cleans up.
#
# HERMETICITY IS ENFORCED, NOT ASSUMED — three layers, each earned by an
# incident (three real-daemon kills, 2026-08-08/09; see the test-label ADR):
#
#   1. $HOME redirect (2026-08-08): the CLI's service lookups resolve files
#      against $HOME; a stop step with the real $HOME booted out the LIVE
#      daemon. The redirect covers EVERY step after the build.
#   2. Test-only service label (2026-08-09, THE containment): file isolation
#      is not a supervisor boundary — `launchctl unload <file>` addresses the
#      job by the LABEL inside the file, and the per-user launchd namespace
#      is global, so uninstall-service on a test-prefix plist carrying the
#      production label killed the real daemon TWICE despite layer 1.
#      AUTONOMOS_SERVICE_LABEL makes every unit this harness writes and every
#      verb target address com.autonomos.daemon.test; assert_only_test_label
#      enforces it BEFORE each verb (after is dead code — the dying daemon
#      kills this script's own PTY: the guard shares fate with the victim).
#   3. assert_real_daemon_untouched: read-only probe of the REAL daemon after
#      each step (detection + best-effort restore). This is the ONLY place
#      the production label may appear in this script, and only ever as a
#      read-only `print`/`is-active` — never in a mutating verb.

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
  # Reap any pm2 God Daemon the run spawned under the throwaway home. ANY
  # pm2 CLI invocation (even a read-only `pm2 jlist` from install-service's
  # pm2 detection) auto-spawns a daemon keyed to $HOME/.pm2 — with HOME
  # redirected, that daemon outlives the script as an orphan (observed
  # 2026-08-09: two God Daemons homed at $TEST_PREFIX/home/.pm2, killed
  # manually). `pm2 kill` via PM2_HOME is the clean path; the pkill fallback
  # matches the daemon's argv, which embeds its unique PM2_HOME path — never
  # a broad pattern that could touch the real ~/.pm2 daemon.
  if [[ -d "$TEST_PREFIX/home/.pm2" ]]; then
    PM2_HOME="$TEST_PREFIX/home/.pm2" pm2 kill >/dev/null 2>&1 || true
    pkill -f "God Daemon ($TEST_PREFIX/home/.pm2)" 2>/dev/null || true
  fi
  rm -rf "$TEST_PREFIX" "$TEST_CFG" "$ROOT/packages/server/dist/SHA256SUMS" 2>/dev/null || true
  [[ -n "$STUB_DIR" ]] && rm -rf "$STUB_DIR"
  [[ -n "$FIXTURE_DIR" ]] && rm -rf "$FIXTURE_DIR"
  [[ -n "$FIXTURE_PID" ]] && kill "$FIXTURE_PID" 2>/dev/null || true
  [[ -n "$SVR" ]] && kill -9 "$SVR" 2>/dev/null || true
}
trap 'rc=$?; if [[ $rc -ne 0 ]] && [[ -f "$SERVER_LOG" ]]; then echo ""; echo "=== server log (failure dump) ==="; tail -50 "$SERVER_LOG"; echo "================================="; fi; cleanup; exit $rc' EXIT
# Convert signals into a normal exit so the EXIT trap (and its pm2 reap)
# still runs when the script dies mid-run — a bare SIGHUP/SIGTERM would skip
# it, which is exactly how the 2026-08-09 orphans escaped: the script's PTY
# died and cleanup never fired.
trap 'exit 129' HUP INT TERM

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
REAL_PID=""
# The PID matters, not just "loaded": the upgrade path's destructive verb is
# `launchctl kickstart -k` / `systemctl restart` — a RESTART of the real
# daemon (killing every agent PTY) leaves the job loaded, so a loaded-only
# check would pass silently. An unchanged PID proves neither bootout NOR
# restart happened.
case "$(uname -s)" in
  Darwin)
    if launchctl print "gui/$REAL_UID/com.autonomos.daemon" >/dev/null 2>&1; then
      REAL_JOB_LOADED=1
      REAL_PID=$(launchctl print "gui/$REAL_UID/com.autonomos.daemon" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')
    fi
    ;;
  Linux)
    if systemctl --user is-active autonomos.service >/dev/null 2>&1; then
      REAL_JOB_LOADED=1
      REAL_PID=$(systemctl --user show -p MainPID --value autonomos.service 2>/dev/null)
    fi
    ;;
esac

rm -rf "$TEST_PREFIX" "$TEST_CFG"
mkdir -p "$TEST_PREFIX/home" "$TEST_CFG"
export HOME="$TEST_PREFIX/home"
export XDG_CONFIG_HOME="$HOME/.config"
export AUTONOMOS_CONFIG_DIR="$TEST_CFG"

# ── test-only service label (THE containment; see the test-label ADR) ────
# HOME/path isolation is NOT a supervisor boundary: `launchctl unload <file>`
# reads only the Label from the file and then unloads whatever loaded job
# carries that label — the per-user launchd namespace is global, so a
# test-prefix unit carrying the production label takes down the REAL daemon
# (it did, three times, 2026-08-08/09). With this override every unit this
# harness writes — and every launchctl/systemctl target any CLI verb below
# computes — addresses `com.autonomos.daemon.test`, a job that does not
# exist in production. The assert below enforces it BEFORE each verb; an
# after-the-verb check is dead code, because unloading the real daemon kills
# the PTY running this script (the guard shares fate with the victim).
TEST_SERVICE_LABEL="com.autonomos.daemon.test"
PROD_SERVICE_LABEL="com.autonomos.daemon"
export AUTONOMOS_SERVICE_LABEL="$TEST_SERVICE_LABEL"

# Abort BEFORE any supervisor-reaching verb if a unit written by this harness
# resolves to the production identity. Exact label comparison — the test
# label contains the production label as a prefix, so substring grep proves
# nothing. Covers plists (Label value) and systemd units (identity is the
# FILENAME).
assert_only_test_label() {
  local step="$1" f label
  while IFS= read -r -d '' f; do
    case "$f" in
      *.plist)
        label=$(awk '/<key>Label<\/key>/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$f")
        if [[ "$label" == "$PROD_SERVICE_LABEL" ]]; then
          echo "✗ LABEL GUARD ($step): $f carries the PRODUCTION label '$label'." >&2
          echo "  Refusing to continue — a supervisor verb on this file would address the real daemon." >&2
          exit 1
        fi
        ;;
      *.service)
        if [[ "$(basename "$f")" == "autonomos.service" ]]; then
          echo "✗ LABEL GUARD ($step): $f is named 'autonomos.service' (production unit name)." >&2
          echo "  Refusing to continue — a systemctl verb would address the real service." >&2
          exit 1
        fi
        ;;
    esac
  done < <(find "$TEST_PREFIX" \( -name "*.plist" -o -name "*.service" \) -print0 2>/dev/null)
}

# Fails (and tries to restore) if a test step unloaded the operator's real
# daemon. Skips silently where no real daemon exists (CI). Detection is a
# backstop — the HOME redirect above is the actual guard.
assert_real_daemon_untouched() {
  local label="$1"
  [[ "$REAL_JOB_LOADED" == "1" ]] || return 0
  local now_pid=""
  case "$(uname -s)" in
    Darwin)
      # `|| true`: when the job is UNLOADED — the exact violation the branch
      # below reports and restores — launchctl exits nonzero, and under
      # set -e a plain (non-`local`) assignment inherits that status and
      # would kill the script BEFORE the restore path could run.
      now_pid=$(launchctl print "gui/$REAL_UID/com.autonomos.daemon" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}' || true)
      if [[ -n "$REAL_PID" && -n "$now_pid" && "$now_pid" != "$REAL_PID" ]]; then
        echo "✗ HERMETIC VIOLATION after '$label': the real daemon was RESTARTED (pid $REAL_PID → $now_pid)!" >&2
        echo "  A restart kills every agent PTY. The job is loaded, so nothing to restore — but this test step reached the real supervisor." >&2
        exit 1
      fi
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
      now_pid=$(systemctl --user show -p MainPID --value autonomos.service 2>/dev/null || true)
      if [[ -n "$REAL_PID" && -n "$now_pid" && "$now_pid" != "0" && "$now_pid" != "$REAL_PID" ]]; then
        echo "✗ HERMETIC VIOLATION after '$label': the real daemon was RESTARTED (pid $REAL_PID → $now_pid)!" >&2
        echo "  A restart kills every agent PTY. The service is active, so nothing to restore — but this test step reached the real supervisor." >&2
        exit 1
      fi
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
assert_only_test_label "autonomos stop"
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
    [[ -f "$TEST_PREFIX/Library/LaunchAgents/$TEST_SERVICE_LABEL.plist" ]] || {
      echo "✗ Plist not written (expected test-labeled filename)"; exit 1;
    }
    ;;
  Linux)
    [[ -f "$TEST_PREFIX/.config/systemd/user/$TEST_SERVICE_LABEL.service" ]] || {
      echo "✗ Unit not written (expected test-labeled filename)"; exit 1;
    }
    ;;
esac
echo "==> ✓ Service file written"
assert_real_daemon_untouched "install-service --no-activate"

# ── uninstall-service ────────────────────────────────────────────────────
echo "==> uninstall-service"
# uninstall-service is the verb that killed the real daemon twice on
# 2026-08-09: `launchctl unload <test-prefix plist>` addressed the job by
# the production LABEL inside the file. Assert BEFORE the verb.
assert_only_test_label "uninstall-service"
AUTONOMOS_CONFIG_DIR="$TEST_CFG" "$WRAPPER" uninstall-service \
  --prefix="$TEST_PREFIX"
case "$(uname -s)" in
  Darwin)
    [[ ! -f "$TEST_PREFIX/Library/LaunchAgents/$TEST_SERVICE_LABEL.plist" ]] || {
      echo "✗ Plist still present after uninstall"; exit 1;
    }
    ;;
  Linux)
    [[ ! -f "$TEST_PREFIX/.config/systemd/user/$TEST_SERVICE_LABEL.service" ]] || {
      echo "✗ Unit still present after uninstall"; exit 1;
    }
    ;;
esac
echo "==> ✓ Service file removed"
assert_real_daemon_untouched "uninstall-service"

# ── upgrade → rollback cycle (ADR-077) ───────────────────────────────────
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
assert_only_test_label "autonomos upgrade"
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
assert_real_daemon_untouched "autonomos upgrade"

echo "==> Re-running upgrade (should be up-to-date, no-op)"
UP_TO_DATE_OUT=$(AUTONOMOS_RELEASE_API_URL="http://127.0.0.1:$FIXTURE_PORT" \
  AUTONOMOS_RELEASE_REPO="test-rel/autonomos" \
  "$WRAPPER" upgrade)
echo "$UP_TO_DATE_OUT" | grep -q "Already on the latest" || {
  echo "✗ Second upgrade wasn't a no-op"; echo "$UP_TO_DATE_OUT"; exit 1;
}
echo "==> ✓ Up-to-date no-op OK"
assert_real_daemon_untouched "up-to-date upgrade no-op"

# ── supervisor-unit drift heal on the up-to-date path (ADR-080) ──────────
# Stage a supervised-install shape under the FAKE home: install-service
# --no-activate writes the unit file (no launchctl/systemctl), then a
# hand-mutation simulates an install-day template. The up-to-date upgrade
# path must self-heal it while PRESERVING the baked --port flag — the flag
# regression this feature exists to prevent. Hermetic-safe by construction:
# the up-to-date path never restarts anything, on darwin the sync issues
# ZERO supervisor commands, and on linux only a daemon-reload (which changes
# no service state). The staged unit is removed again before rollback so the
# rollback step's restart path keeps seeing "no supervisor" as before.
echo "==> Unit-sync drift heal (up-to-date upgrade path, ADR-080)"
"$WRAPPER" install-service --no-activate --force --bin="$WRAPPER" --port=4321
case "$(uname -s)" in
  Darwin) UNIT_FILE="$HOME/Library/LaunchAgents/$TEST_SERVICE_LABEL.plist" ;;
  *)      UNIT_FILE="$HOME/.config/systemd/user/$TEST_SERVICE_LABEL.service" ;;
esac
[[ -f "$UNIT_FILE" ]] || { echo "✗ Staged unit not written at $UNIT_FILE"; exit 1; }
case "$(uname -s)" in
  Darwin)
    perl -0pi -e 's/\s*<key>RunAtLoad<\/key>\s*<true\/>//' "$UNIT_FILE"
    if grep -q "RunAtLoad" "$UNIT_FILE"; then
      echo "✗ Drift staging failed (RunAtLoad still present)"; exit 1;
    fi
    ;;
  *)
    sed -i '/^StartLimitIntervalSec=0$/d' "$UNIT_FILE"
    if grep -q "StartLimitIntervalSec" "$UNIT_FILE"; then
      echo "✗ Drift staging failed (StartLimitIntervalSec still present)"; exit 1;
    fi
    ;;
esac
assert_only_test_label "unit-sync drift heal"
HEAL_OUT=$(AUTONOMOS_RELEASE_API_URL="http://127.0.0.1:$FIXTURE_PORT" \
  AUTONOMOS_RELEASE_REPO="test-rel/autonomos" \
  "$WRAPPER" upgrade)
echo "$HEAL_OUT" | grep -q "Supervisor unit re-rendered" || {
  echo "✗ Upgrade did not report the unit heal"; echo "$HEAL_OUT"; exit 1;
}
case "$(uname -s)" in
  Darwin)
    grep -q "RunAtLoad" "$UNIT_FILE" || {
      echo "✗ Healed plist is missing the current template's RunAtLoad"; exit 1;
    }
    ;;
  *)
    grep -q "^StartLimitIntervalSec=0$" "$UNIT_FILE" || {
      echo "✗ Healed unit is missing the current template's StartLimitIntervalSec=0"; exit 1;
    }
    ;;
esac
grep -q -- "--port=4321" "$UNIT_FILE" || {
  echo "✗ Install-time --port flag LOST by the heal (the ADR-080 flag-loss regression)"; exit 1;
}
rm -f "$UNIT_FILE"
echo "==> ✓ Unit healed to current template, --port preserved, staged unit removed"
assert_real_daemon_untouched "unit-sync drift heal"

echo "==> Running 'autonomos rollback'"
assert_only_test_label "autonomos rollback"
"$WRAPPER" rollback
ROLLED_BACK_VERSION=$("$WRAPPER" --version)
[[ "$ROLLED_BACK_VERSION" == "$INSTALLED_VERSION" ]] || {
  echo "✗ Expected $INSTALLED_VERSION after rollback, got: $ROLLED_BACK_VERSION"; exit 1;
}
echo "==> ✓ Rolled back to $INSTALLED_VERSION"
assert_real_daemon_untouched "autonomos rollback"

assert_real_daemon_untouched "full run"
echo ""
echo "✅ All install/CLI tests passed."
