#!/usr/bin/env bash
# Download a portable Node.js runtime and stage it into resources/node/ so
# electron-builder bundles it into the .app's Resources/ at build time.
# This gives brand-new Macs a zero-prerequisite experience for the Built-in
# server flow — no `brew install node` required.
#
# Outputs:
#   resources/node/bin/node     (host arch by default; universal2 when
#                                BUNDLE_NODE_UNIVERSAL=1 on macOS)
#
# Modes:
#   (default)                  Bundle the host arch only — fast, for local dev.
#   BUNDLE_NODE_UNIVERSAL=1    macOS only: fetch BOTH darwin-arm64 + darwin-x64
#                              and `lipo` them into one universal2 binary. The
#                              release CI uses this so a single DMG runs on both
#                              Apple Silicon and Intel. (Proven viable — a fat
#                              .node/binary loads under both arches.)
#
# At runtime, server-supervisor.ts prefers this bundled node over the user's
# PATH, so we don't depend on whatever shell they have configured.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # → packages/app/

# The bundled Node MUST share an ABI (NODE_MODULE_VERSION) with the node-pty
# native binding in the server bundle — and node-pty is COMPILED FROM SOURCE
# (it ships no prebuilds) against whatever Node ran `bun install`. So the rule
# is: bundle the SAME Node version that built the server.
#
#   - Locally: default to the developer's own `node --version` (their server
#     build used it, so the ABIs line up).
#   - In the release CI: BUNDLE_NODE_VERSION is set explicitly to match the
#     Node pinned on the build-server job (Node 22 LTS — node-pty's nan-based
#     build does NOT compile against Node 25's V8 headers on the CI toolchain).
#
# Mismatch → the bundled pty.node fails to dlopen (caught by smoke-test-bundle).
DEFAULT_NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_VERSION="${BUNDLE_NODE_VERSION:-${DEFAULT_NODE_VERSION:-v22.13.0}}"
CACHE_DIR="${HOME}/.cache/autonomos-bundle-node"
mkdir -p "${CACHE_DIR}"

OS="$(uname -s | tr 'A-Z' 'a-z')"

# Fetch a Node tarball for a given os/arch and echo the path to its `node`
# binary. Caches the tarball.
fetch_node() {
  local node_os="$1" node_arch="$2"
  local tarball="node-${NODE_VERSION}-${node_os}-${node_arch}.tar.gz"
  local cache="${CACHE_DIR}/${tarball}"
  if [ ! -f "${cache}" ]; then
    echo "[bundle-node] downloading ${tarball}" >&2
    curl -fL "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" -o "${cache}.tmp"
    mv "${cache}.tmp" "${cache}"
  else
    echo "[bundle-node] using cached ${tarball}" >&2
  fi
  local work
  work="$(mktemp -d)"
  tar -xzf "${cache}" -C "${work}"
  echo "${work}/node-${NODE_VERSION}-${node_os}-${node_arch}/bin/node"
}

mkdir -p resources/node/bin

if [ "${BUNDLE_NODE_UNIVERSAL:-0}" = "1" ]; then
  if [ "${OS}" != "darwin" ]; then
    echo "[bundle-node] error: BUNDLE_NODE_UNIVERSAL=1 is macOS-only" >&2
    exit 1
  fi
  echo "[bundle-node] building universal2 Node (arm64 + x64)"
  ARM_BIN="$(fetch_node darwin arm64)"
  X64_BIN="$(fetch_node darwin x64)"
  lipo -create "${ARM_BIN}" "${X64_BIN}" -output resources/node/bin/node
  chmod +x resources/node/bin/node
  echo "[bundle-node] universal slices: $(lipo -info resources/node/bin/node | sed 's/.*: //')"
else
  case "$(uname -m)" in
    arm64 | aarch64) NODE_ARCH="arm64" ;;
    x86_64) NODE_ARCH="x64" ;;
    *)
      echo "[bundle-node] error: unsupported arch $(uname -m)" >&2
      exit 1
      ;;
  esac
  case "${OS}" in
    darwin | linux) NODE_OS="${OS}" ;;
    *)
      echo "[bundle-node] error: unsupported OS ${OS}" >&2
      exit 1
      ;;
  esac
  HOST_BIN="$(fetch_node "${NODE_OS}" "${NODE_ARCH}")"
  cp "${HOST_BIN}" resources/node/bin/node
  chmod +x resources/node/bin/node
fi

# Verify it runs (under the host arch — a universal binary runs natively here).
if ! resources/node/bin/node --version >/dev/null 2>&1; then
  echo "[bundle-node] error: bundled node binary doesn't execute" >&2
  exit 1
fi

SIZE=$(du -h resources/node/bin/node | cut -f1)
VERSION=$(resources/node/bin/node --version)
echo "[bundle-node] ✓ resources/node/bin/node (${SIZE}, ${VERSION})"
