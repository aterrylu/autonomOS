// Thin entry point. The actual server startup logic lives in `run.ts` —
// exposed as `runServer(argv)` so the CLI (`autonomos start`) and this
// standalone entry both invoke the same code path.
//
// Direct invocation paths that hit this file:
//   - `tsx packages/server/src/index.ts` (make dev)
//   - `node packages/server/dist/<platform>/index.js` (Phase 1A.1 bundle)
//   - Phase 1B Electron child process

import { runServer } from "./run.js";

runServer(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
