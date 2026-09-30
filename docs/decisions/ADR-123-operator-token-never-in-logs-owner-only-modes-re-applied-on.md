## ADR-123: Operator token never in logs; owner-only modes re-applied on every boot (V8)

- **Date:** 2026-09-30
- **Decided by:** SecurityFix-Auth@autonomOS (agent) implementing audit finding V8, which Terry approved for fixing. The home/ancestor refusal was added at TeamLead@autonomOS's direction after an incident during this PR's own testing (below).
- **Context:** The audit (V8, Medium) found the operator token in a log other users could read. Three things combined:
  - The boot banner printed `first4...last4`, which IS the whole token when it has 8 chars or fewer. The live install's token was 4 chars.
  - `logs/autonomos.log` was created with the process umask (0644).
  - `configDir.ts` applied 0700 to the config root only on creation, so installs from before #301 kept a 0755 root, and any other local account could read the log.
  - Schedule-run history and the env-presets dir were also created loose.
  - ADR-117 had already moved `--print-url` to the terminal only (`writeUnlogged`).
- **Decision:**
  1. **Banner** (`describeTokenForLog`). A token of 16+ chars shows `…<last4> (N chars; the full value is never logged)`. A shorter one shows `(hidden, N chars)`: 4 chars of a 12-char token is a third of it.
  2. **Log files 0600.** `initFileLogging` passes 0600 to the rotating writer, which applies it on creation, re-applies it to an existing file, and uses it for every fresh segment after a rotation.
  3. **`--print-url` stays terminal-only** (ADR-117 decision 8), now pinned by an integration test that boots with a short token and searches every log segment.
  4. **`tightenConfigDirModes()` runs on every boot, before the log opens.** It removes group/other bits (`mode & ~0o077`) from the config root, from `logs/`, `schedule-runs/`, `env-presets/`, `agent-tokens/` and their files, and from `token` and `autonomos.pid`. It only ever removes bits, never touches the owner's, skips symlinks and paths owned by another uid, and never throws. When it changes anything, it logs one `[security]` line naming the paths.
  5. **It refuses `/`, any home directory, and any ANCESTOR of a home.** It checks both `$HOME` and `os.userInfo().homedir`, which reads the password database, so a spoofed `$HOME` can't hide the real one. An operator who points `AUTONOMOS_CONFIG_DIR` at `~` or `/Users` gets no chmod at all.
  6. New files are created owner-only: `appendRun` writes 0600, and `env-presets/` is created 0700.
- **Rationale:**
  - Masking at the source beats scrubbing the log afterwards: the value never enters the tee.
  - Re-applying modes on every boot is the only way to reach the installs the audit found, which predate the creation-time fix.
  - Removing group/other bits can't lock out the owner, so it keeps the standing "upgrades never break auth" invariant without a migration step. The same short token still authenticates, pinned by the integration test.
  - Refusing homes and their ancestors limits the blast radius of a misconfigured `AUTONOMOS_CONFIG_DIR`. It is also the lesson of the incident below: a guard that exists only in a test is not a guard.
- **Alternatives considered:**
  - **Show only the length for every token.** Rejected: last-4 of a 64-hex token discloses 16 of 256 bits and lets an operator tell two instances' tokens apart.
  - **Redact the token inside the logger.** A second line of defense, but the logger would need the secret to find it, and substrings like the 4-char live token would false-positive everywhere. Not taken; the banner and `--print-url` are the only places the server prints the token.
  - **chmod the whole config tree recursively.** Rejected: `agents/`, `templates/` and similar hold no secrets. Walking them adds boot cost and could surprise operators who share template dirs. Root 0700 already blocks traversal.
  - **Tighten only when an upgrade marker says we came from an old version.** Rejected: modes can drift after install too (a restored backup, a manual chmod), and re-checking every boot costs a few stat calls.
- **Incident during implementation (recorded for honesty):** a mutation test that deleted the home-directory guard ran against a unit test that called the function on the REAL `homedir()`, and it chmodded the operator's home to 0700. The original mode was unknown (most likely 0750, the macOS default), so it was reported rather than guessed. Terry restores it. Fixes:
  - The guard now lives in the function itself (decision 5), as a pure predicate tested with made-up paths.
  - Every fs test runs under `isolateHome` and asserts the isolation at module load.
  - Each guard-removing mutation was re-run with the real `~` and `/Users` modes snapshotted before and after: unchanged.
- **Source:** Security audit phase 1 (SecurityAudit-Claude, V8). Brief from TeamLead@autonomOS to SecurityFix-Auth@autonomOS. PR `terry/security-token-log-hygiene`.
