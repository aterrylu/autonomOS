---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

perf(dashboard): cache and compress the dashboard's assets

The server sent the dashboard with no compression and no caching headers, so
every page load downloaded the full ~1.5MB bundle again, uncompressed. On a slow
connection (the phone PWA, a remote box) that meant ~18s per load, every time.

The build now writes brotli and gzip copies of the bundle, and the server sends
them to browsers that accept them. The hashed asset files are cached for good
(their names change whenever their contents do), while `index.html`, `sw.js` and
the manifest are revalidated on every load, so an upgrade still lands right away.
`index.html` now carries an ETag and answers 304 when unchanged.

Measured on an isolated instance: first load 1,555KB → 325KB, repeat loads
1,555KB → 0.3KB; on a throttled Slow-3G link, first load 17.9s → 5.0s and repeat
loads 18s → 1.1s.

Deep links also stop pointing at deleted assets after a rebuild without a
restart: the SPA fallback now re-reads `index.html` when it changes, instead of
serving a copy captured at boot.
