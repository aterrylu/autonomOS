/**
 * Why is Claude usage unavailable? — a pure classifier.
 *
 * Every path that ends without usage numbers used to surface as a bare label
 * ("n/a", "setup needed", "delayed") with no cause. On a machine nobody else
 * can inspect, that label was undiagnosable. This module turns each failure
 * into a typed {@link UsageDiagnosis}: a stable `code`, a one-line `summary`
 * of what happened, and a `hint` saying what to check or do.
 *
 * PURE by design: callers gather the facts (token-read failure, HTTP outcome,
 * plan labels, auth-method hints) and this module only classifies. That keeps
 * it testable without a keychain or network, and keeps it independent of how
 * the token is read (the keychain path is async + memoized elsewhere).
 *
 * Privacy contract: inputs carry plan LABELS and env var NAMES only — never a
 * token, never an organization name or id, never an email. Summaries and hints
 * are safe to show in the dashboard and write to the rotating log.
 *
 * READ-ONLY contract: nothing here suggests or performs a token refresh
 * (ADR-048). Expired/rejected hints point the user at running `claude`, which
 * refreshes its OWN token.
 */

/** Stable identifiers — the dashboard keys its short label off these. */
export type UsageDiagnosisCode =
  | "no_login"
  | "login_unreadable"
  | "auto_detect_off"
  | "session_key_rejected"
  | "no_subscription_org"
  | "keychain_denied"
  | "keychain_timeout"
  | "credentials_unreadable"
  | "credentials_malformed"
  | "api_key_auth"
  | "cloud_provider_auth"
  | "token_expired"
  | "token_rejected"
  | "usage_forbidden"
  | "rate_limited"
  | "network_unreachable"
  | "http_error"
  | "unexpected_response"
  | "no_rolling_limits";

export interface UsageDiagnosis {
  code: UsageDiagnosisCode;
  /** What happened, in one sentence. */
  summary: string;
  /** What to check or do next. */
  hint: string;
  /** True when the cause clears on its own (network drop, rate limit, 5xx).
   *  The dashboard only promises "temporarily" / "not your key" when set —
   *  one definition, here, instead of a second guess in the UI. */
  transient?: boolean;
}

/**
 * Why the last token read failed, as reported by the credential reader. The
 * shape mirrors the reader's own failure record; only non-secret fields.
 *   - keychain: `security find-generic-password` outcome. Exit 44 = item not
 *     found; 36 / 51 / 128 = user interaction required / denied / cancelled.
 *   - file: the `.credentials.json` read — an errno, or present-but-unparseable.
 */
export type CredentialReadFailure =
  | {
      source: "keychain";
      exitCode: number | null;
      timedOut?: boolean;
      stderr?: string;
      /** Spawn-level failure ("ENOENT" = no `security` binary). */
      errno?: string | null;
      /** `security` answered, but not with a usable credentials blob. */
      parseFailed?: boolean;
    }
  | {
      source: "file";
      errno?: string | null;
      parseFailed?: boolean;
    };

/** Auth-method hints read from Claude Code's config — env var NAMES and
 *  presence flags only, never values. */
export interface AuthHints {
  /** `~/.claude.json` has an `oauthAccount` block (a claude.ai login ever ran). */
  hasOAuthAccount: boolean;
  /** Claude Code is configured with an API key (a `primaryApiKey`, or
   *  ANTHROPIC_API_KEY in its settings env or this server's env). */
  apiKeyConfigured: boolean;
  /** Claude Code routes through a cloud provider instead of claude.ai. */
  cloudProvider: "bedrock" | "vertex" | null;
  /** CLAUDE_CONFIG_DIR is set for THIS server process. */
  configDirOverride: boolean;
  /** Claude Code's config files were readable (or simply absent). False when
   *  one exists but couldn't be read/parsed — then an "API key" guess from
   *  the absence of an oauthAccount would be unfounded. */
  configReadable: boolean;
  /** Display path of the credentials file this server looks at ("~/…"). */
  credentialsPath: string;
}

