---
"@autonomos/server": patch
---

The channel-server MCP bridge (`channel-server/dist.mjs`) now bundles its dependencies inline (fixes #376): v0.6.1's artifact imported `@modelcontextprotocol/sdk` and `ws` as external specifiers, which no release tarball can resolve — the bridge crashed before the MCP initialize response and every agent's `autonomos` MCP tools failed fleet-wide on bundle installs, while the daemon looked healthy. Source installs were unaffected (externals resolve against the repo), which is why it escaped. Now guarded twice: a unit test executes the committed artifact from a node_modules-free directory and requires a real initialize response, and the install e2e does the same against the artifact as actually packed by the tarball.
