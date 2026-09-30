/**
 * What the Projects list shows, derived from the server's repo-grouped
 * `/api/projects` (ADR: projects by git repository; worktrees fold into their
 * repo). Pure, so every rule below is unit-tested without rendering.
 *
 * - Automated runs (`headless`: an SDK / `codex exec` session, e.g. the PR
 *   security-review bot, 71% of sessions on a busy box) are hidden unless the
 *   viewer asks for them, and then appear inside their own repos.
 * - A session whose directory no longer exists (a merged worktree deleted by
 *   wt-sync) is not counted and sits behind a per-project toggle.
 * - Throwaway locations (`kind: "temp"`) and projects left with nothing but
 *   deleted-directory sessions go into ONE collapsed "Other" group.
 */

import type { ProjectInfo, ProjectSession } from "../store";

export interface ProjectsView {
  /** Repos and plain directories with something to show, newest first. */
  main: ProjectInfo[];
  /** Temp dirs + projects whose only sessions are in deleted directories. */
  other: ProjectInfo[];
  /** Automated runs across every project (the toggle's "Show N"). */
  automatedTotal: number;
}

/** A session counts as shown: interactive (or automated when shown) AND in a
 *  directory that still exists. `cwdExists` absent = unknown = assume it does. */
export function isShownSession(
  s: ProjectSession,
  showAutomated: boolean,
): boolean {
  return (showAutomated || !s.headless) && s.cwdExists !== false;
}

export function projectsView(
  projects: readonly ProjectInfo[],
  showAutomated: boolean,
): ProjectsView {
  const main: ProjectInfo[] = [];
  const other: ProjectInfo[] = [];
  let automatedTotal = 0;
  for (const p of projects) {
    automatedTotal += p.sessions.filter((s) => s.headless).length;
    // Automated runs leave the project entirely while hidden, so they don't
    // count, sort or surface through the removed-directory toggle either.
    const sessions = p.sessions
      .filter((s) => showAutomated || !s.headless)
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    if (sessions.length === 0) continue;
    const shaped: ProjectInfo = { ...p, sessions };
    const shown = sessions.some((s) => s.cwdExists !== false);
    if (p.kind === "temp" || !shown) other.push(shaped);
    else main.push(shaped);
  }
  return { main, other, automatedTotal };
}

/**
 * The branch chip for a session row: its git branch when the runtime recorded
 * one (Claude Code does), else the worktree it ran in, named relative to its
 * repo ("autonomOS-terry-x" under autonomOS → "terry-x"). Nothing for a
 * session in the project's own directory: there's no worktree to name.
 */
export function sessionChip(
  s: Pick<ProjectSession, "gitBranch" | "cwd">,
  project: Pick<ProjectInfo, "path" | "name">,
): string | undefined {
  if (s.gitBranch) return s.gitBranch;
  if (!s.cwd || s.cwd === project.path) return undefined;
  const base = s.cwd.split("/").filter(Boolean).pop();
  if (!base) return undefined;
  const prefix = `${project.name}-`;
  return base.startsWith(prefix) && base.length > prefix.length
    ? base.slice(prefix.length)
    : base;
}
