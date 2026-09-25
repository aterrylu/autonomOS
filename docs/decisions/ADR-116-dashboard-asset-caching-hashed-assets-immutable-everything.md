## ADR-116: Dashboard asset caching: hashed assets immutable, everything else revalidates

- **Date:** 2026-09-25
- **Decided by:** Performance@autonomOS (agent), under Terry's go on the Phase 1 performance proposal (item #2: "asset caching + precompression")
- **Context:** The server served the built dashboard with no `Cache-Control`, no validator (ETag/Last-Modified) and no `Content-Encoding`. Every page load, first or repeat, downloaded the full bundle again uncompressed: 1,555KB, measured on 3 consecutive loads in one browser profile. On a throttled Slow-3G link (the phone PWA, or a remote box) that is ~18s per load, every load. The SPA fallback also served an `index.html` snapshot captured at boot, so after a rebuild without a restart, deep links named asset hashes that no longer existed.
- **Decision:**
  - Vite's content-hashed files under `/assets/*` are served with `Cache-Control: public, max-age=31536000, immutable`.
  - Everything else (`index.html` for `/`, `/index.html` and every SPA route; `sw.js`, `manifest.json`, `favicon.svg`) is served with `Cache-Control: no-cache`, so it revalidates on every load.
  - `index.html` carries a content ETag and answers 304 (weak comparison). The server re-reads it when it changes on disk, and `/api/host` reports the build being served NOW.
  - A build step (`dashboard/build/precompress.ts`) writes brotli and gzip siblings for compressible outputs of 1KB or more, written atomically. `serveStatic({ precompressed: true })` sends them with `Vary: Accept-Encoding`.
  - A missing `/assets/*` file is a `404` with `no-store`, never the SPA HTML.
  - Implemented in `server/src/dashboardStatic.ts`.
- **Rationale:**
  - Hashed names are the cache key's version: a new build means new names, so caching them forever can't serve stale code. Revalidating `index.html` on every load is what makes that safe: it names the current hashes, so an upgrade lands on the next load.
  - Measured: first load 1,555KB → 325KB (brotli); repeat loads 1,555KB → 0.3KB; Slow-3G first load 17.9s → 5.0s, repeat loads ~18s → 1.1s.
  - Compressing at build time costs nothing per request. On-the-fly compression would spend server CPU on every load, on the same process that streams every agent's terminal.
- **Alternatives considered:** On-the-fly compression middleware (`hono/compress`): rejected, because it adds per-request CPU on the event loop the terminals share, for bytes that never change between builds. A service worker cache: rejected, because `sw.js` is deliberately non-caching ("autonomOS requires a live server connection"), and HTTP caching gets the same repeat-load win without a cache-invalidation layer to maintain. A short `max-age` on everything: rejected, because it either still re-downloads the bundle after expiry or pins `index.html` (and so an old build) for the max-age window after an upgrade. `immutable` on non-hashed files: rejected and tested against (a mutation marking everything immutable fails the suite), because it would pin `sw.js` and `index.html` to an old build for a year.
- **Source:** Performance Phase 1 proposal (https://claude.ai/artifact/M4QAqEGiiRGpmjdAkFA8bB), item #2; greenlit by Terry via TeamLead@autonomOS on 2026-09-24; implemented and reviewed (`/polish`: code-reviewer, simplifier, silent-failure-hunter) in the PR that adds `dashboardStatic.ts`.
