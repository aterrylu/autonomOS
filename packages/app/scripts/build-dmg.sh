#!/usr/bin/env bash
# Build the DMG with a unique per-build suffix in the output filename AND
# in the volume title, then copy it to ~/Downloads with the same suffix
# so each iteration leaves a distinct file (no overwrites, easy to A/B).
#
# Naming scheme:
#   out/autonomOS-<version>-<sha>-<timestamp>-arm64.dmg
#   ~/Downloads/autonomOS-<version>-<sha>-<timestamp>-arm64.dmg
#
# Volume title (what shows up under /Volumes/ on mount):
#   "autonomOS <version> <sha>"
#
# Both the filename and the volume title carry the SHA, so a re-mount of
# an older DMG won't collide with a new build's mount path either.
#
# Pre-step: detach any lingering "autonomOS *" mounts before building, so
# the builder doesn't hit Exit code 16 from hdiutil.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # → packages/app/

VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo dev)
TS=$(date +%Y%m%d-%H%M%S)

# Detect uncommitted changes in tracked files. If the working tree is
# dirty, the SHA in the output filename would be a LIE — it'd be HEAD's
# SHA, but the build includes uncommitted modifications. Append "-dirty"
# to the filename so it's unambiguous.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  SHA="${SHA}-dirty"
fi

SUFFIX="${VERSION}-${SHA}-${TS}-arm64"

echo "[build-dmg] version=${VERSION} sha=${SHA} ts=${TS}"

# Detach any lingering autonomOS-* mounts from previous builds.
mount | awk -F' on ' '/autonomOS/ {print $2}' | awk '{print $1}' | while read -r mnt; do
  [ -n "${mnt}" ] || continue
  echo "[build-dmg] detaching lingering mount: ${mnt}"
  hdiutil detach "${mnt}" -force 2>/dev/null || true
done

rm -rf out

# Stage the host-platform server bundle into resources/server/ so
# electron-builder's extraResources picks it up. Build it first if not
# already present.
HOST_PLATFORM="$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
SERVER_DIST="$(cd ../.. && pwd)/packages/server/dist/${HOST_PLATFORM}"
if [ ! -f "${SERVER_DIST}/index.js" ]; then
  echo "[build-dmg] Server bundle missing; building..."
  (cd ../.. && bun run build:binary)
fi
mkdir -p resources/server
rm -rf resources/server/*
cp -R "${SERVER_DIST}/." resources/server/
echo "[build-dmg] Staged server bundle from ${SERVER_DIST}"

bun run build:dmg

# electron-builder produces autonomOS-<version>-arm64.dmg by default —
# rename to include the SHA + timestamp for easy comparison.
DEFAULT_NAME="autonomOS-${VERSION}-arm64.dmg"
NEW_NAME="autonomOS-${SUFFIX}.dmg"
mv "out/${DEFAULT_NAME}" "out/${NEW_NAME}"

# Copy to Downloads with the suffixed name so each build is distinct.
DEST="${HOME}/Downloads/${NEW_NAME}"
cp "out/${NEW_NAME}" "${DEST}"

echo "[build-dmg] ✓ ${DEST}"
echo "[build-dmg]   size: $(du -h "${DEST}" | cut -f1)"
echo "[build-dmg]   volume title on mount: 'autonomOS ${VERSION}' (SHA is in filename only)"

# Auto-clean older DMGs in ~/Downloads with the same version prefix —
# keep only the 3 most recent so the folder doesn't accumulate. Older
# ones are deleted, not archived.
KEEP=3
PATTERN="${HOME}/Downloads/autonomOS-${VERSION}-*-arm64.dmg"
# shellcheck disable=SC2086  # we want glob expansion
TO_DELETE=$(ls -t ${PATTERN} 2>/dev/null | tail -n +$((KEEP + 1)))
if [ -n "${TO_DELETE}" ]; then
  echo "${TO_DELETE}" | while read -r f; do
    echo "[build-dmg]   pruning older: $(basename "${f}")"
    rm -f "${f}"
  done
fi
