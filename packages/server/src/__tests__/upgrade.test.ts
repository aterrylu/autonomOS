// performUpgrade / performRollback / compareSemver (ADR-071).
//
// performUpgrade had ZERO tests when it shipped in #170 — network + checksum +
// tar + double-rename with a finally-cleanup is exactly the shape where an
// untested failure can leave a box with no live bundle at all. These tests run
// the REAL flow (real fetch, real tar, real renames) against a local HTTP
// fixture server standing in for the GitHub releases API — nothing is mocked
// below the network edge.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallJson } from "../installInfo.js";
import {
  compareSemver,
  performRollback,
  performUpgrade,
  type RollbackResult,
  readBundleVersion,
  type UpgradeResult,
} from "../upgrade.js";

const PLATFORM = "darwin-arm64" as const;
const TARBALL_NAME = `autonomos-${PLATFORM}.tar.gz`;
const REPO = "test/autonomos";

/** Assert the error arm and match its message (the ternary narrows the union). */
function assertError(
  result: UpgradeResult | RollbackResult,
  pattern: RegExp,
): void {
  assert.equal(result.status, "error");
  assert.match(result.status === "error" ? result.message : "", pattern);
}

let root: string;
// EVERY started fixture server, not just the latest: a test that starts two
// (e.g. the mid-download-failure case) would otherwise leak the first one,
// and a leaked listener keeps the node:test process alive forever after all
// tests pass — an all-green hang.
let servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autonomos-upgrade-test-"));
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

/** Build a real bundle tarball whose package.json carries `version`. */
function makeTarball(version: string): Buffer {
  const stage = join(root, `stage-${version}`);
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ name: "@autonomos/server", version, type: "module" }),
  );
  writeFileSync(join(stage, "index.js"), `// bundle ${version}\n`);
  const out = join(root, `${version}-${TARBALL_NAME}`);
  const tar = spawnSync("tar", ["-czf", out, "-C", stage, "."]);
  if (tar.status !== 0) throw new Error("fixture tar failed");
  return readFileSync(out);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

type FixtureOptions = {
  /** Corrupt SHA256SUMS so verification must fail. */
  badChecksum?: boolean;
  /** Omit the platform tarball asset from the release. */
  missingTarball?: boolean;
  /** Point asset URLs at a connection-refused port (mid-download failure). */
  brokenDownloads?: boolean;
};

/**
 * Local stand-in for the GitHub releases API + asset downloads. Serves
 * /repos/:repo/releases/latest, /repos/:repo/releases/tags/:tag, and the
 * asset files themselves. Returns the base URL.
 */
