import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ADR-163: what we test is what we ship. The release build ran on
 * `node-version: "lts/*"`, which floated to Node 26 while every test job was
 * pinned at 22, so code could pass CI and behave differently in the bundle we
 * release (#580 was the same drift through `ubuntu-latest`).
 *
 * Two Node versions are allowed in CI, and each has ONE source of truth:
 *   - the primary, `.node-version` (a bare major), read by every setup-node
 *     step through `node-version-file: .node-version`;
 *   - the install floor, `MIN_NODE` in scripts/install.sh (a full version:
 *     the bundle runs on the user's own Node, ADR-154), read at run time by
 *     the `node-floor` job's `floor` step and passed as
 *     `${{ steps.floor.outputs.version }}`.
 * Any other value (a floating alias, a literal version, a matrix expression)
 * fails here. So does a dependency bundled into the release whose
 * `engines.node` excludes the floor: install.sh would accept a Node that the
 * code it installs says it doesn't support.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const INSTALL_SH = join(ROOT, "scripts", "install.sh");
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

function readWorkflow(file: string): string {
  return readFileSync(join(WORKFLOWS, file), "utf8");
}

const PRIMARY_FILE = ".node-version";
const FLOOR_EXPR = "${{ steps.floor.outputs.version }}";
const MIN_NODE_LINE = /^MIN_NODE=(.*)$/gm;
/** The bundle's entry is the CLI (packages/server/build/build-binary.ts); the
 *  provenance verifier's entry lives in the server package it depends on. */
const BUNDLE_ROOT = join(ROOT, "packages", "cli");

type SetupNode = { line: number; job: string; version?: string; versionFile?: string };

/** Strip quotes and a trailing ` # comment` from a YAML scalar. */
function scalar(raw: string): string {
  const v = raw.replace(/\s+#.*$/, "").trim();
  return v.replace(/^(["'])(.*)\1$/, "$2");
}

/** Each job under `jobs:` with its own lines (2-space job keys, the repo's style). */
function jobsOf(text: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = null;
      continue;
    }
    const key = inJobs ? line.match(/^ {2}([\w-]+):\s*$/) : null;
    if (key) {
      current = [];
      jobs.set(key[1], current);
    }
    current?.push(line);
  }
  return jobs;
}

/**
 * Every `actions/setup-node` step in a workflow, with its job and the version
 * inputs from its `with:` block. Line-based on purpose (no YAML dependency): a
 * step is the lines indented deeper than its `- ` dash, and full-line
 * comments are skipped so a commented-out `lts/*` doesn't count.
 */
function setupNodeSteps(text: string): SetupNode[] {
  const steps: SetupNode[] = [];
  let offset = 0;
  for (const [job, lines] of jobsOf(text)) {
    // Line numbers are reported against the whole file.
    const base = text.split("\n").indexOf(lines[0], offset);
    offset = base + lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-?\s*uses:\s*["']?actions\/setup-node@/);
      if (!m) continue;
      // Column of the step's `- ` dash: on this line, or on the step's first
      // line above it (`- name: …` then `uses: …`).
      let dash = -1;
      for (let j = i; j >= 0 && dash < 0; j--) {
        const d = lines[j].match(/^(\s*)-\s/);
        if (d && (j === i || d[1].length < m[1].length)) dash = d[1].length;
      }
      const step: SetupNode = { line: base + i + 1, job };
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim() || /^\s*#/.test(l)) continue;
        if (l.search(/\S/) <= dash) break;
        const kv = l.match(/^\s*(node-version|node-version-file):\s*(.*)$/);
        if (!kv) continue;
        if (kv[1] === "node-version") step.version = scalar(kv[2]);
        else step.versionFile = scalar(kv[2]);
      }
      steps.push(step);
    }
  }
  return steps;
}

/** Why a setup-node step breaks the single-source rule, or null if it doesn't. */
function violation(s: SetupNode): string | null {
  if (s.version !== undefined && s.versionFile !== undefined) {
    return "sets both node-version and node-version-file (node-version silently wins)";
  }
  if (s.versionFile !== undefined) {
    return s.versionFile === PRIMARY_FILE
      ? null
      : `node-version-file: ${s.versionFile} (must be ${PRIMARY_FILE})`;
  }
  if (s.version === undefined) {
    return "no version: setup-node falls back to whatever node the runner image has";
  }
  if (s.version === FLOOR_EXPR) return null;
  if (/^(lts\/.*|latest|current|node|\*)$/i.test(s.version)) {
    return `node-version: ${s.version} floats (lts/* moved to 26 under us)`;
  }
  return `node-version: ${s.version} is a second source of truth (use node-version-file: ${PRIMARY_FILE})`;
}

// ── engines.node ranges ───────────────────────────────────────────────────
// A small subset of npm's semver ranges: exactly what bundled packages write
// (`>=18`, `>= 0.8`, `^22.22.2 || >=26.0.0`, `18 || 20 || >=22`, `~1.2`, `*`,
// `a - b`). Anything else THROWS, naming the package, rather than guessing:
// adding a dependency on `semver` here would collide with the deps PRs.

type V = [number, number, number];

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function parseVersion(v: string): V {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a full version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A possibly-partial version (`20`, `20.5`, `20.x`) → its parts and how many were given. */
function partial(p: string): { v: V; n: number } {
  const m = p.match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!m) throw new Error(`unsupported version in range: "${p}"`);
  const parts = [m[1], m[2], m[3]];
  let n = 0;
  while (n < 3 && parts[n] !== undefined && /^\d+$/.test(parts[n] as string)) n++;
  const v: V = [0, 0, 0];
  for (let i = 0; i < n; i++) v[i] = Number(parts[i]);
  return { v, n };
}

/** The first version past every version `p` names (`20` → 21.0.0, `20.5` → 20.6.0). */
function bump(v: V, n: number): V {
  if (n === 0) return [Number.MAX_SAFE_INTEGER, 0, 0];
  const out: V = [v[0], n > 1 ? v[1] : 0, n > 2 ? v[2] : 0];
  out[n - 1]++;
  return out;
}

/** Does `version` satisfy one comparator set (space-separated comparators, ANDed)? */
function setSatisfied(version: V, set: string): boolean {
  const s = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  if (s === "" || s === "*" || s.toLowerCase() === "x") return true;
  const hyphen = s.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hyphen) {
    const lo = partial(hyphen[1]);
    const hi = partial(hyphen[2]);
    return cmp(version, lo.v) >= 0 && cmp(version, bump(hi.v, hi.n)) < 0;
  }
  return s.split(/\s+/).every((tok) => {
    const m = tok.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!m) throw new Error(`unsupported comparator: "${tok}"`);
    const op = m[1] ?? "";
    const { v, n } = partial(m[2]);
    switch (op) {
      case "":
      case "=":
        return cmp(version, v) >= 0 && cmp(version, bump(v, n)) < 0;
      case ">=":
        return cmp(version, v) >= 0;
      case ">":
        return n === 3 ? cmp(version, v) > 0 : cmp(version, bump(v, n)) >= 0;
      case "<":
        return cmp(version, v) < 0;
      case "<=":
        return n === 3 ? cmp(version, v) <= 0 : cmp(version, bump(v, n)) < 0;
      case "~":
        return cmp(version, v) >= 0 && cmp(version, bump(v, Math.min(n, 2))) < 0;
      case "^": {
        // The first non-zero part given is the one that may not change.
        let k = 0;
        while (k < n - 1 && v[k] === 0) k++;
        return cmp(version, v) >= 0 && cmp(version, bump(v, Math.max(1, k + 1))) < 0;
      }
    }
    throw new Error(`unsupported comparator: "${tok}"`);
  });
}

function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range.split("||").some((set) => setSatisfied(v, set));
}

