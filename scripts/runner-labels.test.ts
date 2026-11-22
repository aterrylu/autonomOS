import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * #578: GitHub retired the macos-14 image, and a job pinned to a retired
 * runner label is CANCELLED at 0s rather than failed. A cancelled job that
 * isn't a required check goes unnoticed, so the Test install darwin-arm64 job
 * (the #546 installed-bundle guard) sat dead for weeks, and the release
 * build's darwin-arm64 entry would have shipped a release without that
 * binary. This test fails the PR instead.
 *
 * The cutoffs below name images GitHub has RETIRED (see
 * https://github.com/actions/runner-images#available-images). When GitHub
 * retires the next one, raise its cutoff here and move the workflows off it.
 */

const WORKFLOWS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

/** Highest RETIRED major version per image family (inclusive). */
const RETIRED_THROUGH = {
  macos: 14, // macos-14 retired 2026-11-02 (runner-images #15226); 13, 12, 11, 10.15 earlier
  ubuntu: 20, // ubuntu-20.04 retired 2025-04
  windows: 2019, // windows-2019 retired 2025-06 (year-style only: windows-11-arm is supported)
} as const;

/**
 * Every runner image label in `text` whose version is retired, plus any label
 * assembled from an expression (`macos-${{ matrix.v }}`), which can't be
 * checked statically. Only FULL-LINE comments are skipped: a trailing `#` may
 * sit inside a quoted string or `${{ }}`, and stripping it there would hide a
 * real label, so a trailing comment naming a retired image fails closed.
 */
function retiredLabels(text: string): string[] {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const found: string[] = [];
  for (const m of code.matchAll(/\b(?:macos|ubuntu|windows)-\$\{\{/gi)) {
    found.push(m[0]);
  }
  for (const m of code.matchAll(
    /\b(macos|ubuntu|windows)-(\d+)(?:\.\d+)?(?:-[\w-]+)?\b/gi,
  )) {
    const family = m[1].toLowerCase() as keyof typeof RETIRED_THROUGH;
    // Windows images are named by server year (2019, 2022…); windows-11-arm is a client OS.
    if (family === "windows" && m[2].length !== 4) continue;
    if (Number(m[2]) <= RETIRED_THROUGH[family]) found.push(m[0]);
  }
  return found;
}

describe("workflows use no retired GitHub runner image (#578)", () => {
  it("finds the workflows (precondition)", () => {
    assert.ok(files.length >= 5, `only ${files.length} workflows found`);
  });

  it("the matcher flags retired labels and passes supported ones", () => {
    assert.deepEqual(
      retiredLabels(
        [
          "runs-on: macos-14",
          "  - runs-on: macos-13-xlarge",
          "runs-on: [macos-10.15]",
          "runs-on: ubuntu-20.04",
          "runs-on: windows-2019",
          "runs-on: macOS-12",
          'run: echo "a #b" && gh run --runner macos-14',
          "runs-on: macos-${{ matrix.ver }}",
        ].join("\n"),
      ),
      [
        "macos-${{", // assembled labels are collected first
        "macos-14",
        "macos-13-xlarge",
        "macos-10.15",
        "ubuntu-20.04",
        "windows-2019",
        "macOS-12",
        "macos-14", // behind a `#` inside a quoted string
      ],
    );
    assert.deepEqual(
      retiredLabels(
        [
          "runs-on: macos-15",
          "runs-on: macos-15-intel",
          "runs-on: macos-26",
          "runs-on: macos-latest",
          "runs-on: ubuntu-24.04-arm",
          "runs-on: windows-2025",
          "runs-on: windows-11-arm",
          "runs-on: ubuntu-24.04",
          "# was macos-14 before #578",
          "    # indented comment: macos-13",
        ].join("\n"),
      ),
      [],
    );
  });

  for (const f of files) {
    it(`${f}: no runner label names a retired image`, () => {
      const bad = retiredLabels(readFileSync(join(WORKFLOWS, f), "utf8"));
      assert.deepEqual(
        bad,
        [],
        `${f} references retired runner image(s) ${bad.join(", ")}: GitHub cancels such jobs at 0s ` +
          "(no failure, no red X). Move to a supported label from https://github.com/actions/runner-images.",
      );
    });
  }
});
