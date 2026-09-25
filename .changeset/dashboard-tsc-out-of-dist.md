---
"@autonomos/dashboard": patch
---

fix(dashboard): keep type-check output out of the served dashboard folder

The dashboard's TypeScript type-check (`tsc --build`, part of `make check`)
wrote its output into `packages/dashboard/dist`, the folder the server serves.
When run from a source checkout after a type-check, that meant about 300 extra
files were publicly reachable next to the real build: the compiled dashboard
source (`store.js`, `App.js`, …), `.d.ts` files and maps. A local binary built
in that state embedded them too. The released v0.7.0 binaries were NOT
affected: the release build produces a fresh dashboard.

The type-check now writes to `packages/dashboard/.tsbuild/`, and a new check
(run by `make check` and by the binary's dashboard-embed step) fails if
`dist/` ever holds anything but the Vite build. If an existing checkout still
has old output there, `bun --filter @autonomos/dashboard build` clears it.
