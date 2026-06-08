#!/usr/bin/env bash
# Merge an arm64 and an x64 server bundle into a single universal2 bundle.
#
# Usage: stage-universal-server.sh <arm64-bundle-dir> <x64-bundle-dir> <out-dir>
#
# The two bundles (from `bun run build:binary` on each arch's CI runner) carry
# identical JS but arch-specific native modules with content-hashed, arch-tagged
# filenames (e.g. pty-<hashA>.node vs pty-<hashB>.node; impit-node.darwin-arm64-*
# vs impit-node.darwin-x64-*). We:
#   1. Copy the arm64 bundle verbatim as the base (JS + filenames).
#   2. For each native .node, `lipo` the arm64 + matching x64 slice into a fat
#      binary, written under the ARM64 filename the JS already references.
#
# dlopen() on a fat binary selects the correct slice at runtime regardless of
# the filename, so the cosmetic "darwin-arm64" name loads fine under x64. This
# is validated by smoke-test-bundle.sh, which loads every .node under BOTH
# arches.

set -euo pipefail

ARM_DIR="${1:?arm64 bundle dir}"
X64_DIR="${2:?x64 bundle dir}"
OUT_DIR="${3:?output dir}"

if [ ! -f "${ARM_DIR}/index.js" ] || [ ! -f "${X64_DIR}/index.js" ]; then
  echo "[stage-universal] both bundles must contain index.js" >&2
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
cp -R "${ARM_DIR}/." "${OUT_DIR}/"

shopt -s nullglob
for arm_node in "${OUT_DIR}"/*.node; do
  base="$(basename "${arm_node}")"
  # Module key = text before the first hyphen (pty, impit, ...). The two
  # arches share the key but differ in the arch tag + hash suffix.
  key="${base%%-*}"

  x64_node=""
  for cand in "${X64_DIR}/${key}-"*.node "${X64_DIR}/${key}.node"; do
    [ -f "${cand}" ] && { x64_node="${cand}"; break; }
  done
  if [ -z "${x64_node}" ]; then
    echo "[stage-universal] FAIL: no x64 native module matching key '${key}'" >&2
    echo "[stage-universal] x64 dir contains:" >&2
    ls -1 "${X64_DIR}"/*.node >&2 || true
    exit 1
  fi

  lipo -create "${arm_node}" "${x64_node}" -output "${arm_node}.fat"
  mv "${arm_node}.fat" "${arm_node}"
  echo "[stage-universal] ✓ ${base}: $(lipo -info "${arm_node}" | sed 's/.*: //')"

  # Some native loaders (e.g. impit / napi-rs) `existsSync`-check an
  # ARCH-SPECIFIC filename at runtime — `<pkg>.darwin-x64.node` on Intel,
  # `<pkg>.darwin-arm64.node` on Apple Silicon. Our universal binary is named
  # after only one arch (whichever arch built the bundle), so on the other arch
  # the loader doesn't find it and throws even though the fat binary would load.
  # Emit the universal binary under both arch names so the loader finds it on
  # either arch. node-pty (no arch token in its name, direct require) is
  # unaffected and skips this.
  if printf '%s' "${base}" | grep -q "darwin-arm64\|darwin-x64"; then
    prefix="${base%%darwin-*}"     # e.g. "impit-node."
    for variant in darwin-x64 darwin-arm64 darwin-universal; do
      alias_path="${OUT_DIR}/${prefix}${variant}.node"
      [ -e "${alias_path}" ] || cp "${arm_node}" "${alias_path}"
    done
    echo "[stage-universal]   + arch-name aliases for ${prefix%.}"
  fi
done

echo "[stage-universal] universal server bundle staged at ${OUT_DIR}"
