#!/usr/bin/env bash
# Download a portable Node.js runtime and stage it into resources/node/ so
# electron-builder bundles it into the .app's Resources/ at build time.
# This gives brand-new Macs a zero-prerequisite experience for the Built-in
# server flow — no `brew install node` required.
#
# Outputs:
#   resources/node/bin/node     (~50MB stripped binary)
#
# At runtime, server-supervisor.ts prefers this bundled node over the user's
# PATH, so we don't depend on whatever shell they have configured.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # → packages/app/

# MUST match the NODE_MODULE_VERSION (ABI) that the bundled `pty.node` (in
# packages/server/dist/.../) was compiled against. The Bun build pulls
# node-pty's prebuilt binary from npm matching the build machine's Node
# major version. Today that's Node 25 → ABI 141. Bumping this requires
# a coordinated rebuild of the server bundle.
NODE_VERSION="v25.9.0"
ARCH="$(uname -m)"
case "${ARCH}" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "[bundle-node] error: unsupported arch ${ARCH}"; exit 1 ;;
esac

OS="$(uname -s | tr 'A-Z' 'a-z')"
case "${OS}" in
  darwin) NODE_OS="darwin" ;;
  linux) NODE_OS="linux" ;;
  *) echo "[bundle-node] error: unsupported OS ${OS}"; exit 1 ;;
esac

NODE_TARBALL="node-${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
CACHE_DIR="${HOME}/.cache/autonomos-bundle-node"
TARBALL_CACHE="${CACHE_DIR}/${NODE_TARBALL}"

mkdir -p "${CACHE_DIR}"

if [ ! -f "${TARBALL_CACHE}" ]; then
  echo "[bundle-node] downloading ${NODE_URL}"
  curl -fL "${NODE_URL}" -o "${TARBALL_CACHE}.tmp"
  mv "${TARBALL_CACHE}.tmp" "${TARBALL_CACHE}"
else
  echo "[bundle-node] using cached ${TARBALL_CACHE}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
tar -xzf "${TARBALL_CACHE}" -C "${WORK}"

EXTRACTED="${WORK}/node-${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}"
if [ ! -d "${EXTRACTED}" ]; then
  echo "[bundle-node] error: extracted dir not found at ${EXTRACTED}"
  exit 1
fi

mkdir -p resources/node/bin
cp "${EXTRACTED}/bin/node" resources/node/bin/node
chmod +x resources/node/bin/node

# Verify it runs.
if ! resources/node/bin/node --version >/dev/null 2>&1; then
  echo "[bundle-node] error: bundled node binary doesn't execute"
  exit 1
fi

SIZE=$(du -h resources/node/bin/node | cut -f1)
VERSION=$(resources/node/bin/node --version)
echo "[bundle-node] ✓ resources/node/bin/node (${SIZE}, ${VERSION})"
