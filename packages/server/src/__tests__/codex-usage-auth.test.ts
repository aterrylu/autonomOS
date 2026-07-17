import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Isolate the Codex home so reads never touch the dev machine's real ~/.codex.
// env-only at module load (no fs writes at import time — that would crash the
// Linux e2e CI job that imports every spec).
const TEST_DIR = join(tmpdir(), `autonomos-codex-auth-${randomUUID()}`);
process.env.CODEX_HOME = TEST_DIR;

const { readCodexAuth, readCodexIdentity, readChatGptBaseUrl } = await import(
  "../plugins/codex-usage/auth.js"
);

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;

const AUTH_FILE = join(TEST_DIR, "auth.json");
const CONFIG_FILE = join(TEST_DIR, "config.toml");

function writeAuth(json: unknown): void {
  writeFileSync(AUTH_FILE, JSON.stringify(json));
}

describe("codex auth — readCodexAuth (read-only)", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("reads the ChatGPT-plan OAuth token, account id, and JWT expiry", () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const access = makeJwt({ exp });
    writeAuth({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: access,
        refresh_token: "rt.secret",
        account_id: "acct-xyz",
      },
    });
    const auth = readCodexAuth();
    assert.ok(auth);
    assert.equal(auth.accessToken, access);
    assert.equal(auth.accountId, "acct-xyz");
    assert.equal(auth.authMode, "chatgpt");
    assert.equal(auth.expiresAt, exp * 1000);
  });

  it("falls back to an OPENAI_API_KEY install (no expiry, no account)", () => {
    writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-abc", tokens: {} });
    const auth = readCodexAuth();
    assert.ok(auth);
    assert.equal(auth.accessToken, "sk-abc");
    assert.equal(auth.authMode, "apikey");
    assert.equal(auth.expiresAt, Number.POSITIVE_INFINITY);
    assert.equal(auth.accountId, undefined);
  });

  it("returns null when auth.json is absent or has no credential", () => {
    assert.equal(readCodexAuth(), null);
    writeAuth({ auth_mode: "chatgpt", tokens: {} });
    assert.equal(readCodexAuth(), null);
  });

  it("does NOT write auth.json (read-only) — file is untouched by a read", () => {
    const original = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: makeJwt({ exp: 1 }), refresh_token: "rt" },
    });
    writeFileSync(AUTH_FILE, original);
    readCodexAuth();
    readCodexIdentity();
    // A refresh would have rewritten the file (rotated tokens, new last_refresh).
    assert.equal(
      readFileSync(AUTH_FILE, "utf-8"),
      original,
      "auth.json must be byte-identical after reads — never refreshed/written",
    );
  });
});

describe("codex auth — readCodexIdentity (JWT decode, display-only)", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("decodes email, name, and chatgpt_plan_type from the id_token", () => {
    const idToken = makeJwt({
      email: "terry@example.com",
      name: "Terry Lu",
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    });
    writeAuth({
      tokens: { access_token: makeJwt({ exp: 1 }), id_token: idToken },
    });
    const identity = readCodexIdentity();
    assert.deepEqual(identity, {
      email: "terry@example.com",
      name: "Terry Lu",
      planType: "pro",
    });
  });

  it("returns null when there's no id_token", () => {
    writeAuth({ tokens: { access_token: makeJwt({ exp: 1 }) } });
    assert.equal(readCodexIdentity(), null);
  });
});

describe("codex auth — readChatGptBaseUrl (config.toml override)", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("defaults to the ChatGPT backend base when unset", () => {
    assert.equal(readChatGptBaseUrl(), "https://chatgpt.com/backend-api");
  });

  it("honors chatgpt_base_url and appends /backend-api for bare chatgpt.com", () => {
    writeFileSync(
      CONFIG_FILE,
      '# comment\nchatgpt_base_url = "https://chatgpt.com"\n',
    );
    assert.equal(readChatGptBaseUrl(), "https://chatgpt.com/backend-api");
  });

  it("uses a custom proxy base verbatim (trailing slash trimmed)", () => {
    writeFileSync(
      CONFIG_FILE,
      "chatgpt_base_url = 'https://proxy.acme/api/'\n",
    );
    assert.equal(readChatGptBaseUrl(), "https://proxy.acme/api");
  });
});