/** Plan labels from Claude Code's config and the token (never names/ids). */
export interface PlanHints {
  organizationType?: string;
  billingType?: string;
  seatTier?: string;
  subscriptionType?: string;
}

/** Spend signals from the usage response itself. */
export interface SpendHints {
  /** `spend.enabled` — the account is metered by spend. */
  spendEnabled?: boolean;
  /** `spend.limit` or `extra_usage.monthly_limit` is set. */
  hasSpendLimit?: boolean;
  /** The response carries a `limits[]` array with entries. */
  hasLimitsArray?: boolean;
}

const RELOGIN =
  "Run `claude` once on this machine — it refreshes its own login.";

// ── Missing credential ────────────────────────────────────────────────────

/**
 * No usable token was found. Distinguishes "never logged in" from "logged in
 * but we couldn't READ it" and from "logged in a way that has no subscription
 * usage at all". Precedence: a read failure that proves a login exists beats
 * an auth-method guess, which beats plain absence.
 */
export function diagnoseMissingLogin(input: {
  platform: NodeJS.Platform | string;
  failures: CredentialReadFailure[];
  auth: AuthHints;
}): UsageDiagnosis {
  const { platform, failures, auth } = input;
  const keychain = failures.find(
    (f): f is Extract<CredentialReadFailure, { source: "keychain" }> =>
      f.source === "keychain",
  );
  const file = failures.find(
    (f): f is Extract<CredentialReadFailure, { source: "file" }> =>
      f.source === "file",
  );

  if (keychain?.timedOut) {
    return {
      code: "keychain_timeout",
      summary:
        "Reading the Claude Code login from the macOS keychain timed out.",
      hint: "The login keychain is probably locked. Unlock it (log in to the Mac, or open Keychain Access), then wait a minute.",
    };
  }
  if (
    keychain &&
    keychain.exitCode !== null &&
    [36, 51, 128].includes(keychain.exitCode)
  ) {
    return {
      code: "keychain_denied",
      summary: "macOS denied access to the Claude Code login in the keychain.",
      hint: 'Open Keychain Access, find the "Claude Code-credentials" item, and allow access for the autonomOS server — or run autonomOS from a logged-in user session.',
    };
  }
  if (file?.parseFailed || keychain?.parseFailed) {
    return {
      code: "credentials_malformed",
      summary:
        "The Claude Code credentials file exists but couldn't be parsed.",
      hint: RELOGIN,
    };
  }
  if (file?.errno === "EACCES" || file?.errno === "EPERM") {
    return {
      code: "credentials_unreadable",
      summary:
        "The Claude Code credentials file exists but this server can't read it.",
      hint: "autonomOS must run as the same user as Claude Code. Check the owner and permissions of .credentials.json.",
    };
  }

  if (auth.cloudProvider) {
    const name =
      auth.cloudProvider === "bedrock" ? "Amazon Bedrock" : "Google Vertex AI";
    return {
      code: "cloud_provider_auth",
      summary: `Claude Code is set up to use ${name}, which has no Claude subscription usage to show.`,
      hint: "Usage limits only exist for claude.ai subscription logins. Track spend in your cloud console instead.",
    };
  }
  if (auth.apiKeyConfigured && !auth.hasOAuthAccount && auth.configReadable) {
    return {
      code: "api_key_auth",
      summary:
        "Claude Code is set up with an API key, which has no subscription usage limits to show.",
      hint: "Usage limits only exist for claude.ai subscription logins. API-key usage is billed per token in the Anthropic Console.",
    };
  }

  const where =
    platform === "darwin"
      ? `in the macOS keychain or ${auth.credentialsPath}`
      : `in ${auth.credentialsPath}`;
  const configHint = auth.configDirOverride
    ? " This server has CLAUDE_CONFIG_DIR set — make sure Claude Code uses the same value."
    : " If Claude Code runs with CLAUDE_CONFIG_DIR set, start autonomOS with the same value.";
  // Measured: `security` answers "item not found" (exit 44) both for a user who
  // never logged in AND for a server running under another USER or HOME (the
  // login keychain is found through HOME) — so name that possibility too.
  const serviceHint =
    platform === "darwin"
      ? " The keychain is searched as this server's user and HOME — if autonomOS runs as a service, it must run as you."
      : "";
  // Claude Code's config SAYS a claude.ai login ran here, yet no token was
  // readable: that is not "never logged in" — don't send the user to log in.
  if (auth.hasOAuthAccount) {
    return {
      code: "login_unreadable",
      summary: `Claude Code has a login on this machine, but its token couldn't be read ${where}.`,
      hint: `The keychain may be locked, or autonomOS may be running as a different user or HOME than Claude Code.${serviceHint}${configHint}`,
    };
  }
  return {
    code: "no_login",
    summary: `No Claude Code login found ${where}.`,
    hint: `Run \`claude\` and log in with a claude.ai account, or paste a session key.${configHint}${serviceHint}`,
  };
}

