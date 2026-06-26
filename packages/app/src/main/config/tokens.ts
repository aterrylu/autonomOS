// Encrypted token storage for Connection bearer tokens.
//
// Encrypted via Electron `safeStorage` (Keychain on macOS, libsecret on
// Linux, DPAPI on Windows). Per-token encrypted-flag so we don't misread
// an encrypted blob as plaintext after a mid-session keychain flip.
// File is mode 0o600 always — consistent with how the server enforces
// it on token-bearing files (`packages/server/src/auth.ts:54`).
//
// On-disk shape inside `app.getPath("userData")/tokens.dat`:
//   { "encryptionAvailable": bool,
//     "tokens": { "<connection-id>": { encrypted: bool, value: string } } }

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TOKENS_FILENAME } from "../../shared/constants.js";
import { getApp, getSafeStorage } from "../electron-deps.js";

interface StoredToken {
  encrypted: boolean;
  value: string;
}

interface TokensFile {
  encryptionAvailable: boolean;
  tokens: Record<string, StoredToken>;
}

function isStoredToken(x: unknown): x is StoredToken {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as StoredToken).encrypted === "boolean" &&
    typeof (x as StoredToken).value === "string"
  );
}

function isTokensFile(x: unknown): x is TokensFile {
  if (typeof x !== "object" || x === null) return false;
  const f = x as TokensFile;
  if (typeof f.encryptionAvailable !== "boolean") return false;
  if (typeof f.tokens !== "object" || f.tokens === null) return false;
  for (const v of Object.values(f.tokens)) {
    if (!isStoredToken(v)) return false;
  }
  return true;
}

function emptyFile(): TokensFile {
  return {
    encryptionAvailable: getSafeStorage().isEncryptionAvailable(),
    tokens: {},
  };
}

let cached: TokensFile | null = null;
let writeLock: Promise<void> = Promise.resolve();

function tokensPath(): string {
  return join(getApp().getPath("userData"), TOKENS_FILENAME);
}

async function load(): Promise<TokensFile> {
  if (cached) return cached;
  const path = tokensPath();
  if (!existsSync(path)) {
    cached = emptyFile();
    return cached;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isTokensFile(parsed)) {
      throw new Error("tokens.dat shape invalid");
    }
    cached = parsed;
    return parsed;
  } catch (err) {
    console.error("[tokens] Failed to parse tokens.dat:", err);
    cached = emptyFile();
    return cached;
  }
}

async function persist(next: TokensFile): Promise<void> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    const path = tokensPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(next, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await rename(tmpPath, path);
    } catch (err) {
      // Clean up orphan tmpfile on failure so we don't accumulate cruft.
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    cached = next;
  } finally {
    release();
  }
}

/** Store a token for the given connection id. Each token records whether
 *  it was encrypted at write time, so a later keychain-lock doesn't cause
 *  us to misread an encrypted blob as plaintext (or vice versa). */
export async function setToken(
  connectionId: string,
  token: string,
): Promise<void> {
  const file = await load();
  const safeStorage = getSafeStorage();
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const stored: StoredToken = canEncrypt
    ? {
        encrypted: true,
        value: safeStorage.encryptString(token).toString("base64"),
      }
    : { encrypted: false, value: token };
  await persist({
    encryptionAvailable: canEncrypt,
    tokens: { ...file.tokens, [connectionId]: stored },
  });
}

/** Retrieve a token. Returns null if no token is stored OR decryption fails
 *  (e.g., keychain locked, migrated machine). UI can prompt for re-entry. */
export async function getToken(connectionId: string): Promise<string | null> {
  const file = await load();
  const entry = file.tokens[connectionId];
  if (!entry) return null;
  if (!entry.encrypted) return entry.value;
  try {
    return getSafeStorage().decryptString(Buffer.from(entry.value, "base64"));
  } catch (err) {
    console.warn(
      `[tokens] Failed to decrypt token for connection ${connectionId}:`,
      err,
    );
    return null;
  }
}

export async function removeToken(connectionId: string): Promise<void> {
  const file = await load();
  if (!(connectionId in file.tokens)) return;
  const { [connectionId]: _removed, ...rest } = file.tokens;
  await persist({
    encryptionAvailable: file.encryptionAvailable,
    tokens: rest,
  });
}

/** Whether tokens are being stored encrypted on this machine. Renderer
 *  surfaces a warning banner when false. Re-queries safeStorage on each
 *  call because keychain availability can flip mid-session (sleep+lock). */
export async function isEncryptionAvailable(): Promise<boolean> {
  const live = getSafeStorage().isEncryptionAvailable();
  const file = await load();
  return live && file.encryptionAvailable;
}

/** TEST SEAM. Drop the in-process tokens cache so a test can point at a
 *  fresh temp `userData` dir between cases. No effect in production. */
export function _resetTokensCacheForTesting(): void {
  cached = null;
  writeLock = Promise.resolve();
}
