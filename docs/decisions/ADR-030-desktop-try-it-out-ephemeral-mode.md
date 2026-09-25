## ADR-030: Desktop "Try it out" (ephemeral) mode
**Date:** 2026-06-05
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session — discussion after #178 (Built-in server reachability fix). Terry: "Maybe for the DMG app, do you think it makes sense for you to allow users to essentially create configurations at a different path or use a temporary one?" → narrowed to ephemeral-only after pushback on full profile scope.

**Context:** Built-in mode (ADR-029) requires a brand-new user to commit to having `~/.autonomos/` populated on their first click. That's fine for users who plan to stick with the app, but it creates friction in three scenarios: (a) a user who just wants to "kick the tires" before committing, (b) demos / sharing the .app with a teammate, (c) our own QA — testing a new build without polluting prod state. We already have `AUTONOMOS_CONFIG_DIR` for dev-side isolation (`make dev`); what's missing is a UI surface that exposes it as a first-class capability.

A separate motivator: tonight (#178) we shipped a Built-in mode reachability fix that should have been caught during initial Phase 1B.2 testing. It wasn't, partly because there was no easy "spin up a fresh isolated autonomos and see if it works" path in the app. A sandbox UI makes that kind of QA the default, not an afterthought.

**Decision:** Add a fourth card to the Welcome screen — **"Try it out"** — that spawns a Built-in server with `AUTONOMOS_CONFIG_DIR=$TMPDIR/autonomos-ephemeral-<uuid>/` and a freshly generated random token. Nothing reads from or writes to `~/.autonomos/`. On Desktop quit the temp dir is `rm -rf`'d. On Desktop boot any leaked `autonomos-ephemeral-*` dirs older than 1 hour are cleaned up (best-effort recovery from crashes; macOS auto-cleans `$TMPDIR` every ~3 days anyway).

**Scope (explicitly minimal):**
- One Welcome card, three IPC lines, one server-side auth.ts change.
- **No named profiles.** Multi-profile UI was considered and rejected for v1 — "too much" per Terry. Ephemeral covers the dominant use case (try-then-commit or try-then-discard) without the cognitive load of profile management.
- **No persistent state.** The temp dir is the entire state surface. Quit = gone.
- **No title-bar badge yet.** The Welcome card name ("Try it out") is the user's mental model; we'll add a badge if it turns out users routinely confuse try-mode with real-mode.

**Token isolation contract:**
Pre-this-ADR, `auth.ts` hardcoded the token file to `~/.autonomos/token` regardless of `CONFIG_DIR`, per a comment that read "the auth token should be shared — one token for the user's machine." That made sense for worktree-based dev isolation (one user, multiple worktrees, shared token) but breaks the moment a profile is supposed to be isolated. The new behavior: `auth.ts` looks for `<CONFIG_DIR>/token` first, falls through to `~/.autonomos/token` only when CONFIG_DIR is non-default AND no per-config token exists (so existing worktree-dev setups don't surprise the user with auth failures). Default CONFIG_DIR resolves to the same path as before — fully backwards-compatible.

**Rationale:**
- **Composes with everything that already exists.** `AUTONOMOS_CONFIG_DIR` was already honored by the server; the mutual-exclusion contract (ADR-029) uses CONFIG_DIR-relative pid files so different config dirs can coexist; the #178 port/token fix makes spawned CC sessions correctly phone home to whichever port the ephemeral server bound to. No new mechanisms, just a new UI surface.
- **Solves the QA gap.** Every future Built-in / dashboard / spawn-path change should be testable by "open the DMG, click Try it out, exercise the feature, quit." That's the workflow that should have caught #178 earlier.
- **Onboarding win.** Distribute the .app to a colleague, they click Try it out, poke around for 10 minutes, quit, no residue on their machine. Removes the "do I really want to commit?" mental tax from first-contact.
- **Surfaces an isolation contract we already needed.** The token-in-CONFIG_DIR change is the right architecture for future profile support too — when we eventually want named profiles, the building block is in place.

**Alternatives considered:**
- **Full multi-profile UI (named + ephemeral, switcher, settings tab).** Considered first. Rejected explicitly: "Let's just get an ephemeral version of this. No need for profile complications. It's a bit too much." Ephemeral is the high-leverage subset; named profiles can be added later with no architectural rework.
- **Sandbox window served from a separate process (not the Built-in server).** Would require a second server binary or sandboxed runtime. Massive overkill — the same server binary running against a different CONFIG_DIR achieves identical isolation.
- **In-memory state (no temp dir, no disk persistence at all).** Would require a server mode that skips all disk writes (settings, schedules, sessions, templates). Big surface area; defeats the goal of "the server behaves identically to production." Disk-on-tmpdir is structurally the same as disk-on-`~/.autonomos`, just at a different path.
- **Token shared with prod (only CONFIG_DIR isolated).** Considered as a backwards-compat shortcut. Rejected: token-sharing across isolated profiles is exactly the cross-profile auth bleed we want to prevent. The auth.ts fallback handles backwards-compat for non-ephemeral cases.

**Implications:**
- `auth.ts` changes are fully backwards-compatible. Default CONFIG_DIR (`~/.autonomos/`) resolves to the same `~/.autonomos/token` path as before. Existing prod servers, worktree dev setups, and CI all see zero behavior change.
- The same CONFIG_DIR-aware token lookup works for future named profiles (ADR-031, if we ever ship it). The plumbing is sized for the bigger feature; the UI surface is sized for the immediate need.
- `cleanupLeakedEphemeralDirs()` is best-effort and runs at every Desktop boot. If it fails (`$TMPDIR` unreadable), it logs a warning and continues — never a boot-blocker.
- The "Try it out" server is regular Built-in mode pointed at a temp dir, so ALL the regular code paths (gateway, MCP, hooks, scheduler, templates, agent spawning) work identically. Easier to reason about than a separate "sandbox runtime."

**Testing:**
- Unit: `auth-config-dir.test.ts` (4 tests) covers env precedence, per-CONFIG_DIR token read, fresh-token generation, file permissions.
- Integration: booted the server with `env -i HOME=... PATH=... AUTONOMOS_CONFIG_DIR=/tmp/autonomos-try-test --embedded --port=0`. Confirmed (a) server bound to ephemeral port 58099 with no collision against prod 3100, (b) fresh token generated and written ONLY to `/tmp/autonomos-try-test/token` with mode `0o600`, (c) `~/.autonomos/` untouched throughout.

**Update (2026-06-29, ADR-051):** The "Try it out" Welcome-card UI is removed with the desktop app — see ADR-051. The **server-side `auth.ts` CONFIG_DIR-aware token isolation it introduced STAYS** — it is general isolation plumbing (worktree-dev today, future named profiles tomorrow), fully backwards-compatible, and independent of the ephemeral-mode UI that originally motivated it.

**Design follow-ups:**
- Add a title-bar "TRY MODE" badge if users start losing work to surprise-on-quit.
- Add a one-click "Save my Try Mode as a real connection" pathway (export tokens, prompt for confirmation) — turns the ephemeral session into the seed of a regular connection.
- Named profiles (ADR-031), if/when we have a real use case. The CONFIG_DIR + auth-token plumbing is already ready for it.
