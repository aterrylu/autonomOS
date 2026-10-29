#!/usr/bin/env bash
#
# Preflight: ensure node-pty's native addon can be loaded by the SAME node
# binary that ecosystem.config.cjs / pm2 will run the server with — BEFORE we
# hand off to pm2.
#
# Why this exists:
#   node-pty@1.0.0 was nan-based: one build/Release/pty.node compiled at install
#   time against ONE NODE_MODULE_VERSION, and `bun install` did not rebuild it on
#   subsequent runs. A host node ABI change — e.g. a Homebrew upgrade to Node 26
#   (ABI 147) over a pty.node built for Node 22 (ABI 127) — made the server's
#   `require("node-pty")` throw ERR_DLOPEN_FAILED, surfacing under pm2 as a
#   silent restart loop with the real cause buried in /tmp/autonomos-error.log.
#
#   node-pty@1.1.0 is built on node-addon-api (N-API), whose ABI is stable across
#   Node major versions, so one binary loads on every supported Node and all
#   future ones. This check should now always pass — it is kept as a cheap
#   regression guard so that a downgrade, a corrupt prebuild, or a platform with
#   no prebuild + a failed node-gyp fallback still fails fast and legibly here
#   instead of as a pm2 crash-loop.
#
set -euo pipefail

# Resolve node the way ecosystem.config.cjs does (EXTRA_PATHS-first) so this
# check uses the exact binary the daemon will. KEEP IN SYNC with EXTRA_PATHS in
# ecosystem.config.cjs.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:/snap/bin:/usr/bin:/bin:$PATH"

# This runs as the root package's postinstall, so it must never be the reason a
# plain `bun install` fails. No node on PATH means nothing can be checked (and
# the daemon could not run anyway) — defer to install.sh's own node check rather
# than breaking dependency installation here.
if ! command -v node >/dev/null 2>&1; then
  echo "[ensure-node-pty] no node on PATH; skipping the ABI check." >&2
  exit 0
fi

# Locate node-pty in either bun's non-hoisted store or a hoisted layout, and the
# addon within it. 1.1.0 ships prebuilt N-API binaries under
# prebuilds/<platform>-<arch>/ for darwin and win32; platforms without a prebuild
# (Linux) fall back to a node-gyp build in build/Release/. Check both, in
# node-pty's own resolution order.
#
# The store can hold several node-pty versions at once (an upgrade leaves the old
# tree behind until pruned), and the stale one may sort first — so keep scanning
# until a directory actually yields an addon rather than trusting the first hit.
PTY_PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
PTY_DIR=""
PTY_NODE=""
for d in node_modules/.bun/node-pty@*/node_modules/node-pty node_modules/node-pty; do
  [ -d "$d" ] || continue
  for c in "$d/build/Release/pty.node" "$d/prebuilds/$PTY_PLATFORM/pty.node"; do
    [ -f "$c" ] && { PTY_DIR="$d"; PTY_NODE="$c"; break 2; }
  done
done

if [ -z "$PTY_DIR" ]; then
  if ! ls -d node_modules/.bun/node-pty@*/node_modules/node-pty node_modules/node-pty >/dev/null 2>&1; then
    echo "[ensure-node-pty] node-pty not installed yet; skipping (run after 'bun install')." >&2
    exit 0
  fi
  echo "[ensure-node-pty] ERROR: node-pty is installed but ships no pty.node for $PTY_PLATFORM" >&2
  echo "                  (looked in build/Release/ and prebuilds/$PTY_PLATFORM/). Try a clean 'bun install'." >&2
  exit 1
fi

# node-pty's npm tarball ships prebuilds/<platform>/spawn-helper with mode 644.
# The release bundle chmods it while staging (build-binary.ts), but the source
# path loads it straight out of node_modules, where posix_spawn() then fails with
# "posix_spawnp failed." on every single spawn. macOS only — no helper elsewhere.
PTY_HELPER="$(dirname "$PTY_NODE")/spawn-helper"
if [ -f "$PTY_HELPER" ] && [ ! -x "$PTY_HELPER" ]; then
  chmod +x "$PTY_HELPER"
  echo "[ensure-node-pty] chmod +x $PTY_HELPER (npm tarball ships it 644)"
fi

# dlopen the native addon directly — this is exactly the operation that fails on
# an ABI mismatch, and it sidesteps bun's non-hoisted module resolution.
abi_loads() { node -e 'process.dlopen({ exports: {} }, process.argv[1])' "$PTY_NODE" 2>/dev/null; }

if abi_loads; then
  echo "[ensure-node-pty] OK — pty.node loads under $(node -v) (ABI $(node -p process.versions.modules))"
  exit 0
fi

echo "[ensure-node-pty] pty.node not loadable under $(node -v) (ABI $(node -p process.versions.modules)); attempting rebuild…" >&2
if ( cd "$PTY_DIR" && npx --yes node-gyp rebuild ) && abi_loads; then
  echo "[ensure-node-pty] rebuilt OK for $(node -v) (ABI $(node -p process.versions.modules))"
  exit 0
fi

cat >&2 <<EOF

[ensure-node-pty] ERROR: node-pty's native addon does not match the runtime node
and could not be rebuilt automatically.

  runtime node : $(node -v) (ABI $(node -p process.versions.modules))
  pty.node     : $PTY_NODE

node-pty@1.1.0 is N-API based, so this should NOT be an ABI mismatch — a plain
Node upgrade can no longer break the binary. Likely causes:

  • node-pty got resolved to a pre-1.1.0 (nan-based) version — check that
    packages/server/package.json still pins >= 1.1.0, then re-run 'bun install'.
  • The prebuild download was skipped or corrupted; delete node_modules and
    re-run 'bun install'.
  • No prebuild for this platform and 'node-gyp rebuild' failed — install Xcode
    Command Line Tools (macOS) or build-essential + python3 (Linux).
EOF
exit 1
