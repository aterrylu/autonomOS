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
  DIRTY=$(git -C "$CLONE_DIR" status --porcelain | grep -v '^??' || true)
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
  REF=$(git -C "$CLONE_DIR" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  [[ -n "$REF" ]] || { echo "Error: no vX.Y.Z release tags found." >&2; exit 1; }
fi
echo "[install-source] Checking out $REF"
git -C "$CLONE_DIR" checkout "$REF"

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
