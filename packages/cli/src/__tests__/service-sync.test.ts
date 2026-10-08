// Supervisor-unit drift sync (service-sync.ts). The invariants under test are
// the ones the feature's safety rests on:
//
//   1. ROUND-TRIP: parse(render(params)) recovers params exactly — including
//      wrapper program paths, --port/--host flags, and env values with XML- or
//      shell-hostile characters. Without this, a unit rendered by the current
//      template would false-positive as "drift" and get rewritten every run.
//   2. IN-SYNC = TRUE NO-OP: byte-identical render → no write, no supervisor
//      command. A quiet upgrade stays quiet.
//   3. DRIFT REWRITE PRESERVES PARAMETERS: an old-template unit is re-rendered
//      with the NEW template but the OLD install-time parameters — programArgs
//      byte-for-byte (so a post-heal rollback restores code at exactly the
//      path the healed unit invokes), port/host, env.
//   4. UNPARSEABLE = HANDS OFF: anything we can't fully recover is skipped,
//      never guessed at, and the installed file is left untouched.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { InstalledService } from "../lib/service-control.js";
import {
  parseLaunchAgentPlist,
  parseSystemdUserUnit,
  planUnitSync,
  syncServiceUnitFor,
} from "../lib/service-sync.js";
import {
  IDENTITY_ENV_KEYS,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
} from "../lib/service-templates.js";
import type { RunResult } from "../lib/shell.js";

// Hostile-but-realistic parameters: a wrapper program path (the make-prod
// shape), explicit --port/--host (the forge shape), and env values containing
// XML entities, spaces, and a single quote to exercise both escapers.
const params = {
  programArgs: [
    "/home/u/work/autonomOS/.autonomos-bin/autonomos",
    "start",
    "--port=3100",
    "--host=127.0.0.1",
  ],
  logDir: "/home/u/.autonomos/logs",
  home: "/home/u",
  path: "/home/u/my bin/&<odd>'dir:/usr/local/bin:/usr/bin:/bin",
};

const ok: RunResult = { ok: true, stdout: "", stderr: "", exitCode: 0 };

function recordingRun(result: RunResult = ok) {
  const calls: string[][] = [];
  const runCmd = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    return result;
  };
  return { calls, runCmd };
}

function tempService(
  platform: "darwin" | "linux",
  content: string,
): InstalledService {
  const dir = mkdtempSync(join(tmpdir(), "svc-sync-"));
  const serviceFile = join(
    dir,
    platform === "darwin" ? "com.autonomos.daemon.plist" : "autonomos.service",
  );
  writeFileSync(serviceFile, content);
  return { platform, serviceFile, uid: 501 };
}

describe("round-trip: parse(render(params)) is exact", () => {
  it("LaunchAgent plist (label recovered too)", () => {
    const recovered = parseLaunchAgentPlist(renderLaunchAgentPlist(params));
    assert.deepEqual(recovered, {
      ...params,
      label: "com.autonomos.daemon",
    });
  });

  it("systemd user unit", () => {
    const recovered = parseSystemdUserUnit(renderSystemdUserUnit(params));
    assert.deepEqual(recovered, params);
  });

  it("systemd survives args needing shell quoting", () => {
    const quoted = {
      ...params,
      programArgs: ["/opt/odd path/auto'nomos", "start", "--port=3100"],
    };
    const recovered = parseSystemdUserUnit(renderSystemdUserUnit(quoted));
    assert.deepEqual(recovered, quoted);
  });

  it("current-template renders plan as in-sync on both platforms", () => {
    assert.equal(
      planUnitSync("darwin", renderLaunchAgentPlist(params)).kind,
      "in-sync",
    );
    assert.equal(
      planUnitSync("linux", renderSystemdUserUnit(params)).kind,
      "in-sync",
    );
  });
});

