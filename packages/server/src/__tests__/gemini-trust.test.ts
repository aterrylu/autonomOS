/**
 * Gemini folder trust.
 *
 * In a folder it doesn't trust, Gemini 0.46 shows "Do you trust the files in
 * this folder?" and, until trusted, overrides any --approval-mode to "default"
 * (measured: a yolo agent ran as default). With Auto-Trust on we pass
 * --skip-trust (session-scoped); with it off, a startup notice says why the
 * agent is waiting.
 *
 * The notice is checked against REAL Gemini output: the fixture is the raw PTY
 * byte stream of the dialog (fresh HOME, untrusted folder; temp path renamed),
 * so a needle that only matches an idealized render can't pass here.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-gemini-trust-${randomUUID()}`;

const { geminiCliProvider } = await import("../providers/gemini-cli.js");
const { createStartupNoticeScanner } = await import(
  "../agents/startupNotices.js"
);
const { updateSettings } = await import("../settings.js");

const REAL_DIALOG: string = JSON.parse(
  readFileSync(
    new URL("./fixtures/gemini-trust-dialog.json", import.meta.url),
    "utf8",
  ),
).output;

const notices = geminiCliProvider.startupNotices ?? [];

function scan(chunks: string[]): string[] {
  const fired: string[] = [];
  const feed = createStartupNoticeScanner(notices, (m) => fired.push(m));
  for (const c of chunks) feed(c);
  return fired;
}

function chunked(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

describe("Gemini trust dialog notice (real render)", () => {
  it("declares a trust-dialog notice", () => {
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /runs as Ask/);
  });

  it("fires exactly once on Gemini's real dialog output", () => {
    assert.equal(scan([REAL_DIALOG]).length, 1);
  });

  it("fires regardless of how the output is chunked", () => {
    for (const size of [1, 7, 64, 333]) {
      assert.equal(scan(chunked(REAL_DIALOG, size)).length, 1, `size ${size}`);
    }
  });

  it("fires even when the needle itself is split across chunks", () => {
    // Gemini repaints the dialog (three copies in this render), so a split of
    // the whole stream would still leave an intact later copy — vacuous. Use
    // only the output up to the SECOND copy: exactly one needle, then split it.
    const needle = "Do you trust the files in this folder?";
    const first = REAL_DIALOG.indexOf(needle);
    const once = REAL_DIALOG.slice(0, REAL_DIALOG.indexOf(needle, first + 1));
    assert.equal(once.split(needle).length - 1, 1, "precondition: one copy");
    for (let cut = first + 1; cut < first + needle.length; cut++) {
      assert.equal(
        scan([once.slice(0, cut), once.slice(cut)]).length,
        1,
        `cut at ${cut}`,
      );
    }
  });

  it("stays silent on Gemini's normal (trusted) screen", () => {
    const trusted = REAL_DIALOG.replaceAll(
      "Do you trust the files in this folder?",
      "Type your message or @path/to/file",
    );
    assert.equal(scan([trusted]).length, 0);
  });
});

describe("--skip-trust follows the Auto-Trust setting", () => {
  const args = () =>
    geminiCliProvider.buildArgs({
      cwd: "/tmp",
      permissionMode: "bypass",
      sessionId: randomUUID(),
    } as unknown as ResolvedSpawnOptions);

  it("Auto-Trust on: --skip-trust, and the requested mode is still passed", () => {
    updateSettings({ autoTrust: true });
    const a = args();
    assert.ok(a.includes("--skip-trust"));
    assert.deepEqual(a.slice(0, 2), ["--approval-mode", "yolo"]);
  });

  it("Auto-Trust off: no --skip-trust (the user answers Gemini's own dialog)", () => {
    updateSettings({ autoTrust: false });
    assert.ok(!args().includes("--skip-trust"));
  });
});