async function startFixtureServer(
  versions: string[],
  opts: FixtureOptions = {},
): Promise<string> {
  const tarballs = new Map(versions.map((v) => [v, makeTarball(v)]));
  const latest = versions[versions.length - 1];

  /** The SHA256SUMS body for a version — a wrong digest when badChecksum. */
  const sumsFor = (version: string): string => {
    const buf = tarballs.get(version);
    if (!buf) return "";
    const digest = opts.badChecksum ? "0".repeat(64) : sha256(buf);
    return `${digest}  ${TARBALL_NAME}\n`;
  };

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const releaseJson = (version: string): string => {
      // Port 1 is essentially never listening → immediate ECONNREFUSED.
      const base = opts.brokenDownloads
        ? "http://127.0.0.1:1"
        : `http://127.0.0.1:${port()}`;
      return JSON.stringify({
        tag_name: `v${version}`,
        assets: [
          ...(opts.missingTarball
            ? []
            : [
                {
                  name: TARBALL_NAME,
                  browser_download_url: `${base}/dl/${version}/${TARBALL_NAME}`,
                },
              ]),
          {
            name: "SHA256SUMS",
            browser_download_url: `${base}/dl/${version}/SHA256SUMS.txt`,
          },
        ],
      });
    };

    if (url === `/repos/${REPO}/releases/latest` && latest) {
      res.setHeader("content-type", "application/json");
      res.end(releaseJson(latest));
      return;
    }
    const tagMatch = url.match(
      new RegExp(`^/repos/${REPO}/releases/tags/v(.+)$`),
    );
    if (tagMatch?.[1] && tarballs.has(tagMatch[1])) {
      res.setHeader("content-type", "application/json");
      res.end(releaseJson(tagMatch[1]));
      return;
    }
    const dlMatch = url.match(/^\/dl\/([^/]+)\/(.+)$/);
    if (dlMatch?.[1] && dlMatch[2] === TARBALL_NAME) {
      res.end(tarballs.get(dlMatch[1]));
      return;
    }
    if (dlMatch?.[1] && dlMatch[2] === "SHA256SUMS.txt") {
      res.end(sumsFor(dlMatch[1]));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const port = (): number => {
    const addr = server.address();
    if (addr && typeof addr === "object") return addr.port;
    throw new Error("fixture server not listening");
  };
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${port()}`;
}

/** Lay down a live "installed" bundle dir at <root>/share/autonomos. */
function installLiveBundle(version: string): string {
  const bundleDir = join(root, "share", "autonomos");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "package.json"),
    JSON.stringify({ name: "@autonomos/server", version, type: "module" }),
  );
  writeFileSync(join(bundleDir, "index.js"), `// bundle ${version}\n`);
  return bundleDir;
}

const baseOpts = (bundleDir: string, apiBase: string) => ({
  bundleDir,
  platform: PLATFORM,
  installInfo: { mode: "bundle" as const, prefix: join(root) },
  releaseRepo: REPO,
  releaseApiBase: apiBase,
});

describe("performUpgrade", () => {
  it("upgrades to the latest release: swap, .previous, marker written", async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");

    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });

    assert.deepEqual(result, {
      status: "upgraded",
      from: "0.5.0",
      to: "0.6.0",
      direction: "upgrade",
    });
    assert.equal(readBundleVersion(bundleDir), "0.6.0");
    assert.equal(readBundleVersion(`${bundleDir}.previous`), "0.5.0");
    // The marker travels with the swap — including onto legacy installs that
    // never had one.
    const marker = readInstallJson(bundleDir);
    assert.equal(marker?.mode, "bundle");
    assert.equal(marker?.installedBy, "upgrade");
    assert.equal(existsSync(`${bundleDir}.new`), false);
  });

  it("reports up-to-date on same version without touching the bundle", async () => {
    const apiBase = await startFixtureServer(["0.5.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    assert.deepEqual(result, { status: "up-to-date", version: "0.5.0" });
    assert.equal(existsSync(`${bundleDir}.previous`), false);
  });

  it("refuses to silently downgrade an ahead-of-release install", async () => {
    const apiBase = await startFixtureServer(["0.5.0"]);
    const bundleDir = installLiveBundle("0.9.0-dev");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.9.0-dev",
    });
    assert.equal(result.status, "up-to-date");
    assert.equal(readBundleVersion(bundleDir), "0.9.0-dev");
  });

  it("pins to an explicit target, downgrade included, and says so", async () => {
    const apiBase = await startFixtureServer(["0.4.0", "0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
      targetVersion: "0.4.0",
    });
    assert.deepEqual(result, {
      status: "upgraded",
      from: "0.5.0",
      to: "0.4.0",
      direction: "downgrade",
    });
    assert.equal(readBundleVersion(bundleDir), "0.4.0");
  });

  it("errors on a missing pinned release tag", async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
      targetVersion: "3.3.3",
    });
    assertError(result, /No release tagged v3.3.3/);
  });

  it("rejects a checksum mismatch and leaves the live bundle untouched", async () => {
    const apiBase = await startFixtureServer(["0.6.0"], { badChecksum: true });
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    assertError(result, /Checksum mismatch/);
    assert.equal(readBundleVersion(bundleDir), "0.5.0");
    assert.equal(existsSync(`${bundleDir}.previous`), false);
  });

  it("errors when the release lacks the platform tarball", async () => {
    const apiBase = await startFixtureServer(["0.6.0"], {
      missingTarball: true,
    });
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    assertError(result, /missing autonomos-darwin-arm64/);
  });

  it('refuses when the current version is "unknown" (corrupt install)', async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "unknown",
    });
    assertError(result, /Cannot determine the installed version/);
    assert.equal(readBundleVersion(bundleDir), "0.5.0");
  });

  it("returns an error result (not a throw) when an asset download fails", async () => {
    // Release metadata resolves but the tarball URL 404s: downloadTo throws,
    // and that throw must be converted to the UpgradeResult contract — a raw
    // throw reaches the CLI as a stack trace and the REST route as a bare
    // 500. The live bundle stays untouched.
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
      // Fixture serves downloads under /dl/<version>/… — a bogus platform
      // name in the URL is the easiest honest 404.
      platform: "linux-arm64",
    });
    assertError(result, /missing autonomos-linux-arm64/);

    // Now a genuine mid-download failure: metadata resolves but the asset
    // URLs point at a connection-refused port. downloadTo's fetch rejects —
    // that throw must become an error result, and the live bundle must be
    // untouched.
    const apiBase2 = await startFixtureServer(["0.7.0"], {
      brokenDownloads: true,
    });
    const result2 = await performUpgrade({
      ...baseOpts(bundleDir, apiBase2),
      currentVersion: "0.5.0",
    });
    assertError(result2, /Upgrade failed/);
    assert.equal(readBundleVersion(bundleDir), "0.5.0");
  });
});

