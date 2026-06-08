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

  # napi-rs modules (impit) can't be loaded by their per-arch filename on the
  # "other" arch inside the bundle: `bun build` resolves napi-rs's static-literal
  # `require('./<pkg>.darwin-<arch>.node')` calls against the BUILD host's
  # filesystem, so only the build-arch branch keeps a live require — every other
  # arch branch is compiled to a throw-stub. On Intel the loader reaches only
  # stubs and fails. The server works around this via napi-rs's
  # NAPI_RS_NATIVE_LIBRARY_PATH escape hatch (see cli/src/napi-universal-binding.ts),
  # which loads a fixed `<pkg>.darwin-universal.node` first, before any arch
  # detection. Stage that fixed-name alias here so the shim has a target.
  # node-pty (node-gyp/nan, direct require — no arch token) is unaffected.
  if printf '%s' "${base}" | grep -q "darwin-arm64\|darwin-x64"; then
    prefix="${base%%darwin-*}"     # e.g. "impit-node."
    alias_path="${OUT_DIR}/${prefix}darwin-universal.node"
    # cp -f (not `[ -e ] || cp`): always overwrite so a dirty/incremental OUT_DIR
    # can't leave a stale universal alias from a previous build.
    cp -f "${arm_node}" "${alias_path}"
    echo "[stage-universal]   + ${prefix}darwin-universal.node alias (NAPI_RS_NATIVE_LIBRARY_PATH target)"
  fi
done

# node-pty's spawn-helper executable is staged next to index.js by build-binary.ts
# (it's posix_spawn()'d to set up the PTY before exec'ing the agent command).
# Like the .node modules it's an arch-specific Mach-O, so lipo the two slices into
# a universal binary — otherwise the "other" arch hits "posix_spawnp failed." and
# agent spawning is dead. The arm64 copy was carried over by the cp -R above.
arm_helper="${OUT_DIR}/spawn-helper"
x64_helper="${X64_DIR}/spawn-helper"
if [ -f "${arm_helper}" ] && [ -f "${x64_helper}" ]; then
  lipo -create "${arm_helper}" "${x64_helper}" -output "${arm_helper}.fat"
  mv "${arm_helper}.fat" "${arm_helper}"
  chmod +x "${arm_helper}"
  echo "[stage-universal] ✓ spawn-helper: $(lipo -info "${arm_helper}" | sed 's/.*: //')"
else
  echo "[stage-universal] FAIL: spawn-helper missing (arm:${arm_helper} x64:${x64_helper})" >&2
  echo "[stage-universal] build-binary.ts must stage node-pty's spawn-helper into each bundle." >&2
  exit 1
fi

echo "[stage-universal] universal server bundle staged at ${OUT_DIR}"