// ── Fetch outcome ─────────────────────────────────────────────────────────

/** The usage call's outcome, as far as diagnosis needs it. */
export type FetchOutcome =
  | { status: "stale" }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | {
      status: "unavailable";
      /** network = the request never completed; http = a non-2xx answer;
       *  parse = a 2xx whose body wasn't the expected JSON. */
      cause?: "network" | "http" | "parse";
      httpStatus?: number;
    };

export function diagnoseFetchFailure(outcome: FetchOutcome): UsageDiagnosis {
  switch (outcome.status) {
    case "stale":
      return {
        code: "token_expired",
        summary: "The Claude Code login token on this machine has expired.",
        hint: `${RELOGIN} autonomOS never refreshes it, because that would log Claude Code out.`,
      };
    case "unauthorized":
      return {
        code: "token_rejected",
        summary: "Anthropic rejected the Claude Code login token (HTTP 401).",
        hint: RELOGIN,
      };
    case "rate_limited":
      return {
        code: "rate_limited",
        summary: "Anthropic is rate-limiting usage requests (HTTP 429).",
        hint: "Nothing to fix — this clears on its own within a few minutes.",
        transient: true,
      };
    case "unavailable":
      if (outcome.cause === "http" && outcome.httpStatus === 403) {
        return {
          code: "usage_forbidden",
          summary: "Anthropic refused the usage request (HTTP 403).",
          hint: "Either this account isn't allowed to read its usage, or a proxy or firewall is blocking api.anthropic.com. Check whether `/usage` works inside Claude Code on this machine.",
        };
      }
      if (outcome.cause === "http") {
        const serverSide =
          outcome.httpStatus !== undefined && outcome.httpStatus >= 500;
        return {
          code: "http_error",
          transient: serverSide,
          summary: `The usage API answered with HTTP ${outcome.httpStatus ?? "error"}.`,
          hint: serverSide
            ? "Anthropic-side problem — it usually clears on its own."
            : "If this persists, a proxy may be rewriting requests to api.anthropic.com.",
        };
      }
      if (outcome.cause === "parse") {
        return {
          code: "unexpected_response",
          summary: "The usage API returned something that wasn't usage data.",
          hint: "A proxy or captive portal may be intercepting api.anthropic.com. Try from another network.",
        };
      }
      return {
        code: "network_unreachable",
        transient: true,
        summary: "Couldn't reach Anthropic's usage API (api.anthropic.com).",
        hint: "Check the network. Behind a corporate proxy, the autonomOS server needs the same proxy settings as your browser.",
      };
  }
}

// ── Successful call, no rolling windows ───────────────────────────────────

/** Friendly plan label from Claude Code's plan fields ("claude_enterprise" →
 *  "Enterprise"). Undefined when nothing identifies the plan. */