/** Every package the release bundles: the CLI's runtime dependency closure, as installed. */
function bundledPackages(): Array<{ id: string; engines?: string }> {
  const seen = new Map<string, { id: string; engines?: string }>();
  const resolveFrom = (name: string, from: string): string | null => {
    for (let d = from; ; d = dirname(d)) {
      try {
        return realpathSync.native(join(d, "node_modules", name));
      } catch {
        if (dirname(d) === d) return null;
      }
    }
  };
  const walk = (dir: string) => {
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const id = `${pj.name}@${pj.version}`;
    if (seen.has(id)) return;
    seen.set(id, { id, engines: pj.engines?.node });
    const optional = pj.optionalDependencies ?? {};
    for (const dep of Object.keys({ ...pj.dependencies, ...optional })) {
      const found = resolveFrom(dep, dir);
      if (found) walk(found);
      // A required dependency that isn't installed is a broken tree, not a pass.
      else if (!(dep in optional)) throw new Error(`${id} depends on ${dep}, which isn't installed`);
    }
  };
  walk(BUNDLE_ROOT);
  return [...seen.values()];
}

describe("one pinned Node for tests and release, and a floor that matches the bundle (ADR-163)", () => {
  const primaryRaw = readFileSync(join(ROOT, PRIMARY_FILE), "utf8");
  const primary = Number(primaryRaw.trim());
  const installSh = readFileSync(INSTALL_SH, "utf8");
  const minNodeLines = [...installSh.matchAll(MIN_NODE_LINE)];
  const floor = minNodeLines[0]?.[1] ?? "";

  it(`${PRIMARY_FILE} is one bare major`, () => {
    assert.match(primaryRaw, /^[0-9]+\n?$/, `${PRIMARY_FILE} must be a single major, e.g. "26"`);
  });

  it("install.sh declares MIN_NODE once, as a full version at or below the primary", () => {
    assert.equal(minNodeLines.length, 1, "scripts/install.sh needs exactly one MIN_NODE= line (bash honors the last)");
    assert.match(floor, /^\d+\.\d+\.\d+$/, `MIN_NODE=${floor} must be <major>.<minor>.<patch>`);
    assert.ok(parseVersion(floor)[0] <= primary, `MIN_NODE ${floor} is above ${PRIMARY_FILE} ${primary}`);
  });

  it("install.sh's node check refuses below MIN_NODE on the full version, and says what to install", () => {
    // The REAL check, sliced out of install.sh (running the whole script would
    // download a release), against a fake `node` that reports each version.
    const start = installSh.indexOf("\nMIN_NODE=");
    const end = installSh.indexOf("\nfi\n", installSh.indexOf('if [[ "${SKIP_NODE_CHECK:-0}" != "1" ]]', start));
    assert.ok(start > 0 && end > start, "couldn't find install.sh's node check block");
    const check = `${installSh.slice(start, end)}\nfi\necho NODE_CHECK_PASSED\n`;
    const bin = mkdtempSync(join(tmpdir(), "node-floor-check-"));
    try {
      const fakeNode = join(bin, "node");
      const run = (reported: string) => {
        writeFileSync(fakeNode, `#!/bin/sh\necho ${reported}\n`, { mode: 0o755 });
        // /bin/bash: macOS runs install.sh under bash 3.2.
        const r = spawnSync("/bin/bash", ["-c", check], {
          encoding: "utf8",
          env: { PATH: `${bin}:/usr/bin:/bin` },
        });
        return { ok: r.status === 0 && r.stdout.includes("NODE_CHECK_PASSED"), stderr: r.stderr };
      };
      // A string or major-only compare gets 22.9.10 and 22.100.0 wrong.
      for (const v of ["20.20.2", "22.0.0", "22.9.10", "22.22.1"]) {
        const r = run(v);
        assert.equal(r.ok, false, `install.sh accepted Node ${v} (floor ${floor})`);
        assert.match(r.stderr, new RegExp(`Node\\.js ${floor.replace(/\./g, "\\.")} or newer is required \\(found v${v.replace(/\./g, "\\.")}\\)`));
        assert.match(r.stderr, /brew install node/, "the refusal doesn't say what to install");
      }
      for (const v of [floor, "22.22.10", "22.100.0", "24.15.0", "26.3.1", "27.0.0-pre"]) {
        const r = run(v);
        assert.equal(r.ok, true, `install.sh refused Node ${v} (floor ${floor}): ${r.stderr}`);
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("finds the workflows (precondition)", () => {
    assert.ok(files.length >= 5, `only ${files.length} workflows found`);
  });

  it("the matcher accepts the two sources and rejects everything else", () => {
    const yaml = (body: string) => `jobs:\n  a:\n    steps:\n${body}`;
    const ok = [
      "      - uses: actions/setup-node@abc # v4\n        with:\n          node-version-file: .node-version\n",
      `      - uses: actions/setup-node@abc\n        with:\n          node-version: ${FLOOR_EXPR}\n`,
      "      - name: n\n        uses: actions/setup-node@abc\n        with:\n          node-version-file: '.node-version'\n",
      // A commented-out floating value is not a value.
      "      - uses: actions/setup-node@abc\n        with:\n          # node-version: lts/*\n          node-version-file: .node-version\n",
    ];
    for (const body of ok) {
      const steps = setupNodeSteps(yaml(body));
      assert.equal(steps.length, 1, body);
      assert.equal(violation(steps[0]), null, body);
    }
    const bad: Array<[string, RegExp]> = [
      ['          node-version: "lts/*"\n', /floats/],
      ["          node-version: lts/iron\n", /floats/],
      ["          node-version: latest\n", /floats/],
      ["          node-version: node\n", /floats/],
      ["          node-version: current\n", /floats/],
      ['          node-version: "22"\n', /second source/],
      ["          node-version: 22.22.2\n", /second source/],
      ["          node-version: ${{ matrix.node }}\n", /second source/],
      ["          node-version-file: .nvmrc\n", /must be/],
      ["          node-version: 26\n          node-version-file: .node-version\n", /both/],
      ["          cache: npm\n", /no version/],
    ];
    for (const [w, re] of bad) {
      const steps = setupNodeSteps(yaml(`      - uses: actions/setup-node@abc\n        with:\n${w}      - run: echo next\n`));
      assert.equal(steps.length, 1, w);
      assert.match(violation(steps[0]) ?? "(none)", re, w);
    }
  });

  it("the floor expression is only used in a job whose own `floor` step reads install.sh", () => {
    for (const f of files) {
      const text = readWorkflow(f);
      const jobs = jobsOf(text);
      for (const s of setupNodeSteps(text).filter((x) => x.version === FLOOR_EXPR)) {
        // `steps.*` only resolves inside the same job, and only for earlier steps.
        const lines = jobs.get(s.job) ?? [];
        const before = lines.slice(0, lines.findIndex((l) => l.includes(FLOOR_EXPR))).join("\n");
        assert.match(before, /id:\s*floor\b/, `${f}:${s.line}: job ${s.job} has no earlier step with id: floor`);
        assert.match(before, /MIN_NODE=.*scripts\/install\.sh/, `${f}: job ${s.job}'s floor step doesn't read MIN_NODE from scripts/install.sh`);
      }
    }
  });

  it("test.yml's node-floor job exists, always runs, and extracts exactly MIN_NODE", () => {
    const job = jobsOf(readWorkflow("test.yml")).get("node-floor");
    assert.ok(job, "test.yml has no node-floor job: nothing tests the oldest Node install.sh accepts");
    const text = job.join("\n");
    assert.doesNotMatch(text, /^ {4}if:/m, "node-floor has a job-level if: and can be skipped");
    assert.ok(text.includes(FLOOR_EXPR), `node-floor's setup-node doesn't use ${FLOOR_EXPR}`);
    assert.match(text, /make _node-tests/, "node-floor doesn't run make _node-tests");
    assert.match(text, /process\.versions\.node/, "node-floor never checks which node it actually runs");
    // Run the job's own sed against install.sh: the two must agree.
    const sed = text.match(/^\s*version=\$\((sed -n .* scripts\/install\.sh)\)$/m);
    assert.ok(sed, "node-floor's floor step has no `version=$(sed -n … scripts/install.sh)` line");
    const got = execFileSync("bash", ["-c", sed[1]], { cwd: ROOT, encoding: "utf8" }).trim();
    assert.equal(got, floor, "node-floor's sed doesn't extract install.sh's MIN_NODE");
  });

  it("the release build and the test suite both run on the primary", () => {
    for (const f of ["reusable-server-build.yml", "test.yml"]) {
      assert.ok(
        setupNodeSteps(readWorkflow(f)).some((s) => s.versionFile === PRIMARY_FILE),
        `${f} has no setup-node step reading ${PRIMARY_FILE}`,
      );
    }
  });

  for (const f of files) {
    it(`${f}: every setup-node reads the single source of truth`, () => {
      const bad = setupNodeSteps(readWorkflow(f)).flatMap((s) => {
        const v = violation(s);
        return v === null ? [] : [`${f}:${s.line}: ${v}`];
      });
      assert.deepEqual(bad, [], `${bad.join("\n")}\nSee ADR-163.`);
    });
  }

  it("the engines matcher agrees with npm semver on the ranges that matter", () => {
    const cases: Array<[string, string, boolean]> = [
      ["22.22.2", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
      ["22.22.1", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
      ["20.20.2", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
      ["25.4.0", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
      ["24.15.0", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
      ["22.22.2", "^20.17.0 || >=22.9.0", true],
      ["22.22.2", "18 || 20 || >=22", true],
      ["21.0.0", "18 || 20 || >=22", false],
      ["22.22.2", ">= 0.8", true],
      ["22.22.2", ">=16.20.0", true],
      // A partial version names its whole line: `>22` is `>=23.0.0`.
      ["22.22.2", ">22", false],
      ["23.0.0", ">22", true],
      ["22.22.2", ">22.22.2", false],
      ["22.22.2", "<22", false],
      ["22.22.2", "<=22", true],
      ["22.22.2", "~22.22.0", true],
      ["22.23.0", "~22.22.0", false],
      ["22.22.2", "20.x || 22.x", true],
      ["22.22.2", "20 - 22", true],
      ["23.0.0", "20 - 22", false],
      ["22.22.2", ">=18 <22", false],
      ["0.3.1", "^0.3.0", true],
      ["0.4.0", "^0.3.0", false],
      ["22.22.2", "*", true],
    ];
    for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} vs "${r}"`);
    assert.throws(() => satisfies("22.22.2", ">=22.0.0-rc.1"), /unsupported/);
  });

  it("every bundled dependency's engines.node includes MIN_NODE", () => {
    const pkgs = bundledPackages();
    // Precondition: the walk reached the deps the floor exists for.
    assert.ok(pkgs.length > 50, `only ${pkgs.length} bundled packages found: is bun install done?`);
    assert.ok(pkgs.some((p) => p.id.startsWith("@sigstore/verify@")), "the walk didn't reach @sigstore/verify");
    const excluded = pkgs.flatMap((p) => {
      if (!p.engines) return [];
      try {
        return satisfies(floor, p.engines) ? [] : [`${p.id} (engines.node "${p.engines}")`];
      } catch (e) {
        return [`${p.id}: can't read engines.node "${p.engines}" (${(e as Error).message})`];
      }
    });
    assert.deepEqual(
      excluded,
      [],
      `install.sh accepts Node ${floor}, but these bundled packages don't support it:\n  ${excluded.join("\n  ")}\n` +
        "Raise MIN_NODE in scripts/install.sh to a version every range includes (ADR-163).",
    );
  });
});
