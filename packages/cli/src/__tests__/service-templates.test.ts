import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOT_ERROR_LOG,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
} from "../lib/service-templates.js";

const opts = {
  programArgs: ["/home/u/.autonomos-bin/autonomos", "start", "--port=3100"],
  logDir: "/home/u/.autonomos/logs",
  home: "/home/u",
  path: "/usr/local/bin:/usr/bin:/bin",
};

describe("renderLaunchAgentPlist", () => {
  const plist = renderLaunchAgentPlist(opts);

  it("supervises stdout to /dev/null (the server owns the rotating log)", () => {
    // The whole point of the rotating-logger design: the supervisor must NOT
    // also capture stdout to a growing file (two writers + unbounded growth).
    assert.match(
      plist,
      /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/,
    );
  });

  it("keeps only a tiny stderr boot backstop", () => {
    assert.ok(plist.includes(`${opts.logDir}/${BOOT_ERROR_LOG}`));
    assert.ok(!plist.includes("autonomos.log"), "no supervisor-owned main log");
  });

  it("restarts on crash and runs at load", () => {
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("invokes the supplied program args", () => {
    assert.ok(plist.includes("<string>start</string>"));
    assert.ok(plist.includes("<string>--port=3100</string>"));
  });
});

describe("renderSystemdUserUnit", () => {
  const unit = renderSystemdUserUnit(opts);

  it("discards supervisor stdout and keeps a stderr boot backstop", () => {
    assert.match(unit, /^StandardOutput=null$/m);
    assert.match(
      unit,
      new RegExp(
        `^StandardError=append:${opts.logDir}/${BOOT_ERROR_LOG}$`,
        "m",
      ),
    );
    assert.ok(!unit.includes("autonomos.log"), "no supervisor-owned main log");
  });

  it("restarts always with a backoff", () => {
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^RestartSec=/m);
  });

  it("invokes the supplied program args in ExecStart", () => {
    assert.match(unit, /^ExecStart=.*start --port=3100$/m);
  });
});

describe("the service label reaches the daemon's env (non-default only)", () => {
  it("default-label units render unchanged (no drift for existing installs)", () => {
    delete process.env.AUTONOMOS_SERVICE_LABEL;
    assert.ok(!renderSystemdUserUnit(opts).includes("AUTONOMOS_SERVICE_LABEL"));
    assert.ok(
      !renderLaunchAgentPlist(opts).includes("AUTONOMOS_SERVICE_LABEL"),
    );
  });

  it("a test-labelled unit tells its daemon the label (so it recognizes its own service)", () => {
    process.env.AUTONOMOS_SERVICE_LABEL = "com.autonomos.daemon.test";
    try {
      assert.match(
        renderSystemdUserUnit(opts),
        /^Environment="AUTONOMOS_SERVICE_LABEL=com\.autonomos\.daemon\.test"$/m,
      );
      assert.match(
        renderLaunchAgentPlist(opts),
        /<key>AUTONOMOS_SERVICE_LABEL<\/key>\s*<string>com\.autonomos\.daemon\.test<\/string>/,
      );
    } finally {
      delete process.env.AUTONOMOS_SERVICE_LABEL;
    }
  });
});

// systemd expands % specifiers in ExecStart=, StandardError= and Environment=
// and splits an unquoted Environment= value at whitespace. Measured on
// systemd 255: `Environment=X=100%h` runs as X=100/home/<user>, and
// `Environment=X=a b` runs as X=a. So every value is rendered quoted, with
// `%` doubled and `\` / `"` escaped.
describe("renderSystemdUserUnit: values reach the daemon literally", () => {
  const hostile = {
    programArgs: ["/opt/100%h/autonomos", "start"],
    logDir: "/home/u/logs 50%",
    home: "/home/my user",
    path: '/opt/a%ib:/opt/q"uote:/opt/back\\slash',
    extraEnv: { AUTONOMOS_TOKEN: "t%%k e\\n" },
  };
  const unit = renderSystemdUserUnit(hostile);

  it("doubles % in ExecStart and the StandardError path", () => {
    assert.match(unit, /^ExecStart='\/opt\/100%%h\/autonomos' start$/m);
    assert.match(
      unit,
      new RegExp(
        `^StandardError=append:/home/u/logs 50%%/${BOOT_ERROR_LOG}$`,
        "m",
      ),
    );
  });

  it('quotes every Environment= line, doubling % and escaping \\ and "', () => {
    assert.match(unit, /^Environment="HOME=\/home\/my user"$/m);
    assert.ok(
      unit.includes(
        'Environment="PATH=/opt/a%%ib:/opt/q\\"uote:/opt/back\\\\slash"',
      ),
      unit,
    );
    assert.ok(
      unit.includes('Environment="AUTONOMOS_TOKEN=t%%%%k e\\\\n"'),
      unit,
    );
    for (const line of unit
      .split("\n")
      .filter((l) => l.startsWith("Environment="))) {
      assert.match(line, /^Environment=".*"$/, line);
    }
  });
});
