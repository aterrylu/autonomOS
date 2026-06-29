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
