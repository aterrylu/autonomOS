/**
 * Codex credentials — read STRICTLY READ-ONLY from `~/.codex/auth.json`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ INVARIANT (ADR-048): NEVER refresh, rotate, or WRITE the Codex token.    │
 * │                                                                          │
 * │ Codex authenticates via a ChatGPT-plan OAuth token that the Codex CLI    │
 * │ owns and rotates. OpenAI uses refresh-token ROTATION — minting a new     │
 * │ access token invalidates the old refresh token. If autonomOS refreshed   │
 * │ (POST auth.openai.com/oauth/token) and wrote auth.json back, the Codex   │
 * │ CLI's next refresh would hit `refresh_token_reused` and the user's Codex │
 * │ login would BREAK. So we only ever READ this file. There is deliberately │
 * │ no writer / refresher in this plugin. Do not add one.                    │
 * │                                                                          │
 * │ We can afford read-only because the Codex access token has a ~10-day TTL │
 * │ (vs Claude Code's ~8h) and the CLI keeps it fresh through normal use —   │
 * │ an expired read is rare and falls through to the on-disk rollout         │
 * │ fallback (see rolloutScanner.ts), never to a refresh.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `auth.json` shape (ChatGPT-plan install):
 *   { auth_mode: "chatgpt", OPENAI_API_KEY: null,
 *     tokens: { access_token, refresh_token, id_token, account_id },
 *     last_refresh: "<iso>" }
 * An API-key install instead has a top-level `OPENAI_API_KEY` string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexHome.js";

/** Default ChatGPT backend base — overridable via config.toml `chatgpt_base_url`
 *  (enterprise / proxy installs). See {@link readChatGptBaseUrl}. */
export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

/** A resolved Codex credential, read-only. The raw tokens are never logged. */
export interface CodexAuth {
  /** Bearer token for the usage API. For a ChatGPT-plan install this is the
   *  OAuth access token; for an API-key install it's the API key itself. */
  accessToken: string;
  /** `chatgpt_account_id` — sent as the `ChatGPT-Account-Id` header. */
  accountId?: string;
  /** Epoch ms when the access token expires, decoded from its JWT `exp`.
   *  `Number.POSITIVE_INFINITY` when there's no decodable expiry (API keys). */
  expiresAt: number;
  /** "chatgpt" (OAuth) or "apikey" — display + which windows to expect. */
  authMode: "chatgpt" | "apikey";
}

/** Best-effort display identity decoded from the id_token JWT. Display-only —
 *  we do NOT verify the signature (it's our own local token, shown as-is). */
export interface CodexIdentity {
  email?: string;
  name?: string;
  /** `chatgpt_plan_type` — e.g. "free", "plus", "pro". */
  planType?: string;
}

function authFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), "auth.json");
}

/** Read + parse `auth.json` read-only. Returns null when absent/unreadable. */
function readAuthJson(env: NodeJS.ProcessEnv = process.env): unknown {
  try {
    const raw = readFileSync(authFilePath(env), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload (the middle segment) without verifying the signature.
 * Base64url → JSON. Returns null on any malformation. NOT for auth decisions —
 * only to read display fields (email/plan) and the `exp` for staleness.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Epoch ms of a JWT's `exp` claim (seconds→ms), or +Infinity if undecodable. */
function jwtExpiryMs(jwt: string): number {
  const payload = decodeJwtPayload(jwt);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp * 1000 : Number.POSITIVE_INFINITY;
}

/**
 * Resolve the Codex credential, read-only. Supports both the ChatGPT-plan OAuth
 * install (tokens.access_token) and the API-key install (top-level
 * OPENAI_API_KEY). Returns null when no usable credential is present.
 */
export function readCodexAuth(
  env: NodeJS.ProcessEnv = process.env,
): CodexAuth | null {
  const json = readAuthJson(env) as {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: {
      access_token?: string;
      account_id?: string;
    };
  } | null;
  if (!json) return null;

  const accessToken = json.tokens?.access_token?.trim();
  if (accessToken) {
    return {
      accessToken,
      accountId: json.tokens?.account_id,
      expiresAt: jwtExpiryMs(accessToken),
      authMode: "chatgpt",
    };
  }

  // API-key install: the key doubles as the bearer, no expiry, no account id.
  const apiKey = json.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      accessToken: apiKey,
      expiresAt: Number.POSITIVE_INFINITY,
      authMode: "apikey",
    };
  }

  return null;
}

/**
 * Best-effort account identity for display. Decodes the id_token JWT (email,
 * name, chatgpt_plan_type). Read-only, no network, no signature check. Returns
 * null when there's no id_token (e.g. API-key installs).
 */
export function readCodexIdentity(
  env: NodeJS.ProcessEnv = process.env,
): CodexIdentity | null {
  const json = readAuthJson(env) as {
    tokens?: { id_token?: string };
  } | null;
  const idToken = json?.tokens?.id_token;
  if (!idToken) return null;

  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  // chatgpt_plan_type lives under the OpenAI auth namespace claim.
  const authClaim = payload["https://api.openai.com/auth"] as
    | { chatgpt_plan_type?: unknown }
    | undefined;
  const planType =
    typeof authClaim?.chatgpt_plan_type === "string"
      ? authClaim.chatgpt_plan_type
      : undefined;

  if (!email && !name && !planType) return null;
  return { email, name, planType };
}

/**
 * Read the `chatgpt_base_url` override from `~/.codex/config.toml`, if present.
 * Codex/CodexBar honor this for enterprise + proxy installs. We do a minimal
 * line scan (no TOML dependency): `chatgpt_base_url = "https://…"`. Returns the
 * default backend base when unset or unreadable.
 */
export function readChatGptBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const raw = readFileSync(join(codexHome(env), "config.toml"), "utf-8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.split("#", 1)[0].trim();
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() !== "chatgpt_base_url") continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      value = value.trim().replace(/\/+$/, "");
      if (value) {
        // Match CodexBar: a bare chatgpt.com host implies the /backend-api prefix.
        if (
          (value.startsWith("https://chatgpt.com") ||
            value.startsWith("https://chat.openai.com")) &&
          !value.includes("/backend-api")
        ) {
          value += "/backend-api";
        }
        return value;
      }
    }
  } catch (err) {
    // An ABSENT config.toml is the normal case (silent). But an EXISTING file we
    // can't read/parse (permissions, corruption) would otherwise silently pin an
    // enterprise/proxy user to the default host — every live fetch then 401s and
    // they fall to rollout forever with no clue why. Surface that case.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "[codex-usage] could not read ~/.codex/config.toml for chatgpt_base_url; using default:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return DEFAULT_CHATGPT_BASE_URL;
}
