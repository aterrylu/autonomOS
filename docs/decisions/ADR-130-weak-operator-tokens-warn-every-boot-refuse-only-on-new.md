## ADR-130: Weak operator tokens: warn every boot, refuse only on new network installs, rotate in one command (V2b)

- **Date:** 2026-09-30
- **Decided by:** SecurityFix-Auth@autonomOS (agent) implementing audit finding V2 part (b), which Terry approved for fixing within the standing invariant "upgrades never break auth". The plan was sent to TeamLead@autonomOS before building. The dashboard banner is held for Terry's design pick and ships separately. Changing the bind default is a separate proposal and is not in this decision.
- **Context:** The audit (V2, High) found that a weak operator token is accepted on a network bind. Every token autonomOS generates is 64 hex characters, so weak ones come only from an operator-set `AUTONOMOS_TOKEN`, usually a source install's `.env`. Upgrades deliberately carry that forward (`install-source.sh`). The live install's token was 4 characters. V2a (ADR-124) throttles online guessing, but a 4-character token still falls in hours at the global ceiling. Refusing weak tokens outright would lock existing installs out on upgrade, which the invariant forbids. The only warning was a console line for env tokens under 8 characters, and file tokens were never checked.
- **Decision:**
  1. **Weak** means fewer than 32 characters, or fewer than 8 distinct characters (`isWeakToken`). This applies to both env and file tokens.
  2. **Existing install** (the config dir already holds `agents/`, `templates/`, `logs/` or `settings.json`, checked before this boot creates anything): never refused. Every boot logs a `⚠ SECURITY` warning naming the length and the source and pointing at `autonomos token rotate`. `GET /api/system/version` reports `tokenWarning: {length, source, networkBind}` (never the token) for the dashboard.
  3. **New install** with a weak token **on a network bind**: the server refuses to start (exit 2). The message says why, how to fix it, and how to override it. A hand-written token file alone doesn't make an install "existing". Overrides: `--allow-weak-token` / `AUTONOMOS_ALLOW_WEAK_TOKEN=1`, or a loopback `--host`. Both start with the warning.
  4. **`autonomos token rotate`** writes a fresh 64-hex `<configDir>/token`, 0600 and atomic. The env var outranks that file, so rotate comments `AUTONOMOS_TOKEN` out of the `.env` the server reads (a source install's repo `.env`, or `--env-file=PATH`), keeping the file's mode and none of the old value. It warns if the current shell still exports the token, says the running server keeps the old token until restart, and prints the new sign-in link to the terminal only. **`autonomos token status`** reports strong or weak, the length and the source, never the value.
- **Rationale:**
  - **Warn every boot plus a dashboard signal** is as loud as possible without breaking the invariant. The one-command rotate removes the excuse for not fixing it, and it handles the env case, which is the real-world source of weak tokens.
  - **Refusing only NEW network installs** closes the door for everyone who hasn't yet depended on the weak token, and costs nobody an outage. Loopback is exempt because the token then only faces same-host processes.
  - **Why "fewer than 8 distinct characters"** catches `aaaa…` and `abab…` without a password-strength library.
  - **Why commenting the `.env` line out and not rewriting it** keeps a single source of truth (the 0600 file) and never leaves the new token in a second, possibly looser, file.
- **Alternatives considered:**
  - **Refuse weak tokens everywhere.** Rejected: it breaks existing installs on upgrade, violating the invariant.
  - **Auto-rotate a weak token at boot.** Rejected: it would silently log out every dashboard, script and remote client using it, and it can't reach an env-set token anyway.
  - **Only warn, never refuse.** Rejected for new installs: nothing depends on their weak token yet, so refusing is free.
  - **A zxcvbn-style entropy estimate.** Rejected as heavier than the problem. Real weak tokens here are short hand-typed values.
  - **Rotate also restarts the service.** Not taken: restarting drops live agent connections, so the operator should choose the moment. The verb says exactly what to run.
- **Residual risks (named):**
  - An existing weak-token install stays guessable (hours or days, per ADR-124) until the operator rotates. The warnings are the lever.
  - A token set in a place rotate can't see (a shell profile, a custom supervisor's env) keeps winning. Rotate warns only when the current shell exports it.
  - `autonomos start`'s CLI help claims a loopback default, but it binds all interfaces. That is noted for the bind-default proposal and not changed here.
- **Source:** Security audit phase 1 (SecurityAudit-Claude, V2) and ADR-117 follow-up 8 (token rotation). Brief from TeamLead@autonomOS to SecurityFix-Auth@autonomOS. PR `terry/security-weak-token`.
