/**
 * Bundle-size ratchet: the dashboard's gzipped JS and CSS must stay within
 * packages/dashboard/perf-budget.json.
 *
 *   bun --filter @autonomos/dashboard build && tsx scripts/check-bundle-budget.ts
 *   tsx scripts/check-bundle-budget.ts --update   # set the budget to today's size
 *
 * Sizes are gzip level 9 of each built .js/.css under dist/assets (the
 * precompressed .gz/.br copies are skipped), i.e. roughly what a browser
 * downloads. Exits 1 when a total is over budget, naming the biggest files.
 * A total well under budget passes with a note to lower it (the ratchet:
 * wins get locked in, growth needs a deliberate budget bump in the PR).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export interface Budget {
  jsGzipBytes: number;
  cssGzipBytes: number;
}
export interface Measured {
  jsGzipBytes: number;
  cssGzipBytes: number;
  files: { name: string; gzipBytes: number }[];
}

/** Gzipped size of every built .js/.css in `assetsDir`. */
export function measure(assetsDir: string): Measured {
  const out: Measured = { jsGzipBytes: 0, cssGzipBytes: 0, files: [] };
  for (const name of readdirSync(assetsDir)) {
    const kind = /\.js$/.test(name) ? "js" : /\.css$/.test(name) ? "css" : null;
    if (!kind) continue;
    const gzipBytes = gzipSync(readFileSync(join(assetsDir, name)), {
      level: 9,
    }).length;
    out.files.push({ name, gzipBytes });
    if (kind === "js") out.jsGzipBytes += gzipBytes;
    else out.cssGzipBytes += gzipBytes;
  }
  out.files.sort((a, b) => b.gzipBytes - a.gzipBytes);
  return out;
}

/** Over-budget problems (empty = pass) and ratchet notes. */
export function judge(
  m: Measured,
  b: Budget,
): { over: string[]; notes: string[] } {
  const over: string[] = [];
  const notes: string[] = [];
  for (const [label, got, max] of [
    ["JS", m.jsGzipBytes, b.jsGzipBytes],
    ["CSS", m.cssGzipBytes, b.cssGzipBytes],
  ] as const) {
    if (got > max)
      over.push(
        `${label} is ${got.toLocaleString()} B gzipped, ${(got - max).toLocaleString()} B over its budget of ${max.toLocaleString()} B`,
      );
    else if (got < max * 0.95)
      notes.push(
        `${label} is ${got.toLocaleString()} B, well under its ${max.toLocaleString()} B budget: lower it (tsx scripts/check-bundle-budget.ts --update) to lock the win in`,
      );
  }
  return { over, notes };
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(repo, "packages/dashboard/dist/assets");
const BUDGET = join(repo, "packages/dashboard/perf-budget.json");

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!existsSync(ASSETS)) {
    console.error(
      `✗ ${ASSETS} not found: build the dashboard first (bun --filter @autonomos/dashboard build)`,
    );
    process.exit(2);
  }
  const m = measure(ASSETS);
  if (process.argv.includes("--update")) {
    const b: Budget = { jsGzipBytes: m.jsGzipBytes, cssGzipBytes: m.cssGzipBytes };
    writeFileSync(BUDGET, `${JSON.stringify(b, null, 2)}\n`);
    console.log(`✓ budget set to today's size: JS ${b.jsGzipBytes} B, CSS ${b.cssGzipBytes} B`);
    process.exit(0);
  }
  const budget = JSON.parse(readFileSync(BUDGET, "utf8")) as Budget;
  const { over, notes } = judge(m, budget);
  console.log(
    `dashboard bundle (gzip -9): JS ${m.jsGzipBytes.toLocaleString()} / ${budget.jsGzipBytes.toLocaleString()} B, CSS ${m.cssGzipBytes.toLocaleString()} / ${budget.cssGzipBytes.toLocaleString()} B`,
  );
  for (const n of notes) console.log(`note: ${n}`);
  if (over.length) {
    for (const o of over) console.error(`✗ ${o}`);
    console.error("  biggest files:");
    for (const f of m.files.slice(0, 5))
      console.error(`    ${f.gzipBytes.toLocaleString().padStart(10)} B  ${f.name}`);
    console.error(
      "  If the growth is intended, raise packages/dashboard/perf-budget.json in this PR (say why in the PR body).",
    );
    process.exit(1);
  }
  console.log("✓ within budget");
}