export function planLabel(plan: PlanHints): string | undefined {
  const raw =
    plan.organizationType?.trim() ||
    plan.seatTier?.trim() ||
    plan.subscriptionType?.trim();
  if (!raw) return undefined;
  const words = raw
    .replace(/^claude[_\s-]*/i, "")
    .split(/[_\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The usage call SUCCEEDED but no window could be read from it — neither the
 * flat fields nor `limits[]` — the literal "n/a" case. Deliberately does NOT
 * assert the account has no limits: the first report of this was a Team plan
 * that DOES have 5-hour and weekly limits, which the response carried in a
 * shape we didn't read yet. So the hint asks for the one observation that
 * tells the two apart (`/usage` in Claude Code), and mentions spend billing
 * only when the response itself shows it with no list of limits at all.
 */
export function diagnoseNoWindows(input: {
  plan: PlanHints;
  spend: SpendHints;
  /** The answer came from a pasted claude.ai session key, not the login. */
  viaSessionKey?: boolean;
}): UsageDiagnosis {
  const label = planLabel(input.plan);
  const onPlan = label ? ` (${label} plan)` : "";
  const spendOnly =
    (input.spend.spendEnabled === true || input.spend.hasSpendLimit === true) &&
    input.spend.hasLimitsArray !== true;
  return {
    code: "no_rolling_limits",
    summary: `Your ${input.viaSessionKey ? "session key" : "Claude login"} works, but the usage response had no 5-hour or weekly window we could read${onPlan}.`,
    hint: spendOnly
      ? "This account reports spend but no rolling limits. If `/usage` in Claude Code shows 5-hour or weekly bars, report it — the usage format has changed."
      : "Check `/usage` inside Claude Code. If it shows 5-hour or weekly bars, report it — the usage format has changed.",
  };
}

// ── Manual-key path and composition ───────────────────────────────────────

/** Auto-detect is off and no session key is saved. */
export function diagnoseAutoDetectOff(): UsageDiagnosis {
  return {
    code: "auto_detect_off",
    summary: "Auto-detect is off and no session key is saved.",
    hint: "Turn auto-detect on in the usage panel to use your Claude Code login, or paste a claude.ai session key.",
  };
}

/**
 * Diagnosis for an answer that carries an error but was built without one —
 * the manual session-key (claude.ai cookie) path. The existing error text is
 * already specific, so it becomes the summary; the kind picks code + hint.
 */
export function diagnoseFromError(input: {
  error: string;
  errorKind?: string;
}): UsageDiagnosis {
  const { error, errorKind } = input;
  switch (errorKind) {
    case "unauthorized":
      return {
        code: "session_key_rejected",
        summary: error,
        hint: "Paste a fresh sessionKey from claude.ai, or turn auto-detect on to use your Claude Code login.",
      };
    case "no_org":
      return {
        code: "no_subscription_org",
        summary: error,
        hint: "Use a session key from the claude.ai account that holds your subscription.",
      };
    case "stale_token":
      return { ...diagnoseFetchFailure({ status: "stale" }), summary: error };
    case "rate_limited":
      return {
        ...diagnoseFetchFailure({ status: "rate_limited" }),
        summary: error,
      };
    default:
      return {
        code: "http_error",
        summary: error,
        hint: "It usually clears on its own. If it persists, check the network or a proxy in front of claude.ai.",
        transient: true,
      };
  }
}

/** Fold a second, concurrent cause into a diagnosis's hint (a failed saved
 *  key AND a failed Claude Code login) so neither is hidden. */
export function withAlsoFailed(
  primary: UsageDiagnosis,
  other: UsageDiagnosis | undefined,
): UsageDiagnosis {
  if (!other || other.code === primary.code) return primary;
  return {
    ...primary,
    hint: `${primary.hint} Also: ${other.summary}`,
  };
}
