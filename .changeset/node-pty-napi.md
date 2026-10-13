---
"@autonomos/server": patch
---

fix(build): node-pty on N-API — the installed bundle runs on every Node, not just the one CI built it with

A fresh install died before the daemon ever started, with
`ERR_DLOPEN_FAILED: ... compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION
141.` Every `autonomos` verb failed the same way, `status` included.

node-pty 1.0.0 is nan-based: one native binary per Node major. CI pinned Node 22
to compile it, so released tarballs only loaded on Node 22 — while install.sh
accepted any Node 20+, which is most machines. node-pty 1.1.0 is node-addon-api
(N-API) based, and its ABI is stable across Node majors, so a single binary
loads on Node 20 and on majors released after the build.

Also fixed along the way: 1.1.0 resolves its addon at runtime, which bun cannot
bundle, so `pty.node` is now staged explicitly (it was silently absent);
node-pty's tarball ships `spawn-helper` mode 644, which made every spawn fail
with `posix_spawnp failed.` when running from source; and the CI Node pin is
gone. See ADR-154.
