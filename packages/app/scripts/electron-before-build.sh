#!/usr/bin/env bash
# electron-builder beforeBuild hook.
#
# Builds the autonomos-server bundle for the host platform and copies it
# into packages/app/resources/server/ where electron-builder's extraResources
# config picks it up.
#
# Triggered automatically when running `bun run build:dmg`.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)    PLATFORM=darwin-arm64 ;;
  Darwin/x86_64)   PLATFORM=darwin-x64 ;;
  Linux/x86_64)    PLATFORM=linux-x64 ;;
  Linux/aarch64)   PLATFORM=linux-arm64 ;;
  *)
    echo "[before-build] Unsupported host: $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac
echo "[before-build] Host platform: $PLATFORM"

cd "$REPO_ROOT"

echo "[before-build] Building dashboard..."
bun --filter @autonomos/dashboard build >/dev/null

echo "[before-build] Embedding dashboard..."
bun packages/server/build/embed-dashboard.ts >/dev/null

echo "[before-build] Building server bundle..."
bun packages/server/build/build-binary.ts >/dev/null

echo "[before-build] Copying server bundle to packages/app/resources/server/"
RESOURCES_DIR="$APP_DIR/resources/server"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR"
cp -R "$REPO_ROOT/packages/server/dist/$PLATFORM/." "$RESOURCES_DIR/"

echo "[before-build] ✓ Server bundle ready at $RESOURCES_DIR"
ls -la "$RESOURCES_DIR" | head -10
