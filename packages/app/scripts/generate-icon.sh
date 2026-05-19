#!/usr/bin/env bash
# Regenerate packages/app/build-resources/icon.icns from the dashboard's
# favicon.svg using macOS native tools (qlmanage + sips + iconutil).
# No external deps; run from any subdirectory of the repo.
#
# When the favicon changes, run: bash packages/app/scripts/generate-icon.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SVG="${REPO_ROOT}/packages/dashboard/public/favicon.svg"
OUT="${REPO_ROOT}/packages/app/build-resources/icon.icns"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

if [[ ! -f "${SVG}" ]]; then
  echo "error: ${SVG} not found"
  exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: this script uses macOS-only tools (qlmanage, sips, iconutil)."
  echo "       on Linux, install librsvg + use rsvg-convert instead."
  exit 1
fi

# Rasterize SVG → 1024x1024 PNG (qlmanage's QuickLook SVG handler).
qlmanage -t -s 1024 -o "${WORK}" "${SVG}" >/dev/null 2>&1
SRC_PNG="${WORK}/favicon.svg.png"
if [[ ! -f "${SRC_PNG}" ]]; then
  echo "error: qlmanage failed to render ${SVG}"
  exit 1
fi

# Build the .iconset/ directory with the sizes iconutil expects.
ICONSET="${WORK}/autonomos.iconset"
mkdir -p "${ICONSET}"

resize() { sips -z "$1" "$1" "${SRC_PNG}" --out "${ICONSET}/$2" >/dev/null 2>&1; }

resize 16   icon_16x16.png
resize 32   icon_16x16@2x.png
resize 32   icon_32x32.png
resize 64   icon_32x32@2x.png
resize 128  icon_128x128.png
resize 256  icon_128x128@2x.png
resize 256  icon_256x256.png
resize 512  icon_256x256@2x.png
resize 512  icon_512x512.png
resize 1024 icon_512x512@2x.png

mkdir -p "$(dirname "${OUT}")"
iconutil -c icns "${ICONSET}" -o "${OUT}"

echo "✓ wrote ${OUT}"
echo "  size:    $(stat -f %z "${OUT}") bytes"
echo "  source:  ${SVG}"
