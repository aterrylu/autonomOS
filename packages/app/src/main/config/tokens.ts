/**
 * Encrypted token storage for Connection bearer tokens.
 *
 * Uses Electron's `safeStorage` API which delegates to:
 *   macOS:   Keychain Services (via Security framework)
 *   Linux:   libsecret (when available) / kwallet / plaintext fallback
 *   Windows: DPAPI (Data Protection API)
 *
 * If `safeStorage.isEncryptionAvailable()` returns false, we fall back
 * to a plain JSON file with a flag the UI can use to warn the user.
 * Better than Open WebUI Desktop's approach (sniff token out of webview
 * `localStorage` into a mutable global at runtime — never persisted).
 *
 * Layout on disk (inside `app.getPath("userData")/tokens.dat`):
 *   {
 *     "encryptionAvailable": true,
 *     "tokens": {
 *       "<connection-id>": "<base64-encrypted-blob>" | "<plaintext>"
 *     }
 *   }
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

import { TOKENS_FILENAME } from "../../shared/constants.js";

interface TokensFile {
  encryptionAvailable: boolean;
  tokens: Record<string, string>;
}

let cached: TokensFile | null = null;
let writeLock: Promise<void> = Promise.resolve();

function tokensPath(): string {
  return join(app.getPath("userData"), TOKENS_FILENAME);
}

async function load(): Promise<TokensFile> {
  if (cached) return cached;

  const path = tokensPath();
  if (!existsSync(path)) {
    cached = {
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      tokens: {},
    };
    return cached;
  }

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as TokensFile;
    cached = parsed;
    return parsed;
  } catch (err) {
    console.error("[tokens] Failed to parse tokens.dat:", err);
    cached = {
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      tokens: {},
    };
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
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
    await rename(tmpPath, path);
    cached = next;
  } finally {
    release();
  }
}

/** Store a token for the given connection id, encrypting via safeStorage
 *  when available. Overwrites any existing token for the same id. */
export async function setToken(
  connectionId: string,
  token: string,
): Promise<void> {
  const file = await load();
  const stored = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString("base64")
    : token;
  await persist({
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    tokens: { ...file.tokens, [connectionId]: stored },
  });
}

/** Retrieve a token for the given connection id, decrypting if necessary.
 *  Returns null if no token is stored. */
export async function getToken(connectionId: string): Promise<string | null> {
  const file = await load();
  const stored = file.tokens[connectionId];
  if (!stored) return null;
  if (!file.encryptionAvailable) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch (err) {
    // Decryption can fail if the user's keychain is locked or if the encrypted
    // blob was migrated from another machine. Surface as null so the UI can
    // prompt for re-entry; logging at warn level.
    console.warn(
      `[tokens] Failed to decrypt token for connection ${connectionId}:`,
      err,
    );
    return null;
  }
}

/** Remove a token from storage. No-op if the id isn't present. */
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
 *  can use this to show a warning banner when false ("Tokens are NOT
 *  encrypted on this system — install gnome-keyring or KWallet"). */
export async function isEncryptionAvailable(): Promise<boolean> {
  const file = await load();
  return file.encryptionAvailable;
}

/** TEST-ONLY: reset the in-memory cache + write lock. */
export function _resetForTesting(): void {
  cached = null;
  writeLock = Promise.resolve();
}
