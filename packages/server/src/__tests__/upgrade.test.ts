// performUpgrade / performRollback / compareSemver (ADR-071).
//
// performUpgrade had ZERO tests when it shipped in #170 — network + checksum +
// tar + double-rename with a finally-cleanup is exactly the shape where an
// untested failure can leave a box with no live bundle at all. These tests run
// the REAL flow (real fetch, real tar, real renames) against a local HTTP
// fixture server standing in for the GitHub releases API — nothing is mocked
// below the network edge.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstallJson } from "../installInfo.js";
import {
  compareSemver,
  performRollback,
  performUpgrade,
  readBundleVersion,
} from "../upgrade.js";

const PLATFORM = "darwin-arm64" as const;
const TARBALL_NAME = `autonomos-${PLATFORM}.tar.gz`;
const REPO = "test/autonomos";

let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autonomos-upgrade-test-"));
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  if (server) {
    await new Promise((r) => server?.close(r));
    server = undefined;
  }
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

  server = createServer((req, res) => {
    const url = req.url ?? "";
    const releaseJson = (version: string): string => {
      const buf = tarballs.get(version);
      if (!buf) return "";
      const sums = `${opts.badChecksum ? "0".repeat(64) : sha256(buf)}  ${TARBALL_NAME}\n`;
      const base = `http://127.0.0.1:${port()}`;
      const assets = [
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
      ];
      // Stash the sums so the download route can serve them.
      sumsByVersion.set(version, sums);
      return JSON.stringify({ tag_name: `v${version}`, assets });
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
      res.end(sumsByVersion.get(dlMatch[1]) ?? "");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const sumsByVersion = new Map<string, string>();
  const port = (): number => {
    const addr = server?.address();
    if (addr && typeof addr === "object") return addr.port;
    throw new Error("fixture server not listening");
  };
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
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

    expect(result).toEqual({
      status: "upgraded",
      from: "0.5.0",
      to: "0.6.0",
      direction: "upgrade",
    });
    expect(readBundleVersion(bundleDir)).toBe("0.6.0");
    expect(readBundleVersion(`${bundleDir}.previous`)).toBe("0.5.0");
    // The marker travels with the swap — including onto legacy installs that
    // never had one.
    expect(readInstallJson(bundleDir)).toMatchObject({
      mode: "bundle",
      installedBy: "upgrade",
    });
    expect(existsSync(`${bundleDir}.new`)).toBe(false);
  });

  it("reports up-to-date on same version without touching the bundle", async () => {
    const apiBase = await startFixtureServer(["0.5.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    expect(result).toEqual({ status: "up-to-date", version: "0.5.0" });
    expect(existsSync(`${bundleDir}.previous`)).toBe(false);
  });

  it("refuses to silently downgrade an ahead-of-release install", async () => {
    const apiBase = await startFixtureServer(["0.5.0"]);
    const bundleDir = installLiveBundle("0.9.0-dev");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.9.0-dev",
    });
    expect(result.status).toBe("up-to-date");
    expect(readBundleVersion(bundleDir)).toBe("0.9.0-dev");
  });

  it("pins to an explicit target, downgrade included, and says so", async () => {
    const apiBase = await startFixtureServer(["0.4.0", "0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
      targetVersion: "0.4.0",
    });
    expect(result).toEqual({
      status: "upgraded",
      from: "0.5.0",
      to: "0.4.0",
      direction: "downgrade",
    });
    expect(readBundleVersion(bundleDir)).toBe("0.4.0");
  });

  it("errors on a missing pinned release tag", async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
      targetVersion: "3.3.3",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/No release tagged v3.3.3/);
    }
  });

  it("rejects a checksum mismatch and leaves the live bundle untouched", async () => {
    const apiBase = await startFixtureServer(["0.6.0"], { badChecksum: true });
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "0.5.0",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/Checksum mismatch/);
    }
    expect(readBundleVersion(bundleDir)).toBe("0.5.0");
    expect(existsSync(`${bundleDir}.previous`)).toBe(false);
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
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/missing autonomos-darwin-arm64/);
    }
  });

  it('refuses when the current version is "unknown" (corrupt install)', async () => {
    const apiBase = await startFixtureServer(["0.6.0"]);
    const bundleDir = installLiveBundle("0.5.0");
    const result = await performUpgrade({
      ...baseOpts(bundleDir, apiBase),
      currentVersion: "unknown",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/Cannot determine the installed version/);
    }
    expect(readBundleVersion(bundleDir)).toBe("0.5.0");
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
    expect(back).toEqual({ status: "rolled-back", from: "0.6.0", to: "0.5.0" });
    expect(readBundleVersion(bundleDir)).toBe("0.5.0");
    expect(readBundleVersion(`${bundleDir}.previous`)).toBe("0.6.0");

    const forward = performRollback(bundleDir);
    expect(forward).toEqual({
      status: "rolled-back",
      from: "0.5.0",
      to: "0.6.0",
    });
    expect(readBundleVersion(bundleDir)).toBe("0.6.0");
  });

  it("errors when there is no .previous", () => {
    const bundleDir = installLiveBundle("0.5.0");
    const result = performRollback(bundleDir);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/No previous version/);
    }
  });
});

describe("compareSemver", () => {
  it.each([
    ["0.5.0", "0.5.0", 0],
    ["0.5.1", "0.5.0", 1],
    ["0.5.0", "0.5.1", -1],
    ["1.0.0", "0.9.9", 1],
    ["0.5.0", "0.5.0-beta.1", 0], // pre-release suffixes ignored by design
    ["0.10.0", "0.9.0", 1], // numeric, not lexicographic
    ["0.5", "0.5.0", 0],
  ] as const)("compare(%s, %s) === %i", (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});
