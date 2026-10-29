import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * install.sh re-renders an existing service and must carry its --host along.
 * Since ADR-139 that can be a LIST (`127.0.0.1,100.x.y.z`): dropping the
 * tailnet half would silently stop serving the tailnet; dropping the loopback
 * half would break the CLI. The pattern is READ FROM install.sh, so this test
 * can't drift from the script.
 */

const INSTALL = fileURLToPath(new URL("./install.sh", import.meta.url));

function keptHostPattern(): string {
  const line = readFileSync(INSTALL, "utf8")
    .split("\n")
    .find((l) => l.includes("KEPT_HOST=$(grep -oE"));
  assert.ok(line, "install.sh still extracts KEPT_HOST with grep -oE");
  const m = /grep -oE -- '([^']+)'/.exec(line);
  assert.ok(m, "pattern found");
  return m[1];
}

function kept(serviceText: string): string {
  const res = spawnSync("grep", ["-oE", "--", keptHostPattern()], {
    input: serviceText,
    encoding: "utf8",
  });
  return res.stdout.split("\n")[0];
}

describe("install.sh keeps the service's --host", () => {
  it("a list survives the re-render (launchd plist)", () => {
    assert.equal(
      kept("<string>--host=127.0.0.1,100.70.53.56</string>"),
      "--host=127.0.0.1,100.70.53.56",
    );
  });
  it("…and a MagicDNS name in the list (systemd ExecStart)", () => {
    assert.equal(
      kept("ExecStart=/x/autonomos start --port=3100 --host=127.0.0.1,dev-box\n"),
      "--host=127.0.0.1,dev-box",
    );
  });
});

describe("install.sh drops the removed --trust-proxy (ADR-158)", () => {
  const script = readFileSync(INSTALL, "utf8");
  it("doesn't carry it into the re-rendered service (the server would refuse it)", () => {
    assert.ok(!/KEEP_FLAGS\+=\("\$KEPT_TRUST"\)/.test(script));
    assert.ok(!/KEPT_TRUST=/.test(script));
  });
  it("and says so when a service file still had it", () => {
    assert.match(
      script,
      /grep -q -- '--trust-proxy' "\$SERVICE_FILE"[\s\S]*Dropping --trust-proxy from the service/,
    );
  });
});

describe("install.sh won't re-render a --trust-proxy unit while tailscale serve still forwards to it (ADR-158)", () => {
  /** Run install.sh's own serve_forwards_port with a fake `tailscale` whose
   *  `serve status` prints `status`. Never touches the real Tailscale. */
  function forwards(status: string, port: number): boolean {
    const dir = mkdtempSync(join(tmpdir(), "fake-ts-"));
    try {
      const fake = join(dir, "tailscale");
      writeFileSync(fake, `#!/bin/sh\ncat <<'EOT'\n${status}\nEOT\n`);
      chmodSync(fake, 0o755);
      const fn = /^serve_forwards_port\(\) \{[\s\S]*?^\}/m.exec(
        readFileSync(INSTALL, "utf8"),
      );
      assert.ok(fn, "install.sh defines serve_forwards_port at top level");
      // pipefail, exactly as install.sh runs (set -euo pipefail).
      const r = spawnSync("bash", ["-c", `set -o pipefail\n${fn[0]}\nserve_forwards_port ${port}`], {
        env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      });
      return r.status === 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("detects serve forwarding to this port", () => {
    assert.equal(
      forwards("https://box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3100", 3100),
      true,
    );
  });
  it("a match followed by lots more output still reads as forwarding (no SIGPIPE false negative under pipefail; nox, #548)", () => {
    const tail = "|-- /other proxy http://127.0.0.1:9999\n".repeat(60_000);
    assert.equal(
      forwards(`|-- / proxy http://127.0.0.1:3100\n${tail}`, 3100),
      true,
    );
  });
  it("…and not another port, or no serve config", () => {
    assert.equal(
      forwards("https://box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:31000", 3100),
      false,
    );
    assert.equal(forwards("No serve config", 3100), false);
  });
  it("the upgrade path stops (exit 1, the reset + --host commands) instead of dropping the flag in that case", () => {
    const script = readFileSync(INSTALL, "utf8");
    assert.match(
      script,
      /if serve_forwards_port "\$TS_PORT"; then[\s\S]*tailscale serve reset[\s\S]*--host=127\.0\.0\.1,\\\$\(tailscale ip -4\)[\s\S]*exit 1/,
    );
  });
});
