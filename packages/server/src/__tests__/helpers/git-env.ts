/**
 * Environment for a test's own git fixtures: the current env minus every
 * GIT_* variable. Inside a git hook GIT_DIR (and friends) are exported, and a
 * fixture `git init`/`commit`/`worktree add` would otherwise act on the REAL
 * repository — one `git init` with a linked worktree's GIT_DIR flips the shared
 * repo to core.bare=true. `make check` already strips them; this keeps a suite
 * safe when run directly (e.g. `tsx --test <file>` from inside a hook).
 */
export function gitEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return { ...env, ...extra };
}
