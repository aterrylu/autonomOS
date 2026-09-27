/**
 * Display labels for Projects rows.
 *
 * A project's label is its directory basename (the server's `name`), unless
 * another row has the same basename. Then each colliding row shows the fewest
 * trailing path segments that tell them apart: `/tmp/aq/work` and
 * `/tmp/ax/work` become "aq/work" and "ax/work", not two rows called "work".
 * Projects are discovered from `~/.claude/projects`, which every instance
 * on a box shares, so same-named dirs are routine (worktrees, scratch `work`
 * dirs). Cwd-less `unknown:<id>` groups keep their name: "Unknown" is their
 * deliberate label, and they have no path to disambiguate with.
 */

interface LabelledProject {
  path: string;
  name: string;
}

const segments = (path: string): string[] => path.split("/").filter(Boolean);

export function projectLabels(
  projects: readonly LabelledProject[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, LabelledProject[]>();
  for (const p of projects) {
    labels.set(p.path, p.name);
    if (p.path.startsWith("unknown:")) continue;
    const group = byName.get(p.name);
    if (group) group.push(p);
    else byName.set(p.name, [p]);
  }

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const segs = group.map((p) => segments(p.path));
    const longest = Math.max(...segs.map((s) => s.length));
    let resolved = false;
    for (let k = 2; k <= longest && !resolved; k++) {
      const tails = segs.map((s) => s.slice(-k).join("/"));
      if (new Set(tails).size === tails.length) {
        for (const [i, p] of group.entries()) labels.set(p.path, tails[i]);
        resolved = true;
      }
    }
    // Paths are the grouping key, so they're distinct; a tail can only fail to
    // separate them in degenerate spellings (e.g. a trailing slash). Fall back
    // to the full path, which is always unique.
    if (!resolved) for (const p of group) labels.set(p.path, p.path);
  }
  return labels;
}
