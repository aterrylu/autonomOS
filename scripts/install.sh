#!/usr/bin/env bash
# autonomOS installer.
#
# Usage:
#   curl -fsSL https://autonomos.terrylu.cloud/install.sh | bash
#
# Environment variables:
#   VERSION               Install a specific release (e.g. VERSION=0.5.0) instead
#                         of the latest. Also the manual-downgrade path.
#   INSTALL_PREFIX        Install root (default: $HOME/.local)
#   BUNDLE_URL            Where to fetch release artifacts from (overrides VERSION;
#                         default: https://github.com/aterrylu/autonomOS/releases/latest/download)
#   SKIP_INSTALL_SERVICE  Skip running `autonomos install-service` post-install (test/CI)
#   SKIP_NODE_CHECK       Skip the node-version check (test/CI; the bundle still needs node)
#
# What it does:
#   1. Detect OS+arch via uname
#   2. Require node >= 20 (the bundle is a Node-runtime JS bundle, not a static binary)
#   3. Download autonomos-<platform>.tar.gz from the release
#   4. Verify SHA256 against SHA256SUMS in the same release
#   5. Extract to a staging dir, write install.json (the install-shape marker,
#      ADR-072), then atomically swap it in at $INSTALL_PREFIX/share/autonomos/
#      (an existing install is kept at share/autonomos.previous — `autonomos
#      rollback` swaps back)
#   6. Write a wrapper at $INSTALL_PREFIX/bin/autonomos that execs node + the bundle
#   7. First install: run `autonomos install-service` to set up the OS-native
#      daemon. Re-run on an existing install: restart the service into the new
#      bundle instead (re-running this script IS the supported upgrade fallback).

set -euo pipefail

INSTALL_PREFIX="${INSTALL_PREFIX:-$HOME/.local}"
if [[ -n "${VERSION:-}" ]]; then
  DEFAULT_BUNDLE_URL="https://github.com/aterrylu/autonomOS/releases/download/v${VERSION#v}"
else
  DEFAULT_BUNDLE_URL="https://github.com/aterrylu/autonomOS/releases/latest/download"
fi
BUNDLE_URL="${BUNDLE_URL:-$DEFAULT_BUNDLE_URL}"

# ── platform detection ────────────────────────────────────────────────────
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)   PLATFORM=darwin-arm64 ;;
  Darwin/x86_64)  PLATFORM=darwin-x64 ;;
  Linux/x86_64)   PLATFORM=linux-x64 ;;
  Linux/aarch64)  PLATFORM=linux-arm64 ;;
  *)
    echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac
echo "[install] Detected platform: $PLATFORM"

