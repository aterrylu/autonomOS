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
 * the session key, so this reflects the key just saved (not a stale entry). */
async function validate(): Promise<SaveValidateResult> {
  const res = await fetch(USAGE_ENDPOINT, {
    cache: "no-store",
  }).catch(() => null);
  if (!res) {
    return { kind: "unreachable", message: "Could not reach the server" };
  }
  if (!res.ok) {
    // The endpoint returns 200 even for credential failures (the error rides
    // in the body). A non-2xx means the server itself faulted — surface its
    // `detail` if present and treat it as transient, not "unreachable".
    let message = `Usage check failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body?.error) {
        message = body.detail ? `${body.error}: ${body.detail}` : body.error;
      }
    } catch {}
    return { kind: "invalid", message, errorKind: "unavailable" };
  }

  let data: RateLimitData;
  try {
    data = (await res.json()) as RateLimitData;
  } catch {
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
 */
export async function saveAndValidate(
  sessionKey: string,
): Promise<SaveValidateResult> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claudeSessionKey: sessionKey }),
  }).catch(() => null);

  if (!res?.ok) {
    let message = res
      ? `Failed to save (HTTP ${res.status})`
      : "Could not reach the server";
    if (res) {
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {}
    }
    return { kind: "unreachable", message };
  }

  return validate();
}
