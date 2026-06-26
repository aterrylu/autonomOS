#!/usr/bin/env bash
#
# Preflight: ensure node-pty's native addon (build/Release/pty.node) can be
# loaded by the SAME node binary that ecosystem.config.cjs / pm2 will run the
# server with — BEFORE we hand off to pm2.
#
# Why this exists:
#   node-pty@1.0.0 ships no prebuilds. It compiles a single
#   build/Release/pty.node at install time, and `bun install` does NOT rebuild
#   it on subsequent runs. So when the host node's ABI changes out from under us
#   — e.g. a Homebrew upgrade to Node 26 (NODE_MODULE_VERSION 147) while the
#   cached pty.node was built for Node 25 (141) — the server's
#   `require("node-pty")` throws ERR_DLOPEN_FAILED. Under pm2 that surfaces as a
#   silent restart loop (status "errored", ↺ climbing) with the real cause
#   buried in /tmp/autonomos-error.log. This script turns that into a fast,
#   actionable failure at build time, with a best-effort automatic rebuild.
#
set -euo pipefail

# Resolve node the way ecosystem.config.cjs does (EXTRA_PATHS-first) so this
# check uses the exact binary the daemon will. KEEP IN SYNC with EXTRA_PATHS in
# ecosystem.config.cjs.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:/snap/bin:/usr/bin:/bin:$PATH"

# Locate node-pty in either bun's non-hoisted store or a hoisted layout.
PTY_DIR=""
for d in node_modules/.bun/node-pty@*/node_modules/node-pty node_modules/node-pty; do
  [ -d "$d" ] && { PTY_DIR="$d"; break; }
done
if [ -z "$PTY_DIR" ]; then
  echo "[ensure-node-pty] node-pty not installed yet; skipping (run after 'bun install')." >&2
  exit 0
fi
PTY_NODE="$PTY_DIR/build/Release/pty.node"

# dlopen the native addon directly — this is exactly the operation that fails on
# an ABI mismatch, and it sidesteps bun's non-hoisted module resolution.
abi_loads() { node -e 'process.dlopen({ exports: {} }, process.argv[1])' "$PTY_NODE" 2>/dev/null; }

if [ -f "$PTY_NODE" ] && abi_loads; then
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

node-pty@1.0.0 ships no prebuild, so a Node ABI change (e.g. a Homebrew upgrade
to Node 26) breaks the cached binary and pm2 will crash-loop. Fix one of:

  • Run autonomOS under Node <= 25 (matches the committed build). e.g.:
      ln -sf "\$HOME/.nvm/versions/node/v25.4.0/bin/node" "\$HOME/.local/bin/node"
    (~/.local/bin is first on the daemon's PATH, so pm2 picks it up.)
  • Install Xcode Command Line Tools + python3 so 'node-gyp rebuild' can run.
EOF
exit 1