describe("drift detection and parameter preservation", () => {
  // A pre-ADR-077 unit: identical parameters, but the template predates the
  // StartLimitIntervalSec=0 fix. This is THE motivating case — the fix ships
  // in every bundle but never reaches a frozen unit file.
  const oldTemplateUnit = renderSystemdUserUnit(params)
    .split("\n")
    .filter((l) => !l.startsWith("#") && !l.startsWith("StartLimitIntervalSec"))
    .join("\n");

  it("old-template systemd unit is drift; heal adds the fix, keeps params", () => {
    const plan = planUnitSync("linux", oldTemplateUnit);
    assert.equal(plan.kind, "drift");
    assert.ok(plan.kind === "drift");
    assert.match(plan.fresh, /^StartLimitIntervalSec=0$/m);
    // The healed unit is the current template rendered around the OLD unit's
    // parameters — nothing regenerated from the environment.
    assert.equal(plan.fresh, renderSystemdUserUnit(params));
  });

  it("hand-edited plist is drift; heal restores template, keeps params", () => {
    const edited = renderLaunchAgentPlist(params).replace(
      /<key>KeepAlive<\/key>\s*<true\/>/,
      "<key>KeepAlive</key>\n    <false/>",
    );
    const plan = planUnitSync("darwin", edited);
    assert.equal(plan.kind, "drift");
    assert.ok(plan.kind === "drift");
    assert.match(plan.fresh, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.equal(plan.fresh, renderLaunchAgentPlist(params));
  });

  it("heal NEVER alters programArgs — rollback restores code at the path the healed unit invokes", () => {
    // Post-heal + health-gate-failure leaves the fresh unit with rolled-back
    // code. Rollback swaps content IN PLACE (bundle .previous rename, source
    // previousRef checkout) — the program path is stable — so the healed
    // unit stays valid iff sync preserved programArgs byte-for-byte.
    const linuxPlan = planUnitSync("linux", oldTemplateUnit);
    assert.ok(linuxPlan.kind === "drift");
    assert.deepEqual(linuxPlan.params.programArgs, params.programArgs);
    assert.deepEqual(
      parseSystemdUserUnit(linuxPlan.fresh)?.programArgs,
      params.programArgs,
    );

    const edited = renderLaunchAgentPlist(params).replace(
      "<true/>",
      "<false/>",
    );
    const darwinPlan = planUnitSync("darwin", edited);
    assert.ok(darwinPlan.kind === "drift");
    assert.deepEqual(darwinPlan.params.programArgs, params.programArgs);
    assert.deepEqual(
      parseLaunchAgentPlist(darwinPlan.fresh)?.programArgs,
      params.programArgs,
    );
  });
});

describe("unparseable units are refused, not guessed at", () => {
  it("garbage content", () => {
    assert.equal(planUnitSync("darwin", "not a plist").kind, "unparseable");
    assert.equal(planUnitSync("linux", "not a unit").kind, "unparseable");
  });

  it("plist missing PATH in EnvironmentVariables", () => {
    const noPath = renderLaunchAgentPlist(params).replace(
      /<key>PATH<\/key>\s*<string>[\s\S]*?<\/string>/,
      "",
    );
    assert.equal(planUnitSync("darwin", noPath).kind, "unparseable");
  });

  it("unfamiliar StandardErrorPath (template evolved beyond what we parse)", () => {
    const oddLog = renderLaunchAgentPlist(params).replace(
      "autonomos.boot.error.log",
      "some-other.log",
    );
    assert.equal(planUnitSync("darwin", oddLog).kind, "unparseable");
  });

  it("systemd ExecStart with an unbalanced quote", () => {
    const broken = renderSystemdUserUnit(params).replace(
      /^ExecStart=.*$/m,
      "ExecStart='/opt/unterminated start",
    );
    assert.equal(planUnitSync("linux", broken).kind, "unparseable");
  });
});

describe("syncServiceUnitFor (IO boundary)", () => {
  it("in-sync: no write, no supervisor command", () => {
    const content = renderLaunchAgentPlist(params);
    const svc = tempService("darwin", content);
    const before = statSync(svc.serviceFile).mtimeMs;
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "in-sync");
    assert.equal(calls.length, 0);
    assert.equal(statSync(svc.serviceFile).mtimeMs, before);
    assert.equal(readFileSync(svc.serviceFile, "utf-8"), content);
  });

  it("linux drift: rewrites file and issues exactly one daemon-reload", () => {
    const old = renderSystemdUserUnit(params)
      .split("\n")
      .filter((l) => !l.startsWith("StartLimitIntervalSec"))
      .join("\n");
    const svc = tempService("linux", old);
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "updated");
    assert.equal(
      readFileSync(svc.serviceFile, "utf-8"),
      renderSystemdUserUnit(params),
    );
    assert.deepEqual(calls, [["systemctl", "--user", "daemon-reload"]]);
  });

  it("linux drift with failing daemon-reload: updated, with warning", () => {
    const old = renderSystemdUserUnit(params).replace(
      "RestartSec=5",
      "RestartSec=9",
    );
    const svc = tempService("linux", old);
    const { runCmd } = recordingRun({
      ok: false,
      stdout: "",
      stderr: "no user bus",
      exitCode: 1,
    });

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "updated");
    assert.ok(outcome.kind === "updated");
    assert.equal(outcome.reloadWarning, "no user bus");
    // The file IS healed — the reload just has to wait for the next
    // daemon-reload/reboot, which the caller says out loud.
    assert.equal(
      readFileSync(svc.serviceFile, "utf-8"),
      renderSystemdUserUnit(params),
    );
  });

  it("darwin drift: rewrites file, runs NO commands (caller owns the reload-restart)", () => {
    const edited = renderLaunchAgentPlist(params).replace(
      "<true/>",
      "<false/>",
    );
    const svc = tempService("darwin", edited);
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "updated");
    assert.equal(calls.length, 0);
    assert.equal(
      readFileSync(svc.serviceFile, "utf-8"),
      renderLaunchAgentPlist(params),
    );
  });

  it("unparseable file: skipped, file left byte-identical", () => {
    const svc = tempService("linux", "[Unit]\nDescription=hand-rolled\n");
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "skipped");
    assert.equal(calls.length, 0);
    assert.equal(
      readFileSync(svc.serviceFile, "utf-8"),
      "[Unit]\nDescription=hand-rolled\n",
    );
  });

  it("unreadable file: skipped with reason, no commands", () => {
    const svc: InstalledService = {
      platform: "linux",
      serviceFile: join(mkdtempSync(join(tmpdir(), "svc-sync-")), "missing"),
      uid: 501,
    };
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.equal(outcome.kind, "skipped");
    assert.ok(outcome.kind === "skipped");
    assert.match(outcome.reason, /could not read/);
    assert.equal(calls.length, 0);
  });
});

