import { settingsApi } from "../../api/config";
import { ApiError, request } from "../../api/core";
import type { ErrorKind, RateLimitData } from "./types";

/**
 * Result of saving a session key and immediately checking it against
 * claude.ai. Lets the UI report a *specific* outcome instead of a blind
 * "Saved!" that says nothing about whether the key actually works.
 */
export type SaveValidateResult =
  | { kind: "ok"; data: RateLimitData }
  | { kind: "invalid"; message: string; errorKind?: ErrorKind }
  | { kind: "unreachable"; message: string };

const USAGE_ENDPOINT = "/api/plugins/claude-usage";

/** Fetch fresh usage data and classify it. The server keys its usage cache to
 * the session key, so this reflects the key just saved (not a stale entry).
 * `fresh` carries the old `cache: "no-store"` AND opts out of the client's
 * in-flight GET dedup — a validation read must never be answered by the usage
 * poll's request, which may have been issued before the key was written. */
async function validate(): Promise<SaveValidateResult> {
  let data: RateLimitData | null;
  try {
    data = await request<RateLimitData>(USAGE_ENDPOINT, { fresh: true });
  } catch (err) {
    if (!(err instanceof ApiError) || err.unreachable) {
      return { kind: "unreachable", message: "Could not reach the server" };
    }
    // The endpoint returns 200 even for credential failures (the error rides
    // in the body). A non-2xx means the server itself faulted — surface its
    // `detail` if present and treat it as transient, not "unreachable".
    const detail = err.details?.detail;
    return {
      kind: "invalid",
      message:
        typeof detail === "string" ? `${err.message}: ${detail}` : err.message,
      errorKind: "unavailable",
    };
  }

  // A non-JSON body parses to null rather than throwing (see api/core).
  if (!data) {
    return { kind: "unreachable", message: "Server sent an invalid response" };
  }

  // A key was just saved, so needsSetup here means the save didn't stick.
  if (data.needsSetup) {
    return {
      kind: "invalid",
      message: "No session key is saved. Paste your sessionKey and try again.",
      errorKind: "unauthorized",
    };
  }
  if (data.error) {
    return { kind: "invalid", message: data.error, errorKind: data.errorKind };
  }
  return { kind: "ok", data };
}

/**
 * Persist a session key, then validate it end-to-end against claude.ai.
 *
 * Splitting the two steps is deliberate: `PUT /api/settings` only writes the
 * key to disk (it returns 200 for any well-formed string), so a successful
 * save proves nothing about the key. The follow-up `validate()` is what tells
 * the user whether the credential actually works.
 *
 * Pasting a key also turns auto-detect OFF in the same write: the toggle now
 * SELECTS the credential source (auto-detect ON = Claude Code's login wins),
 * so a paste must switch the source or the validate() below would read the
 * OTHER credential's numbers and report them as this key's.
 */
export async function saveAndValidate(
  sessionKey: string,
): Promise<SaveValidateResult> {
  // Remember the auto-detect state we're about to flip, so a FAILED validation
  // can put it back. Without the restore, a bad paste persisted
  // `autoDetectClaudeAccount: false` while the UI toggle still showed On — the
  // user walks away believing they stayed on auto-detect, with a broken key
  // silently selected. Default true mirrors the server's default.
  let previousAutoDetect = true;
  try {
    const settings = await settingsApi.get();
    previousAutoDetect = settings?.autoDetectClaudeAccount !== false;
  } catch {
    // Best-effort pre-read; the default above stands.
  }

  try {
    await settingsApi.update({
      claudeSessionKey: sessionKey,
      autoDetectClaudeAccount: false,
    });
  } catch (err) {
    // ApiError.message is the server's own `error` when it sent one, which is
    // the message worth showing; otherwise it names the failed operation.
    return {
      kind: "unreachable",
      message:
        err instanceof ApiError && !err.unreachable
          ? err.message
          : "Could not reach the server",
    };
  }

  const result = await validate();
  if (result.kind !== "ok" && previousAutoDetect) {
    // Best-effort restore. If even this write fails the validation error
    // below is still the actionable message; the toggle then shows a stale
    // value until the panel remounts (its settings fetch is latched per
    // mount), which a page reload also fixes.
    await settingsApi
      .update({ autoDetectClaudeAccount: true })
      .catch(() => null);
  }
  return result;
}