# ── node version check ────────────────────────────────────────────────────
if [[ "${SKIP_NODE_CHECK:-0}" != "1" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Error: Node.js is required.

The autonomOS bundle is a Node-runtime JS application (the static-binary path
is blocked on a Bun/node-pty ABI issue, tracked separately). Install Node 20+
via your package manager:

  macOS:    brew install node
  Linux:    https://nodejs.org/en/download/package-manager
EOF
    exit 1
  fi
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    echo "Error: node 20+ required (found $(node --version))" >&2
    exit 1
  fi
fi

# ── download ──────────────────────────────────────────────────────────────
TARBALL="autonomos-${PLATFORM}.tar.gz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[install] Downloading ${BUNDLE_URL}/${TARBALL}..."
curl -fsSL -o "$TMP/$TARBALL" "${BUNDLE_URL}/${TARBALL}"

echo "[install] Downloading SHA256SUMS..."
curl -fsSL -o "$TMP/SHA256SUMS" "${BUNDLE_URL}/SHA256SUMS"

# ── checksum verification ─────────────────────────────────────────────────
echo "[install] Verifying SHA256..."
# `|| true`: under set -o pipefail a no-match grep would kill the script
# before the explanatory error below can print.
EXPECTED=$(grep " ${TARBALL}\$" "$TMP/SHA256SUMS" | awk '{print $1}' || true)
if [[ -z "$EXPECTED" ]]; then
  echo "Error: ${TARBALL} not found in SHA256SUMS" >&2
  exit 1
fi
ACTUAL=$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "Error: checksum mismatch" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi
echo "[install] ✓ Checksum OK"

# ── extract (stage-and-swap, ADR-072) ─────────────────────────────────────
# Never extract over a live bundle: an overlay leaves files deleted between
# versions on disk forever (stale native addons, every old dashboard asset),
# and a half-written overlay under a running daemon serves mixed versions.
# Extract to a sibling staging dir, then swap with atomic renames — the same
# discipline `autonomos upgrade` uses. The displaced install stays at
# .previous for `autonomos rollback`.
INSTALL_DIR="$INSTALL_PREFIX/share/autonomos"
STAGE_DIR="$INSTALL_DIR.new"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
echo "[install] Extracting..."
tar -xzf "$TMP/$TARBALL" -C "$STAGE_DIR"

# The install-shape marker: the updater trusts this record instead of
# guessing from paths. Must be written BEFORE the swap so the bundle always
# describes itself.
cat > "$STAGE_DIR/install.json" <<EOF
{
  "mode": "bundle",
  "prefix": "$INSTALL_PREFIX",
  "installedBy": "install.sh",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

WAS_INSTALLED=0
if [[ -d "$INSTALL_DIR" ]]; then
  WAS_INSTALLED=1
  rm -rf "$INSTALL_DIR.previous"
  mv "$INSTALL_DIR" "$INSTALL_DIR.previous"
fi
# If this mv fails after the live dir was renamed away, nothing is at the
# live path and the wrapper is dead — restore the displaced install rather
# than exiting with only mv's terse error.
if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
  echo "Error: could not move the new bundle into place." >&2
  if [[ "$WAS_INSTALLED" == "1" ]]; then
    if mv "$INSTALL_DIR.previous" "$INSTALL_DIR" 2>/dev/null; then
      echo "  The previous install was restored and is still usable." >&2
    else
      echo "  Restore the previous install manually: mv $INSTALL_DIR.previous $INSTALL_DIR" >&2
    fi
  fi
  exit 1
fi
echo "[install] ✓ Installed to $INSTALL_DIR"
[[ "$WAS_INSTALLED" == "1" ]] && echo "[install]   (previous version kept at $INSTALL_DIR.previous — 'autonomos rollback' swaps back)"

# ── wrapper ───────────────────────────────────────────────────────────────
BIN_DIR="$INSTALL_PREFIX/bin"
WRAPPER="$BIN_DIR/autonomos"
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Auto-generated by autonomOS install.sh.
exec node "$INSTALL_DIR/index.js" "\$@"
EOF
chmod +x "$WRAPPER"
echo "[install] ✓ Wrote wrapper at $WRAPPER"

# ── PATH hint ─────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    cat <<EOF

⚠️  $BIN_DIR is not on your PATH.
   Add this to your shell rc (~/.zshrc, ~/.bashrc, etc.):

     export PATH="$BIN_DIR:\$PATH"

EOF
    ;;
esac

# ── pm2 migration (if applicable) ─────────────────────────────────────────
# Existing users who installed via `make prod` typically have pm2 at one of:
#   $HOME/.bun/bin/pm2     (bun add -g pm2 — the existing Makefile install path)
#   $HOME/.local/bin/pm2
#   /usr/local/bin/pm2
#   /opt/homebrew/bin/pm2
# Walk all of them; default PATH alone misses bun-installed pm2 in
# non-interactive shells like `curl install.sh | bash`.
find_pm2() {
  if command -v pm2 >/dev/null 2>&1; then echo "pm2"; return 0; fi
  for p in "$HOME/.bun/bin/pm2" "$HOME/.local/bin/pm2" "$HOME/.volta/bin/pm2" \
           "/usr/local/bin/pm2" "/opt/homebrew/bin/pm2"; do
    [[ -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

PM2_BIN="$(find_pm2 || true)"
PM2_MANAGED=0
if [[ -n "$PM2_BIN" ]] \
  && "$PM2_BIN" jlist 2>/dev/null | grep -q '"name":"autonomos"'; then
  PM2_MANAGED=1
fi

# Open the dashboard after install on an interactive terminal. The post-install
# step also no-ops the browser on headless boxes (no DISPLAY), so this is safe to
# pass on a server too. Opt out with AUTONOMOS_NO_OPEN=1.
OPEN_FLAG=""
if [[ -t 1 && "${AUTONOMOS_NO_OPEN:-0}" != "1" ]]; then OPEN_FLAG="--open"; fi

# A service file from a prior install means this run is an UPGRADE — restart
# the supervised daemon into the freshly swapped bundle instead of re-running
# install-service (which would refuse on the live daemon). This is what makes
# re-running the curl|sh one-liner a supported upgrade path.
SERVICE_INSTALLED=0
case "$(uname -s)" in
  Darwin) [[ -f "$HOME/Library/LaunchAgents/com.autonomos.daemon.plist" ]] && SERVICE_INSTALLED=1 ;;
  Linux)  [[ -f "$HOME/.config/systemd/user/autonomos.service" ]] && SERVICE_INSTALLED=1 ;;
esac

# Capture the install-service exit code (`|| RC=$?` keeps `set -e` from aborting
# here). Exit 3 = activated but the daemon isn't responding yet — we report that
# honestly rather than printing a "URL shown above" banner over a down daemon.
RC=0
if [[ "${SKIP_INSTALL_SERVICE:-0}" != "1" ]]; then
  if [[ "$PM2_MANAGED" == "1" ]]; then
    echo "[install] Detected existing pm2-managed autonomos. Migrating..."
    "$WRAPPER" migrate-from-pm2 $OPEN_FLAG || RC=$?
    [[ "$RC" == "0" ]] && echo "[install] ✓ Migration complete."
  elif [[ "$SERVICE_INSTALLED" == "1" ]]; then
    echo "[install] Existing service detected. Restarting into the new bundle..."
    "$WRAPPER" restart || RC=$?
    if [[ "$RC" == "0" ]]; then
      HEALTHY=0
      for _ in $(seq 1 15); do
        if "$WRAPPER" status >/dev/null 2>&1; then HEALTHY=1; break; fi
        sleep 1
      done
      if [[ "$HEALTHY" == "1" ]]; then
        echo "[install] ✓ Daemon restarted on the new version."
      else
        echo "[install] ⚠️  Daemon not responding after restart — check 'autonomos status' / 'autonomos logs'." >&2
        RC=3
      fi
    fi
  else
    echo "[install] Running 'autonomos install-service'..."
    "$WRAPPER" install-service $OPEN_FLAG || RC=$?
  fi
fi

echo ""
if [[ "${SKIP_INSTALL_SERVICE:-0}" == "1" ]]; then
  echo "✓ autonomOS installed."
  echo "  Binary:  $WRAPPER"
  echo "  Bundle:  $INSTALL_DIR"
  echo "  Start it: autonomos install-service   (then: autonomos status)"
elif [[ "$RC" == "0" ]]; then
  echo "✓ autonomOS installed and running."
  echo "  Binary:  $WRAPPER"
  echo "  The dashboard URL + token are shown above."
  echo "  Manage:  autonomos status · autonomos logs -f · autonomos restart"
else
  echo "⚠️  autonomOS installed, but the daemon isn't responding yet."
  echo "  Binary:  $WRAPPER"
  echo "  Check:   autonomos status   and   autonomos logs"
  exit "$RC"
fi
