import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TOKENS_FILENAME } from "../../shared/constants.js";
import {
  _resetTokensCacheForTesting,
  getToken,
  isEncryptionAvailable,
  removeToken,
  setToken,
} from "../config/tokens.js";
import {
  _resetElectronForTesting,
  _setElectronForTesting,
  type ElectronSafeStorage,
} from "../electron-deps.js";

/**
 * tokens.ts stores Connection bearer tokens. The security-sensitive
 * behaviors we lock down:
 *   - round-trip through safeStorage when encryption is available
 *   - persist plaintext (with encrypted:false) when it is NOT — and read it
 *     back without trying to decrypt
 *   - the per-token `encrypted` flag survives a mid-session keychain flip
 *     (the dangerous edge: misreading an encrypted blob as plaintext)
 *   - tokens.dat is always written mode 0o600
 *   - decrypt failure yields null (prompt for re-entry), never throws
 *
 * Electron's `app` + `safeStorage` are injected via the electron-deps seam;
 * the real `electron` package is never loaded.
 */

let userData: string;

/** A reversible fake cipher so we can assert encrypt≠plaintext yet decrypt
 *  recovers it. Prefixed so a "wrong key" (different prefix) decrypt throws. */
function makeFakeSafeStorage(opts: {
  available: boolean;
  prefix?: string;
}): ElectronSafeStorage {
  const prefix = opts.prefix ?? "ENC1:";
  return {
    isEncryptionAvailable: () => opts.available,
    encryptString: (plaintext: string): Buffer =>
      Buffer.from(prefix + plaintext, "utf-8"),
    decryptString: (encrypted: Buffer): string => {
      const s = encrypted.toString("utf-8");
      if (!s.startsWith(prefix)) {
        throw new Error("decrypt failed: wrong key / corrupt blob");
      }
      return s.slice(prefix.length);
    },
  };
}

function install(safeStorage: ElectronSafeStorage): void {
  _setElectronForTesting({
    app: {
      isPackaged: false,
      name: "autonomos-test",
      getPath: () => userData,
    },
    safeStorage,
  });
  _resetTokensCacheForTesting();
}

describe("tokens (encrypted store)", () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "autonomos-tokens-test-"));
  });

  afterEach(() => {
    _resetElectronForTesting();
    _resetTokensCacheForTesting();
    rmSync(userData, { recursive: true, force: true });
  });

  it("round-trips a token through safeStorage when encryption is available", async () => {
    install(makeFakeSafeStorage({ available: true }));
    await setToken("forge", "super-secret-token");
    assert.equal(await getToken("forge"), "super-secret-token");
  });

  it("writes the token ENCRYPTED on disk (plaintext is not present)", async () => {
    install(makeFakeSafeStorage({ available: true }));
    await setToken("forge", "plaintext-needle");
    const raw = await readFile(join(userData, TOKENS_FILENAME), "utf-8");
    assert.ok(
      !raw.includes("plaintext-needle"),
      "raw token must not appear in tokens.dat when encryption is on",
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.tokens.forge.encrypted, true);
  });

  it("stores plaintext (encrypted:false) when encryption is unavailable", async () => {
    install(makeFakeSafeStorage({ available: false }));
    await setToken("forge", "no-keychain-token");
    const raw = await readFile(join(userData, TOKENS_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.tokens.forge.encrypted, false);
    assert.equal(parsed.tokens.forge.value, "no-keychain-token");
    // And it reads back without attempting a decrypt.
    assert.equal(await getToken("forge"), "no-keychain-token");
  });

  it("writes tokens.dat with mode 0o600", async () => {
    install(makeFakeSafeStorage({ available: true }));
    await setToken("forge", "x");
    const mode = statSync(join(userData, TOKENS_FILENAME)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });

  it("keychain-flip edge: a token written encrypted is still decrypted after availability returns false", async () => {
    // Write while encryption is available.
    const ss = makeFakeSafeStorage({ available: true });
    install(ss);
    await setToken("forge", "secret");

    // Mid-session the keychain locks → isEncryptionAvailable() now false, but
    // decryptString still works. The per-token `encrypted:true` flag must drive
    // the read path, NOT the live availability probe — otherwise we'd return
    // the encrypted blob verbatim as if it were plaintext.
    const flipped: ElectronSafeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: ss.encryptString,
      decryptString: ss.decryptString,
    };
    _setElectronForTesting({
      app: { isPackaged: false, name: "t", getPath: () => userData },
      safeStorage: flipped,
    });
    _resetTokensCacheForTesting(); // force re-read from disk

    assert.equal(await getToken("forge"), "secret");
  });

  it("returns null (does not throw) when decryption fails", async () => {
    // Write with one key.
    install(makeFakeSafeStorage({ available: true, prefix: "KEYA:" }));
    await setToken("forge", "secret");

    // Re-open with a safeStorage whose decrypt rejects this blob (migrated
    // machine / different keychain). Must yield null, not throw.
    _setElectronForTesting({
      app: { isPackaged: false, name: "t", getPath: () => userData },
      safeStorage: makeFakeSafeStorage({ available: true, prefix: "KEYB:" }),
    });
    _resetTokensCacheForTesting();

    assert.equal(await getToken("forge"), null);
  });

  it("returns null for an unknown connection id", async () => {
    install(makeFakeSafeStorage({ available: true }));
    assert.equal(await getToken("never-stored"), null);
  });

  it("removeToken deletes only the targeted connection", async () => {
    install(makeFakeSafeStorage({ available: true }));
    await setToken("a", "tok-a");
    await setToken("b", "tok-b");
    await removeToken("a");
    assert.equal(await getToken("a"), null);
    assert.equal(await getToken("b"), "tok-b");
  });

  it("removeToken on an absent id is a no-op (does not create the file or throw)", async () => {
    install(makeFakeSafeStorage({ available: true }));
    await removeToken("ghost");
    assert.equal(
      existsSync(join(userData, TOKENS_FILENAME)),
      false,
      "no-op remove must not write a file",
    );
  });

  it("isEncryptionAvailable reflects BOTH the live probe and the stored flag", async () => {
    // Stored with encryption available.
    install(makeFakeSafeStorage({ available: true }));
    await setToken("forge", "x");
    assert.equal(await isEncryptionAvailable(), true);

    // Live probe flips to false → overall false even though file says true.
    _setElectronForTesting({
      app: { isPackaged: false, name: "t", getPath: () => userData },
      safeStorage: makeFakeSafeStorage({ available: false }),
    });
    _resetTokensCacheForTesting();
    assert.equal(await isEncryptionAvailable(), false);
  });

  it("tolerates a corrupt tokens.dat by falling back to an empty store", async () => {
    install(makeFakeSafeStorage({ available: true }));
    // Hand-write garbage.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(userData, TOKENS_FILENAME),
      "{ not valid json",
      "utf-8",
    );
    _resetTokensCacheForTesting();
    assert.equal(await getToken("anything"), null);
    // Recovers: a fresh write succeeds.
    await setToken("forge", "recovered");
    assert.equal(await getToken("forge"), "recovered");
  });
});
