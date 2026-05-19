// Atomic JSON config store with in-process write serialization.
// Promise-chain serializes concurrent setConfig calls; tmpfile→rename gives
// crash-safety. Not electron-store (avoid native dep).

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

import { CONFIG_FILENAME } from "../../shared/constants.js";
import { type AppConfig, defaultAppConfig } from "../../types/config.js";
import { migrateConfig } from "./migration.js";

let configWriteLock: Promise<void> = Promise.resolve();
let cached: AppConfig | null = null;

function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILENAME);
}

export async function getConfig(): Promise<AppConfig> {
  if (cached) return cached;
  const path = configPath();
  if (!existsSync(path)) {
    cached = defaultAppConfig();
    return cached;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateConfig(parsed);
    cached = migrated;
    return migrated;
  } catch (err) {
    // Don't overwrite — rename for forensics. Falling back silently to
    // defaults would hide data loss; the rename preserves anything recoverable
    // and prevents the next setConfig() from clobbering the broken file.
    console.error("[config] Failed to parse config.json:", err);
    await rename(path, `${path}.broken-${Date.now()}`).catch(() => undefined);
    cached = defaultAppConfig();
    return cached;
  }
}

export async function setConfig(
  update: (current: AppConfig) => AppConfig,
): Promise<AppConfig> {
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

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
