// Lazy, injectable accessor for the slice of Electron's API that the main
// process modules depend on.
//
// WHY THIS EXISTS
// ---------------
// The `electron` package's bare entry point (`electron/index.js`) does NOT
// export `app`, `safeStorage`, etc. when imported from a plain Node process —
// it resolves to the path of the Electron binary. The real `app`/`safeStorage`
// objects only exist inside the Electron runtime. So a top-level
//   `import { app } from "electron";`
// fails to even *instantiate* under `node`/`tsx` ("does not provide an export
// named 'app'"), which makes every module that does it impossible to unit-test.
//
// This module funnels all Electron access through a single seam:
//   - In production (real Electron runtime) it lazily `require("electron")` the
//     first time an accessor is called — never at import time.
//   - In tests, `_setElectronForTesting({...})` injects a stub, so the modules
//     under test never touch the real `electron` package. Mirrors the server's
//     `_setDependencies(...)` / `_resetForTesting()` override-variable pattern.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The narrow surface of `electron.app` the main process actually uses. */
export interface ElectronApp {
  readonly isPackaged: boolean;
  readonly name: string;
  getPath(name: "userData" | string): string;
}

/** The narrow surface of `electron.safeStorage` tokens.ts uses. */
export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface ElectronDeps {
  app: ElectronApp;
  safeStorage: ElectronSafeStorage;
}

let override: Partial<ElectronDeps> | null = null;
let realCache: ElectronDeps | null = null;

function real(): ElectronDeps {
  if (!realCache) {
    // Lazy require so plain-Node imports of dependent modules don't blow up.
    realCache = require("electron") as ElectronDeps;
  }
  return realCache;
}

/** The live `electron.app`. Throws a clear error if neither a real Electron
 *  runtime nor a test stub is available. */
export function getApp(): ElectronApp {
  if (override?.app) return override.app;
  const app = real().app;
  if (!app) {
    throw new Error(
      "electron.app is unavailable — not running under Electron and no test " +
        "stub installed via _setElectronForTesting().",
    );
  }
  return app;
}

/** The live `electron.safeStorage`. */
export function getSafeStorage(): ElectronSafeStorage {
  if (override?.safeStorage) return override.safeStorage;
  const safeStorage = real().safeStorage;
  if (!safeStorage) {
    throw new Error(
      "electron.safeStorage is unavailable — not running under Electron and " +
        "no test stub installed via _setElectronForTesting().",
    );
  }
  return safeStorage;
}

/** TEST SEAM. Inject a stub for `app` and/or `safeStorage`. */
export function _setElectronForTesting(stub: Partial<ElectronDeps>): void {
  override = stub;
}

/** TEST SEAM. Restore real (lazy) Electron resolution. */
export function _resetElectronForTesting(): void {
  override = null;
}