// ADR-089 applied to the unit file: a re-render carries the operator-identity
// keys (login, bind address, state location) and DROPS every other override
// out loud — named, with the old unit kept — never silently.
describe("hand-edited env: identity keys carried, others dropped loudly", () => {
  const identity = {
    AUTONOMOS_TOKEN: "tok%en with space",
    AUTONOMOS_HOST: "0.0.0.0",
    AUTONOMOS_CONFIG_DIR: "/srv/autonomos state",
  };
  const SECRET = "proxy-password-123";

  // How an operator actually edits a unit: raw lines appended by hand, in
  // systemd's own syntax, alongside the template's.
  const handEditedUnit = renderSystemdUserUnit(params).replace(
    /^(StandardError=.*)$/m,
    [
      "$1",
      'Environment="AUTONOMOS_TOKEN=tok%%en with space"',
      "Environment=AUTONOMOS_HOST=0.0.0.0",
      "Environment='AUTONOMOS_CONFIG_DIR=/srv/autonomos state'",
      `Environment=HTTP_PROXY=http://u:${SECRET}@proxy:3128 NODE_OPTIONS=--max-old-space-size=4096`,
    ].join("\n"),
  );

  const handEditedPlist = renderLaunchAgentPlist(params).replace(
    /(<key>PATH<\/key>\s*<string>[\s\S]*?<\/string>)/,
    `$1
        <key>AUTONOMOS_TOKEN</key>
        <string>tok%en with space</string>
        <key>AUTONOMOS_HOST</key>
        <string>0.0.0.0</string>
        <key>AUTONOMOS_CONFIG_DIR</key>
        <string>/srv/autonomos state</string>
        <key>HTTP_PROXY</key>
        <string>http://u:${SECRET}@proxy:3128</string>
        <key>NODE_OPTIONS</key>
        <string>--max-old-space-size=4096</string>`,
  );

  for (const [platform, content, parse] of [
    ["linux", handEditedUnit, parseSystemdUserUnit],
    ["darwin", handEditedPlist, parseLaunchAgentPlist],
  ] as const) {
    it(`${platform}: the re-render keeps every identity key, value-exact`, () => {
      const plan = planUnitSync(platform, content);
      assert.ok(plan.kind === "drift", plan.kind);
      assert.deepEqual(plan.params.extraEnv, identity);
      assert.deepEqual(parse(plan.fresh)?.extraEnv, identity);
    });

    it(`${platform}: every other key is named as dropped, and absent from the new unit`, () => {
      const plan = planUnitSync(platform, content);
      assert.ok(plan.kind === "drift");
      assert.deepEqual(plan.params.droppedEnvKeys, [
        "HTTP_PROXY",
        "NODE_OPTIONS",
      ]);
      assert.ok(!plan.fresh.includes("HTTP_PROXY"));
      assert.ok(!plan.fresh.includes(SECRET));
    });

    it(`${platform}: sync keeps the old unit, reports names only, and the heal is stable`, () => {
      const svc = tempService(platform, content);
      const { runCmd } = recordingRun();

      const outcome = syncServiceUnitFor(svc, runCmd);

      assert.ok(outcome.kind === "updated", outcome.kind);
      assert.deepEqual(outcome.droppedEnvKeys, ["HTTP_PROXY", "NODE_OPTIONS"]);
      assert.equal(outcome.backupFile, `${svc.serviceFile}.before-sync`);
      assert.equal(
        readFileSync(`${svc.serviceFile}.before-sync`, "utf-8"),
        content,
      );
      assert.equal(
        statSync(`${svc.serviceFile}.before-sync`).mode & 0o777,
        0o600,
      );
      // Names, never values: the outcome is printed.
      assert.ok(!JSON.stringify(outcome).includes(SECRET));
      // The healed unit is in sync — no re-render (or warning) on every run.
      assert.equal(syncServiceUnitFor(svc, runCmd).kind, "in-sync");
    });
  }

  it("nothing dropped → no backup written, no dropped list", () => {
    const old = renderSystemdUserUnit({
      ...params,
      extraEnv: identity,
    }).replace("RestartSec=5", "RestartSec=9");
    const svc = tempService("linux", old);
    const outcome = syncServiceUnitFor(svc, recordingRun().runCmd);
    assert.ok(outcome.kind === "updated");
    assert.equal(outcome.droppedEnvKeys, undefined);
    assert.equal(outcome.backupFile, undefined);
    assert.ok(!existsSync(`${svc.serviceFile}.before-sync`));
  });

  it("the carried set is exactly the one install-source.sh migrates (ADR-089)", () => {
    const script = readFileSync(
      join(import.meta.dirname, "../../../../scripts/install-source.sh"),
      "utf-8",
    );
    const m = script.match(/^MIGRATED_ENV_KEYS="([^"]*)"$/m);
    assert.ok(m, "MIGRATED_ENV_KEYS not found in install-source.sh");
    assert.deepEqual([...IDENTITY_ENV_KEYS].sort(), m[1].split(/\s+/).sort());
  });
});

