---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Security hygiene bundle (defense-in-depth; no live exposure was open).

- **Directory modes → 0700.** The config root, `schedules/`, `schedule-runs/`, `templates/`, and the log dir are now created owner-only, so another local user can't read a schedule's prompt, a template's systemPrompt, or the logs. Creation-time only — an existing dir keeps its mode (and the token file inside is 0600 regardless).
- **Schedule shape validation on load.** `getSchedule` now rejects a file that isn't a well-formed `Schedule` (a list-wrapped `[]`, a non-object, or one missing a required `name`/`schedule`/`target`/`prompt`/`enabled` field) instead of casting it through — which used to let a malformed file drive cron construction or a gateway send off undefined values. Mirrors the templates guard. Deprecated/accepted-and-ignored fields are still allowed, so pre-removal schedule files keep loading.
- **Terminal-link scheme allowlist.** `deduplicatedOpen` — the single chokepoint the OSC 8 hyperlink handler and the URL provider both route through — now opens only `http`/`https`/`mailto` and refuses everything else (`javascript:`, `data:`, `file:`, custom protocols) plus non-URL values. An agent's terminal output can emit an OSC 8 link with any scheme and benign text; browsers block the worst for a top-level `window.open`, but this is explicit defense-in-depth.
- **Dependency bumps (runtime-relevant, in-major only):** `@hono/node-server` → ^1.19.13 (fixes the serveStatic repeated-slash middleware-bypass advisory for the server's own dashboard-serving; a 1.x patch that stays compatible with `@hono/node-ws`'s peer requirement — a 2.x bump would put the WS layer in an unsupported configuration), and `ws` → ^8.18.3.

Remaining `bun audit` advisories are deliberately **not** force-bumped: they are either **dev/build/test-only** (vite dev-server, postcss/js-yaml build tooling, form-data via jsdom tests — none present in the shipped server) or **transitive-via-peer and gated** (a residual `@hono/node-server` 1.19.x pulled by `@hono/node-ws`/MCP-sdk that doesn't expose serveStatic in our usage; ws/fast-uri/path-to-regexp behind the socket-only, auth-gated, loopback control plane). Clearing them would require transitive overrides that risk the hardened runtime for no practical gain on a single-user, controlled-network deployment.
