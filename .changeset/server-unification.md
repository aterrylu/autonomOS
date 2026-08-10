---
"@autonomos/server": patch
---

feat(server): typed errors + one Zod validation source + store-level secrets guard (API-consolidation PR B, ADR-083)

- `HttpError` + a central handler on both listeners emit the ADR-078 envelope (`{error, code, retryable?, details?}`) for every failure; nine routes adopt `parseBody` (400 `VALIDATION` with per-field `details.issues`).
- Request shapes live once in `validation.ts`, shared by REST routes and the HTTP MCP server; a new drift test (z.toJSONSchema vs the channel server's hand-written JSON literals) keeps the third copy honest — and caught 58 live description drifts on its first run.
- Env-preset writes strip secret values at the store unless the dashboard route explicitly opts in — ADR-067's "agents cannot set credentials" is now structural.
- Strictness fixes: a non-string `manager` no longer silently clears an agent's manager; a non-number `version` no longer skips the concurrency check; a bogus spawn `provider` is a 400 instead of a 500.
- Heals the e2e suite: the mock catch-all no longer claims vite's `/src/api/*` module URLs (a latent regression from the api-client layer that timed out all 22 specs).
