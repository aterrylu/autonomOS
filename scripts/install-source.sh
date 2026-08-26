#!/usr/bin/env bash
# Managed-clone (source mode) installer — ADR-077.
#
# Creates (or adopts) a git clone pinned to a release tag, marks it as a
# source-mode install (install.json at the repo root), and hands off to
# `make prod` to build + supervise. After this, `autonomos upgrade` and
# `autonomos rollback` manage the clone: fetch tags → dirty-tree refusal →
# checkout → rebuild → health-gated restart.
#
# This is the upgradeable replacement for rsync-based `make deploy` (which
# ships a working tree with no git history — no provenance, no rollback).
#
# Usage:
#   bash scripts/install-source.sh [--ref vX.Y.Z] [--dir DIR] [--repo URL]
#
#   --ref    Release tag to install (default: newest vX.Y.Z tag)
#   --dir    Where the managed clone lives (default: ~/autonomos)
#   --repo   Clone URL (default: https://github.com/aterrylu/autonomOS.git)
#
# Requires: git, bun (https://bun.sh), node 20+.

set -euo pipefail

# ── operator-config migration (.env) ──────────────────────────────────────
# INVARIANT (Terry, 2026-08-26, after the forge lockout): an upgrade or
# migration must NEVER change what token the daemon accepts without saying
# so. The old install shape kept operator config — above all AUTONOMOS_TOKEN
# — in a `.env` inside the install tree, and the service wrapper loads it
# via `tsx --env-file=<repo>/.env`. A fresh clone has no `.env`, so a naive
# migration silently switches the daemon to the $configDir/token file and
# every existing browser session 401s with no pointer to the new credential.
#
# Policy: AUTONOMOS_TOKEN is MIGRATED (login continuity is the default a
# user expects); every other key is dropped LOUDLY, listed by name with a
# restore hint — carrying unknown overrides forward silently would be the
# opposite bug (e.g. a stale AUTONOMOS_WS_COALESCE=0 pinning old transport
# behavior through every future upgrade). See the env-migration ADR.
#
# Args: OLD_TREE (the install this script was launched from) and CLONE_DIR.
# No-ops when there is nothing to migrate: no old .env, same tree, or the
# clone already has a .env (never overwrite operator config).
migrate_env_from_old_tree() {
  local old_tree="$1" clone_dir="$2"
  local old_env="$old_tree/.env" new_env="$clone_dir/.env"
  [[ -f "$old_env" ]] || return 0
  [[ "$(cd "$old_tree" && pwd -P)" != "$(cd "$clone_dir" && pwd -P)" ]] || return 0
  if [[ -e "$new_env" ]]; then
    echo "[install-source] $new_env already exists — leaving it untouched" >&2
    return 0
  fi

  # First effective (non-comment) assignment wins, mirroring how the daemon
  # reads it. Preserved verbatim — the value is a credential, never parsed.
  local token_line
  token_line=$(grep -m1 -E '^AUTONOMOS_TOKEN=' "$old_env" || true)

  # Every other effective key, by NAME only (values may be secrets).
  local dropped
  dropped=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$old_env" | cut -d= -f1 | grep -vx 'AUTONOMOS_TOKEN' | sort -u || true)

  if [[ -n "$token_line" ]]; then
    umask 077
    cat > "$new_env" <<EOF
# Migrated from $old_env by install-source.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# so your dashboard login keeps working across the install-shape change.
# Only AUTONOMOS_TOKEN is carried; other overrides were deliberately left
# behind (listed in the install output) — copy them here if you still need
# them.
$token_line
EOF
    echo "[install-source] ✓ Migrated AUTONOMOS_TOKEN from $old_env — your dashboard token is UNCHANGED."
  else
    echo "" >&2
    echo "⚠️  [install-source] $old_env exists but has no AUTONOMOS_TOKEN." >&2
    echo "    After this install the daemon resolves its token from" >&2
    echo "    \$AUTONOMOS_CONFIG_DIR/token (default ~/.autonomos/token) —" >&2
    echo "    if you logged in with an env-provided token before, that" >&2
    echo "    login will stop working. Read the new token with:" >&2
    echo "      cat ~/.autonomos/token" >&2
  fi

  if [[ -n "$dropped" ]]; then
    echo "" >&2
    echo "⚠️  [install-source] These .env overrides were NOT migrated (reset" >&2
    echo "    to defaults — usually what you want after an upgrade):" >&2
    # shellcheck disable=SC2001
    echo "$dropped" | sed 's/^/      - /' >&2
    echo "    The old file is untouched at $old_env — copy any line you" >&2
    echo "    still need into $new_env and run: autonomos restart" >&2
  fi
}

# When sourced (tests), expose the functions and stop — no side effects.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# The install tree this script was launched FROM — the migration source when
# it differs from the clone target. Resolved before any cd.
LAUNCH_TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

REPO_URL="https://github.com/aterrylu/autonomOS.git"
CLONE_DIR="$HOME/autonomos"
REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)  REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --dir)  CLONE_DIR="$2"; shift 2 ;;
    --dir=*) CLONE_DIR="${1#--dir=}"; shift ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --repo=*) REPO_URL="${1#--repo=}"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "Error: git is required." >&2; exit 1; }
