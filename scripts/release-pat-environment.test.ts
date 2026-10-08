import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Security audit H-1 (ADR-151 follow-up): RELEASE_PAT can push to this repo
 * and open PRs as its owner. As a repository secret, any workflow run could
 * read it, including one started from a pushed non-main branch with an edited
 * workflow. It now lives in the protected `release` environment (deployment
 * branches: main only), and a job can only read an environment secret if it
 * declares that environment. This keeps every job that uses the PAT inside it.
 */

const WORKFLOWS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

/** Each job in a workflow file: its name and its text (2-space job keys). */
function jobs(text: string): { name: string; body: string }[] {
  const start = text.search(/^jobs:\s*$/m);
  if (start === -1) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const out: { name: string; body: string }[] = [];
  for (const line of lines) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) out.push({ name: m[1], body: "" });
    else if (/^\S/.test(line) && line.trim()) break;
    else if (out.length) out[out.length - 1].body += `${line}\n`;
  }
  return out;
}

const users = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) =>
    jobs(readFileSync(join(WORKFLOWS, f), "utf8"))
      .filter((j) => /secrets\.RELEASE_PAT\b/.test(j.body))
      .map((j) => ({ file: f, ...j })),
  );

describe("RELEASE_PAT is only read inside the protected release environment (audit H-1)", () => {
  it("finds the jobs that use it (precondition)", () => {
    const names = users.map((u) => `${u.file}:${u.name}`);
    for (const known of ["version.yml:version", "decisions-index.yml:index"]) {
      assert.ok(names.includes(known), `${known} not found among ${names.join(", ")}`);
    }
  });

  for (const u of users) {
    it(`${u.file} job "${u.name}" declares environment: release`, () => {
      assert.match(
        u.body,
        /^ {4}environment:\s*(release|\{?\s*name:\s*release)/m,
        `${u.file} job "${u.name}" reads RELEASE_PAT outside the protected release environment`,
      );
    });
  }
});
