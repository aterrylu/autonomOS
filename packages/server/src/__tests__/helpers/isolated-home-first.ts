/**
 * Side-effect form of isolateHome() for test files that import server modules
 * STATICALLY. ES imports are evaluated in source order, so making this the
 * FIRST import runs the isolation before shared.ts captures HOME:
 *
 *   import "./helpers/isolated-home-first.js"; // must be the first import
 *
 * A side-effect import is also an ordering barrier for biome's import sort,
 * so formatting can't move it below the server imports.
 */

import { after } from "node:test";
import { isolateHome } from "./isolate-home.js";

export const isolated = isolateHome("aos-isolated");
after(() => isolated.restore());
