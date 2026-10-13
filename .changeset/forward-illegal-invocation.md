---
"@autonomos/server": patch
---

fix(agent-api): every agent-side call failed on Node 23+ with "Illegal invocation"

Spawning an agent, listing or creating templates, and reading the agent tree all
failed from inside an agent, with nothing created. The daemon log showed
`TypeError: Illegal invocation` on `GET /api/templates`, `POST /api/templates`,
`GET /api/agents/tree` and `POST /api/agents`.

`forward()` re-issued each request with `new Request(url, c.req.raw)`, the usual
Hono idiom. But `@hono/node-server` doesn't hand handlers a real Request — it's a
lazy subclass whose internals are materialized on first property read. Node <= 22's
undici copied an init Request field by field, running those getters; Node 23+ reads
its internal slots directly, finds them uninitialized, and throws. The init is now
spelled out field by field, which both forces the getters and makes the
dependency explicit.

The whole suite stayed green through this because every other test in
`agent-api.test.ts` uses Hono's in-memory `app.request()`, which builds a real
Request. The regression test added here goes over a real socket.
