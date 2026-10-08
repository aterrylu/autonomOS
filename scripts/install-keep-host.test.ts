import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function keptPattern(name = "KEPT_HOST"): string {
  const line = readFileSync(INSTALL, "utf8")
    .split("\n")
    .find((l) => l.includes(`${name}=$(grep -oE`));
  assert.ok(line, `install.sh still extracts ${name} with grep -oE`);
  const m = /grep -oE -- '([^']+)'/.exec(line);
  assert.ok(m, "pattern found");
  return m[1];
}

function kept(serviceText: string, name = "KEPT_HOST"): string {
  const res = spawnSync("grep", ["-oE", "--", keptPattern(name)], {
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

describe("install.sh keeps the service's --trust-proxy (ADR-140)", () => {
  it("survives the re-render, so an update doesn't stop trusting serve", () => {
    assert.equal(
      kept(
        "<string>--host=127.0.0.1</string><string>--trust-proxy=tailscale</string>",
        "KEPT_TRUST",
      ),
      "--trust-proxy=tailscale",
    );
  });
  it("and is passed to install-service", () => {
    assert.match(
      readFileSync(INSTALL, "utf8"),
      /\[\[ -n "\$KEPT_TRUST" \]\] && KEEP_FLAGS\+=\("\$KEPT_TRUST"\)/,
    );
  });
});

describe("install.sh keeps an explicit --serve-socket (ADR-153)", () => {
  it("survives the re-render", () => {
    assert.equal(
      kept(
        "<string>--trust-proxy=tailscale</string><string>--serve-socket=/srv/aos/serve.sock</string>",
        "KEPT_SERVE",
      ),
      "--serve-socket=/srv/aos/serve.sock",
    );
  });
  it("and is passed to install-service", () => {
    assert.match(
      readFileSync(INSTALL, "utf8"),
      /\[\[ -n "\$KEPT_SERVE" \]\] && KEEP_FLAGS\+=\("\$KEPT_SERVE"\)/,
    );
  });
});
