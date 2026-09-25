## ADR-035: Claude Usage requires only a session key (drop org ID)
- **Date:** 2026-06-10 — **Decided by:** Human (Terry), implemented by CloudUsageOrg@autonomOS under DesktopApp@autonomOS lead
- **Context:** The Claude Usage plugin required two credentials in settings: a Claude session key AND a "last active org" UUID. The org field was an unnecessary friction point — particularly noticeable in the desktop-app onboarding flow — and was never strictly needed because `scanner.ts:fetchOrgId` already had a fallback path that resolves the org via claude.ai's bootstrap API using the session cookie.
- **Decision:** Session key is the only required credential. The org UUID is auto-resolved on first use via the existing bootstrap-API fallback, then cached. `claudeOrgId` remains as a deprecated field for back-compat (old `settings.json` parses cleanly; the settings PUT route accept-and-discards it; a stale config value is silently ignored rather than added to the cookie). No migration step.
- **Rationale:** Removes a confusing setup field whose value the system can derive itself. Smaller credential surface for desktop-app onboarding.
- **Alternatives considered:**
  - Keep org as an optional override — rejected; Terry's intent was to remove the field entirely, and the bootstrap fallback covers every case the manual field did.
  - Migrate existing `claudeOrgId` values to the cache on read — rejected; not worth the complexity for a field that resolves cheaply on first call.
- **Source:** CC session, DesktopApp issues sweep. Shipped in #202.