describe("systemd parsing follows systemd's own rules", () => {
  it("round-trips %, spaces, quotes and backslashes everywhere", () => {
    const hostile = {
      programArgs: ["/opt/100%h/my bin/autonomos", "start", "--host=a%b"],
      logDir: "/home/u/logs 50%",
      home: "/home/my user",
      path: '/opt/a%ib:/opt/q"uote:/opt/back\\slash',
      extraEnv: { AUTONOMOS_TOKEN: "t%%k e\\n\"x'" },
    };
    const unit = renderSystemdUserUnit(hostile);
    assert.deepEqual(parseSystemdUserUnit(unit), hostile);
    assert.equal(planUnitSync("linux", unit).kind, "in-sync");
  });

  it("a legacy unquoted unit parses as systemd ran it, and heals once", () => {
    // Pre-quoting template: raw `Environment=K=V` lines. systemd 255 runs
    // `Environment=PATH=/a b` as PATH=/a (measured), so that IS the value.
    const legacy = renderSystemdUserUnit(params)
      .replace(/^Environment="HOME=.*"$/m, "Environment=HOME=/home/u")
      .replace(/^Environment="PATH=.*"$/m, "Environment=PATH=/usr/bin:/bin");
    const svc = tempService("linux", legacy);
    const { calls, runCmd } = recordingRun();

    const outcome = syncServiceUnitFor(svc, runCmd);

    assert.ok(outcome.kind === "updated");
    assert.equal(outcome.droppedEnvKeys, undefined);
    assert.equal(
      readFileSync(svc.serviceFile, "utf-8"),
      renderSystemdUserUnit({
        ...params,
        home: "/home/u",
        path: "/usr/bin:/bin",
      }),
    );
    assert.deepEqual(calls, [["systemctl", "--user", "daemon-reload"]]);
    assert.equal(syncServiceUnitFor(svc, runCmd).kind, "in-sync");
  });

  it("a later assignment wins, as in systemd", () => {
    const unit = renderSystemdUserUnit(params).replace(
      /^(StandardError=.*)$/m,
      "$1\nEnvironment=AUTONOMOS_HOST=127.0.0.1\nEnvironment=AUTONOMOS_HOST=0.0.0.0",
    );
    assert.deepEqual(parseSystemdUserUnit(unit)?.extraEnv, {
      AUTONOMOS_HOST: "0.0.0.0",
    });
  });

  it("an unbalanced quote in Environment= is unparseable, not guessed at", () => {
    const unit = renderSystemdUserUnit(params).replace(
      /^(StandardError=.*)$/m,
      '$1\nEnvironment="AUTONOMOS_TOKEN=unterminated',
    );
    assert.equal(planUnitSync("linux", unit).kind, "unparseable");
  });
});
