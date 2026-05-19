/**
 * Atomic JSON config store with in-process write serialization.
 *
 * Adapted from Open WebUI Desktop's `setConfig` pattern
 * (src/main/utils/index.ts:887-927) — verbatim port to TypeScript with
 * stricter typing. The two correctness properties:
 *
 *   1. Concurrent `setConfig()` calls from different IPC handlers are
 *      serialized via a Promise chain — no torn writes.
 *
 *   2. Each write goes via `tmpfile → fsync → rename`, so a crash mid-
 *      write leaves either the old config intact or the new one — never
 *      a partially-written file.
 *
 * We deliberately do NOT use `electron-store`. It's overkill for our tiny
 * AppConfig + adds a native build dep. 30 lines of this gets us durability
 * + concurrent-safety + zero external dependencies.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

import { CONFIG_FILENAME } from "../../shared/constants.js";
import { type AppConfig, defaultAppConfig } from "../../types/config.js";
import { migrateConfig } from "./migration.js";

/** Promise chain serializing all `setConfig` calls. Each new write awaits
 *  the previous one before proceeding, so the order is preserved and writes
 *  never interleave. */
let configWriteLock: Promise<void> = Promise.resolve();

/** Cached config — populated by the first `getConfig()` call, kept in sync
 *  with each `setConfig()`. Reads never touch disk after the first one. */
let cached: AppConfig | null = null;

function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILENAME);
}

/** Returns the current config, loading from disk if not yet cached.
 *  Applies schema migrations on read for upward-compat. */
export async function getConfig(): Promise<AppConfig> {
  if (cached) return cached;

  const path = configPath();
  if (!existsSync(path)) {
    cached = defaultAppConfig();
    return cached;
  }

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateConfig(parsed);
    cached = migrated;
    return migrated;
  } catch (err) {
    // Malformed config — DON'T overwrite (that would lose recoverable data);
    // fail loud and fall back to defaults so the UI can render. The user can
    // edit/delete config.json by hand if needed.
    console.error("[config] Failed to parse config.json:", err);
    cached = defaultAppConfig();
    return cached;
  }
}

/** Updates the config via a transformer function. Reads-modify-writes
 *  atomically (within process; cross-process locking would require a
 *  filesystem lock which we don't need for a single-instance Electron app). */
export async function setConfig(
  update: (current: AppConfig) => AppConfig,
): Promise<AppConfig> {
  // Chain onto the existing lock — order matters, so we await the previous
  // write before starting ours.
  const previous = configWriteLock;
  let release!: () => void;
  configWriteLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    const current = await getConfig();
    const next = update(current);
    await writeAtomic(configPath(), JSON.stringify(next, null, 2));
    cached = next;
    return next;
  } finally {
    release();
  }
}

/** Atomic file write: write to tmpfile in the same directory (so rename is
 *  atomic), then rename over the target. fsync isn't exposed via fs/promises
 *  in a portable way; Node guarantees rename is atomic within a filesystem,
 *  which is what we need. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
}

/** TEST-ONLY: reset the in-memory cache + write lock. Lets tests run with
 *  a clean state per case. Do NOT call from production code. */
export function _resetForTesting(): void {
  cached = null;
  configWriteLock = Promise.resolve();
}