command -v bun >/dev/null 2>&1 || {
  echo "Error: bun is required (the build runs bun install + vite)." >&2
  echo "  Install: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

# ── clone or adopt ────────────────────────────────────────────────────────
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "[install-source] Adopting existing clone at $CLONE_DIR"
  # Refuse to adopt a clone with uncommitted tracked changes — the updater
  # will refuse on them forever after, so surface it at install time.
  # Two-step: run status first and check ITS exit — `status | grep || true`
  # would also swallow a FAILING git status (corrupt .git) and adopt a broken
  # repo as "clean".
  STATUS_OUT=$(git -C "$CLONE_DIR" status --porcelain) || {
    echo "Error: git status failed in $CLONE_DIR — repository may be corrupt." >&2
    exit 1
  }
  DIRTY=$(printf '%s' "$STATUS_OUT" | grep -v '^??' || true)
  if [[ -n "$DIRTY" ]]; then
    echo "Error: $CLONE_DIR has uncommitted changes to tracked files:" >&2
    echo "$DIRTY" | sed 's/^/  /' >&2
    echo "Commit, stash, or discard them, then re-run." >&2
    exit 1
  fi
  git -C "$CLONE_DIR" fetch --tags origin
elif [[ -e "$CLONE_DIR" ]]; then
  echo "Error: $CLONE_DIR exists but is not a git clone." >&2
  exit 1
else
  echo "[install-source] Cloning $REPO_URL → $CLONE_DIR"
  git clone "$REPO_URL" "$CLONE_DIR"
fi

# ── pick + checkout the release tag ───────────────────────────────────────
if [[ -z "$REF" ]]; then
  # `|| true`: zero matches exits grep 1 → pipefail would kill the script
  # here, making the explanatory error below unreachable.
  REF=$(git -C "$CLONE_DIR" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
  [[ -n "$REF" ]] || { echo "Error: no vX.Y.Z release tags found." >&2; exit 1; }
else
  # A managed clone is pinned to release TAGS — that's the provenance story
  # (a tag is a version with a name). Accepting `--ref main` here would
  # silently create the branch-tip deployment this mode exists to reject.
  REF="v${REF#v}"
  if ! [[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: --ref must be a release tag (vX.Y.Z), got: $REF" >&2
    echo "  Branch-tip deployments are what this mode replaces. For a dev" >&2
    echo "  checkout, clone normally and use git pull + make prod." >&2
    exit 64
  fi
  if ! git -C "$CLONE_DIR" rev-parse --verify --quiet "refs/tags/$REF" >/dev/null; then
    echo "Error: no tag $REF exists in the repository." >&2
    exit 1
  fi
fi
echo "[install-source] Checking out $REF"
git -C "$CLONE_DIR" checkout "$REF"

# ── carry operator config BEFORE the first boot ───────────────────────────
# Must run before `make prod` below: the wrapper loads <clone>/.env at start,
# so migrating after the boot would leave the daemon serving one token and
# the migrated file promising another until the next restart.
migrate_env_from_old_tree "$LAUNCH_TREE" "$CLONE_DIR"

# ── mark as a managed source install ──────────────────────────────────────
# The marker at the repo ROOT is what routes `autonomos upgrade` to the
# source backend (resolveInstall's bounded upward walk). A plain dev
# checkout never gets one — this script is the explicit opt-in.
cat > "$CLONE_DIR/install.json" <<EOF
{
  "mode": "source",
  "prefix": "$CLONE_DIR",
  "installedBy": "install-source.sh",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
# Validate the marker actually parses: a CLONE_DIR containing a quote or
# backslash would yield invalid JSON here, the install would print success,
# and the failure would surface much later as resolveInstall's
# "Cannot determine install shape" — deferred and misattributed. bun is
# already a hard requirement of this script.
(cd "$CLONE_DIR" && bun -e 'JSON.parse(require("fs").readFileSync("install.json", "utf8"))') || {
  echo "Error: the written install.json is not valid JSON — the clone path" >&2
  echo "likely contains characters that break the marker ($CLONE_DIR)." >&2
  echo "Move the clone to a plain path and re-run." >&2
  exit 1
}
echo "[install-source] ✓ Marked $CLONE_DIR as a managed source install"

# install.json must never show up as an untracked file in `git status` UI
# noise (it's ignored via .gitignore in the repo), but double-check so the
# dirty-tree refusal can't trip over our own marker.
if git -C "$CLONE_DIR" status --porcelain | grep -q "install.json"; then
  echo "Warning: install.json is not gitignored in this revision — the" >&2
  echo "updater ignores untracked files, so this is cosmetic, but consider" >&2
  echo "upgrading to a release that ignores it." >&2
fi

# ── build + supervise ─────────────────────────────────────────────────────
echo "[install-source] Building and starting (make prod)..."
make -C "$CLONE_DIR" prod

echo ""
echo "✓ Managed source install complete."
echo "  Clone:    $CLONE_DIR ($REF)"
echo "  Upgrade:  autonomos upgrade      (fetch tags, checkout, rebuild, verified restart)"
echo "  Rollback: autonomos rollback"
