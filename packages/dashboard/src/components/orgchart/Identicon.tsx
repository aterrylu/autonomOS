/**
 * A per-agent identicon: a 5×5 mirrored grid seeded from the agent's ID (not
 * its name — agents may share a name, and each should still look like itself).
 * Muted, theme-aware colors so it reads as personality, not a status signal.
 */

/** FNV-1a: a small, stable 32-bit hash. */
export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The lit cells of the left half (3 columns × 5 rows), mirrored on draw. */
export function identiconCells(id: string): Array<[number, number]> {
  const h = hashId(id);
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if ((h >> (y * 3 + x)) & 1) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
  return cells;
}

export function Identicon({
  id,
  size,
  isLight,
  dim,
}: {
  id: string;
  size: number;
  isLight: boolean;
  /** An exited ghost: drawn faded like the rest of its card. */
  dim?: number;
}) {
  const hue = hashId(id) % 360;
  const bg = isLight ? `hsl(${hue} 18% 92%)` : `hsl(${hue} 12% 17%)`;
  const fg = isLight ? `hsl(${hue} 26% 44%)` : `hsl(${hue} 24% 62%)`;
  return (
    <svg
      aria-hidden="true"
      data-org-identicon={id}
      width={size}
      height={size}
      viewBox="0 0 6 6"
      className="block rounded-md"
      style={{ opacity: dim }}
    >
      <rect width={6} height={6} fill={bg} />
      {identiconCells(id).map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={0.5 + x}
          y={0.5 + y}
          width={1.02}
          height={1.02}
          fill={fg}
        />
      ))}
    </svg>
  );
}
