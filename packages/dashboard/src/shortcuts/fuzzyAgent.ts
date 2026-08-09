/**
 * Fuzzy agent matching for the ⌘K quick-switcher (see the quick-switcher ADR). Pure and
 * dependency-free so ranking is unit-testable.
 *
 * Scoring tiers (higher wins):
 *   1000  exact prefix               "disp" → "Dispatcher"
 *    800  word-boundary prefix       "auto" → "Shortcuts@autonomOS"
 *    600- substring (earlier better) "spat" → "Dispatcher"
 *    300- subsequence (fewer gaps better)  "dpr" → "DisPatcheR"
 *   null  no match
 */

const WORD_BOUNDARY = /[\s\-_@./]/;

/** Boundary at i: after a separator, or a camelCase lower→upper transition
 *  (checked on the ORIGINAL casing — the fleet's dominant naming style is
 *  "DeliveryAck"/"ReleaseRollout", where "roll" must hit the boundary tier). */
function isBoundary(original: string, i: number): boolean {
  const prev = original[i - 1] as string;
  const cur = original[i] as string;
  if (WORD_BOUNDARY.test(prev)) return true;
  return prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z";
}

export function fuzzyScore(query: string, name: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (q.length === 0) return 0;
  if (n.startsWith(q)) return 1000;

  for (let i = 1; i < n.length; i++) {
    if (isBoundary(name, i) && n.startsWith(q, i)) {
      return 800;
    }
  }

  const sub = n.indexOf(q);
  if (sub !== -1) return 600 - Math.min(sub, 100);

  // Subsequence: every query char in order; penalize total gap span.
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      if (first === -1) first = i;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  const span = last - first + 1;
  return 300 - Math.min(span - q.length, 100);
}

export interface AgentCandidate {
  id: string;
  name: string;
}

/**
 * Rank candidates for a query. Empty query lists everything in `rowOrder`
 * (the sidebar's rendered order — pinned agents first, familiar layout);
 * candidates missing from rowOrder (e.g. hidden by a collapsed hierarchy
 * group) sort after, by name — search is exactly the escape hatch that
 * reaches them. Ties on score break the same way.
 */
export function rankAgents(
  query: string,
  candidates: AgentCandidate[],
  rowOrder: string[],
): AgentCandidate[] {
  const pos = new Map(rowOrder.map((id, i) => [id, i]));
  const orderKey = (c: AgentCandidate) =>
    pos.has(c.id) ? (pos.get(c.id) as number) : rowOrder.length;

  const scored: Array<{ c: AgentCandidate; score: number }> = [];
  for (const c of candidates) {
    const score = fuzzyScore(query, c.name);
    if (score !== null) scored.push({ c, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byOrder = orderKey(a.c) - orderKey(b.c);
    if (byOrder !== 0) return byOrder;
    return a.c.name.localeCompare(b.c.name);
  });
  return scored.map((s) => s.c);
}
