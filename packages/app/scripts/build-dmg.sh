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
SUFFIX="${VERSION}-${SHA}-${TS}-arm64"

echo "[build-dmg] version=${VERSION} sha=${SHA} ts=${TS}"

# Detach any lingering autonomOS-* mounts from previous builds.
mount | awk -F' on ' '/autonomOS/ {print $2}' | awk '{print $1}' | while read -r mnt; do
  [ -n "${mnt}" ] || continue
  echo "[build-dmg] detaching lingering mount: ${mnt}"
  hdiutil detach "${mnt}" -force 2>/dev/null || true
done

rm -rf out
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
