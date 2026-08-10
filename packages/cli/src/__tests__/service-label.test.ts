// Test-only service label (AUTONOMOS_SERVICE_LABEL) — the containment that
// file/HOME isolation cannot provide.
//
// Background (three production-daemon kills in two days, 2026-08-08/09): the
// launchd label namespace is per-user and GLOBAL. `launchctl unload <file>`
// reads only the Label from the file and unloads whatever loaded job carries
// that label — so a hermetic test harness that wrote production-labeled units
// under an isolated prefix still took down the real daemon the moment
// uninstall-service ran. And the harness's own after-the-fact guard could
// never fire: killing the daemon kills the agent's PTY running the script,
// so the guard dies with the victim. The only fix is that harness-written
// units NEVER carry the production identity in the first place.
//
// These tests are the enforcement Terry asked for: they fail if any unit the
// test harness renders (env override set) carries the production label or
// unit name, and they pin that the unit-sync heal preserves a test label
// rather than "healing" it back to production.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseLaunchAgentPlist, planUnitSync } from "../lib/service-sync.js";
import {
  DEFAULT_LAUNCHAGENT_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  launchAgentFilename,
  renderLaunchAgentPlist,
  serviceLabel,
  systemdUnitName,
} from "../lib/service-templates.js";

const TEST_LABEL = "com.autonomos.daemon.test";

const params = {
  programArgs: ["/opt/test/autonomos", "start", "--port=4321"],
  logDir: "/tmp/test-logs",
  home: "/tmp/test-home",
  path: "/usr/bin:/bin",
};

/** The Label VALUE a plist addresses — exact, not a substring match (the
 * test label contains the production label as a prefix, so substring greps
 * prove nothing). */
function plistLabel(plist: string): string | undefined {
  return plist.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/)?.[1];
}

describe("service identity (AUTONOMOS_SERVICE_LABEL)", () => {
  const saved = process.env.AUTONOMOS_SERVICE_LABEL;
  beforeEach(() => {
    delete process.env.AUTONOMOS_SERVICE_LABEL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTONOMOS_SERVICE_LABEL;
    else process.env.AUTONOMOS_SERVICE_LABEL = saved;
  });

  it("defaults to the production identity when unset", () => {
    assert.equal(serviceLabel(), DEFAULT_LAUNCHAGENT_LABEL);
    assert.equal(launchAgentFilename(), `${DEFAULT_LAUNCHAGENT_LABEL}.plist`);
    assert.equal(systemdUnitName(), DEFAULT_SYSTEMD_UNIT_NAME);
  });

  it("override changes label, plist filename, AND systemd unit name", () => {
    process.env.AUTONOMOS_SERVICE_LABEL = TEST_LABEL;
    assert.equal(serviceLabel(), TEST_LABEL);
    assert.equal(launchAgentFilename(), `${TEST_LABEL}.plist`);
    assert.equal(systemdUnitName(), `${TEST_LABEL}.service`);
  });

  it("ENFORCEMENT: no unit rendered under the test label carries the production identity", () => {
    process.env.AUTONOMOS_SERVICE_LABEL = TEST_LABEL;
    // The plist's Label is what launchctl addresses; the systemd unit NAME is
    // what systemctl addresses. Under the override, neither may equal the
    // production identity — exact comparison, since the test label contains
    // the production label as a prefix.
    assert.equal(plistLabel(renderLaunchAgentPlist(params)), TEST_LABEL);
    assert.notEqual(
      plistLabel(renderLaunchAgentPlist(params)),
      DEFAULT_LAUNCHAGENT_LABEL,
    );
    assert.notEqual(systemdUnitName(), DEFAULT_SYSTEMD_UNIT_NAME);
  });

  it("an explicit label option beats the env default", () => {
    process.env.AUTONOMOS_SERVICE_LABEL = TEST_LABEL;
    const plist = renderLaunchAgentPlist({ ...params, label: "com.other" });
    assert.equal(plistLabel(plist), "com.other");
  });

  it("the unit-sync heal PRESERVES a test label — never re-addresses to production", () => {
    // A drifted test-labeled unit, healed while the env override is ABSENT
    // (worst case: some future code path runs the sync without the harness
    // env). The recovered label must win over serviceLabel()'s default —
    // otherwise a heal would rewrite a test unit into a production-addressed
    // one and resurrect the exact incident this label exists to prevent.
    const testUnit = renderLaunchAgentPlist({
      ...params,
      label: TEST_LABEL,
    }).replace(/<key>RunAtLoad<\/key>\s*<true\/>/, "");
    const plan = planUnitSync("darwin", testUnit);
    assert.ok(plan.kind === "drift");
    assert.equal(plistLabel(plan.fresh), TEST_LABEL);
    assert.equal(parseLaunchAgentPlist(plan.fresh)?.label, TEST_LABEL);
  });
});