describe("performRollback", () => {
  it("swaps live and .previous symmetrically", async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });

    const back = performRollback(bundleDir);
    assert.deepEqual(back, {
      status: "rolled-back",
      from: "0.6.0",
      to: "0.5.0",
    });
    assert.equal(readBundleVersion(bundleDir), "0.5.0");
    assert.equal(readBundleVersion(`${bundleDir}.previous`), "0.6.0");

    const forward = performRollback(bundleDir);
    assert.deepEqual(forward, {
      status: "rolled-back",
      from: "0.5.0",
      to: "0.6.0",
    });
    assert.equal(readBundleVersion(bundleDir), "0.6.0");
  });

  it("errors when there is no .previous", () => {
    const bundleDir = installLiveBundle("0.5.0");
    const result = performRollback(bundleDir);
    assertError(result, /No previous version/);
  });

  it("heals a rollback that crashed after displacing the live dir", async () => {
    // Simulate a crash between rename #1 and #2: live sits at .rollback-tmp,
    // the live path is empty, .previous still holds the target. A re-run must
    // NOT delete the displaced copy (it's one of the two bundles this
    // function exists to preserve) — it should finish the interrupted swap.
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    // live=0.6.0, previous=0.5.0 → crash mid-rollback:
    renameSync(bundleDir, `${bundleDir}.rollback-tmp`);

    const result = performRollback(bundleDir);
    assert.equal(result.status, "rolled-back");
    assert.equal(readBundleVersion(bundleDir), "0.5.0");
    // The displaced 0.6.0 copy survives as the new .previous.
    assert.equal(readBundleVersion(`${bundleDir}.previous`), "0.6.0");
    assert.equal(existsSync(`${bundleDir}.rollback-tmp`), false);
  });
});

describe("compareSemver", () => {
  const cases: Array<[string, string, -1 | 0 | 1]> = [
    ["0.5.0", "0.5.0", 0],
    ["0.5.1", "0.5.0", 1],
    ["0.5.0", "0.5.1", -1],
    ["1.0.0", "0.9.9", 1],
    ["0.5.0", "0.5.0-beta.1", 0], // pre-release suffixes ignored by design
    ["0.10.0", "0.9.0", 1], // numeric, not lexicographic
    ["0.5", "0.5.0", 0],
  ];
  for (const [a, b, expected] of cases) {
    it(`compare(${a}, ${b}) === ${expected}`, () => {
      assert.equal(compareSemver(a, b), expected);
    });
  }
});
