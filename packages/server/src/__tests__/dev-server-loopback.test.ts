import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `make dev: this machine only` (Terry, 2026-10-01). `make dev` used to bind
 * vite to 0.0.0.0 with `allowedHosts: true`, and the dev API server to every
 * interface (no host given), so for as long as it ran, anyone on the LAN could
 * reach the dev dashboard, vite's file serving and its proxy to the API. And
 * any Host header was accepted, which is what a DNS-rebinding page needs.
 * Reaching it from another device is now an explicit opt-in: `make dev-lan`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const VITE_CONFIG = join(ROOT, "packages/dashboard/vite.config.ts");

/** The commands `make <target>` would run, expanded, without running them.
 *  dev-lan's recursive $(MAKE) inherits -n, so it dry-runs too. */
function dryRun(target: string, exported: NodeJS.ProcessEnv = {}): string[] {
  const { DEV_HOST: _drop, ...env } = process.env;
  return execFileSync(
    "make",
    ["-n", "--no-print-directory", "-C", ROOT, target],
    { encoding: "utf8", env: { ...env, ...exported } },
  ).split("\n");
}
/** Run make dev's expanded loopback-warning line for real and return what it
 *  prints (`make -n` only shows it). */
function devWarning(exported: NodeJS.ProcessEnv = {}): string {
  const line = dryRun("dev", exported).find((l) => l.startsWith("case ")) ?? "";
  assert.ok(line, "precondition: make dev has its DEV_HOST warning line");
  return execFileSync("sh", ["-c", line], { encoding: "utf8" });
}
const viteLine = (lines: string[]) =>
  lines.find((l) => /\bvite --host\b/.test(l)) ?? "";
const apiLine = (lines: string[]) =>
  lines.find((l) => l.includes("src/index.ts")) ?? "";

describe("make dev binds this machine only (dev server exposure)", () => {
  it("vite binds 127.0.0.1 by default", () => {
    assert.match(viteLine(dryRun("dev")), /--host 127\.0\.0\.1 /);
  });

  it("the dev API server binds 127.0.0.1, whatever .env says", () => {
    // An explicit variable beats --env-file, which never overrides one.
    assert.match(apiLine(dryRun("dev")), /\bAUTONOMOS_HOST=127\.0\.0\.1\b/);
  });

  it("only `make dev-lan` binds vite to every interface", () => {
    const lan = dryRun("dev-lan");
    assert.match(viteLine(lan), /--host 0\.0\.0\.0 /);
    assert.match(apiLine(lan), /\bAUTONOMOS_HOST=127\.0\.0\.1\b/);
  });

  it("warns loudly whenever vite isn't on loopback, however DEV_HOST was set", () => {
    // Review of #494: `DEV_HOST ?=` honors one exported in the shell, so a
    // plain `make dev` could go LAN silently.
    assert.equal(devWarning(), "");
    assert.match(
      devWarning({ DEV_HOST: "0.0.0.0" }),
      /⚠ DEV_HOST=0\.0\.0\.0: .*reachable by anyone on this network/,
    );
    assert.match(
      viteLine(dryRun("dev", { DEV_HOST: "0.0.0.0" })),
      /--host 0\.0\.0\.0 /,
    );
  });
});

describe("the dashboard's vite config (dev server exposure)", () => {
  const load = async (devHost: string | undefined, tag: string) => {
    const before = process.env.DEV_HOST;
    if (devHost === undefined) delete process.env.DEV_HOST;
    else process.env.DEV_HOST = devHost;
    try {
      // A query string gives each load its own module instance, since the
      // config reads DEV_HOST when it's evaluated.
      const url = `${pathToFileURL(VITE_CONFIG).href}?${tag}`;
      return (await import(url)).default as {
        server: { host?: string; allowedHosts?: unknown; proxy: object };
      };
    } finally {
      if (before === undefined) delete process.env.DEV_HOST;
      else process.env.DEV_HOST = before;
    }
  };

  it("binds 127.0.0.1 and accepts only vite's default hosts", async () => {
    const cfg = await load(undefined, "default");
    assert.equal(cfg.server.host, "127.0.0.1");
    // `true` accepts ANY Host header (DNS rebinding); unset = vite's default
    // (localhost and raw IPs).
    assert.equal(cfg.server.allowedHosts, undefined);
  });

  it("follows DEV_HOST only when it's set (the make dev-lan opt-in)", async () => {
    const cfg = await load("0.0.0.0", "lan");
    assert.equal(cfg.server.host, "0.0.0.0");
    assert.equal(cfg.server.allowedHosts, undefined);
  });

  it("proxies to the loopback API by IP, never a name that could be ::1", async () => {
    const cfg = await load(undefined, "proxy");
    const targets = JSON.stringify(cfg.server.proxy);
    assert.doesNotMatch(targets, /localhost/);
    assert.match(targets, /http:\/\/127\.0\.0\.1:/);
  });
});
