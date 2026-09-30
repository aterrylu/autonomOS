/**
 * A sidecar daemon a previous server left running must be stopped before a new
 * one starts for the same agent: Codex's orphaned `app-server` keeps the
 * agent's thread loaded, so a new daemon can't load it and inbound never lands
 * (measured on codex 0.157.1). These tests use a stand-in "daemon" — a node
 * process whose command line carries `app-server --listen <endpoint>` — so no
 * codex binary, and nothing touches ~/.codex or its login.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn as cpSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { AgentProvider, UUID } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
const CFG = `/tmp/aos-sidecar-rec-${randomUUID().slice(0, 8)}`;
process.env.AUTONOMOS_CONFIG_DIR = CFG;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53931);
setAuthToken("test-token-sidecar-records-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-sr-${randomUUID().slice(0, 8)}.sock`),
);
const {
  forgetSidecar,
  isDaemonFor,
  readSidecarRecord,
  reapAllOrphanSidecars,
  reapOrphanSidecar,
  recordSidecar,
} = await import("../agents/sidecarRecords.js");
const { startSidecarDaemon } = await import("../agents/sidecar.js");
const { spawnAgent, killAttachment } = await import("../agents/runtime.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { codexProvider } = await import("../providers/codex.js");
const { buildAgent, insertAgent, markExited, markActivity, patchAgent } =
  await import("../agents/store.js");

const standIns: ChildProcess[] = [];

/** A detached stand-in for an orphaned daemon (not our child's lifecycle). */
function orphan(endpoint: string, ignoreTerm = false): number {
  const body = ignoreTerm
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1e9)"
    : "setInterval(()=>{},1e9)";
  const p = cpSpawn(
    process.execPath,
    ["-e", body, "app-server", "--listen", endpoint],
    { detached: true, stdio: "ignore" },
  );
  p.unref();
  standIns.push(p);
  assert.ok(p.pid, "stand-in started");
  return p.pid as number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150));

afterEach(() => {
  for (const p of standIns.splice(0))
    if (p.pid && alive(p.pid)) p.kill("SIGKILL");
});
after(() => rmSync(CFG, { recursive: true, force: true }));

describe("isDaemonFor", () => {
  it("matches the recorded endpoint exactly, not a prefix", () => {
    const cmd = "codex app-server --listen unix:///x/cx/a1.sock -c k=v";
    assert.equal(isDaemonFor(cmd, "unix:///x/cx/a1.sock"), true);
    assert.equal(isDaemonFor(cmd, "unix:///x/cx/a1"), false);
    assert.equal(
      isDaemonFor(
        "codex --remote unix:///x/cx/a1.sock",
        "unix:///x/cx/a1.sock",
      ),
      false,
    );
  });
});

describe("isDaemonFor — spaced paths and argv", () => {
  const ep =
    "unix:///Users/x/Library/Application Support/autonomos/cx/a1-9f.sock";
  it("a ps line with a spaced endpoint matches it whole, not a prefix", () => {
    assert.equal(
      isDaemonFor(`codex app-server --listen ${ep} -c k=v`, ep),
      true,
    );
    assert.equal(isDaemonFor(`codex app-server --listen ${ep}`, ep), true);
    assert.equal(
      isDaemonFor(`codex app-server --listen ${ep}`, ep.replace("a1-9f", "a1")),
      false,
    );
    assert.equal(isDaemonFor(`codex app-server --listen ${ep}x`, ep), false);
  });
  it("an argv (Linux /proc) matches exactly", () => {
    assert.equal(
      isDaemonFor(["codex", "app-server", "--listen", ep], ep),
      true,
    );
    assert.equal(isDaemonFor(["codex", "--remote", ep], ep), false);
  });
});

describe("records", () => {
  it("forget only removes the record if it is still that daemon's", () => {
    const id = randomUUID();
    recordSidecar(id, {
      pid: 4242,
      endpoint: "ws://127.0.0.1:1",
      startedAt: 1,
    });
    forgetSidecar(id, 1111); // an older daemon exiting late
    assert.equal(readSidecarRecord(id)?.pid, 4242);
    forgetSidecar(id, 4242);
    assert.equal(readSidecarRecord(id), null);
  });
});

describe("reapOrphanSidecar", () => {
  it("no record → none", async () => {
    assert.equal(await reapOrphanSidecar(randomUUID()), "none");
  });

  it("a dead recorded pid → gone, record removed", async () => {
    const id = randomUUID();
    const pid = orphan("ws://127.0.0.1:2");
    process.kill(pid, "SIGKILL");
    await settle();
    recordSidecar(id, { pid, endpoint: "ws://127.0.0.1:2", startedAt: 1 });
    assert.equal(await reapOrphanSidecar(id), "gone");
    assert.equal(readSidecarRecord(id), null);
  });

  it("a live orphan on the recorded endpoint is stopped", async () => {
    const id = randomUUID();
    const ep = `ws://127.0.0.1:${40000 + Math.floor(Math.random() * 1000)}`;
    const pid = orphan(ep);
    await settle();
    recordSidecar(id, { pid, endpoint: ep, startedAt: 1 });
    assert.equal(await reapOrphanSidecar(id), "reaped");
    assert.equal(alive(pid), false);
    assert.equal(readSidecarRecord(id), null);
  });

  it("one that ignores SIGTERM is escalated to SIGKILL", async () => {
    const id = randomUUID();
    const pid = orphan("ws://127.0.0.1:3", true);
    await settle();
    recordSidecar(id, { pid, endpoint: "ws://127.0.0.1:3", startedAt: 1 });
    assert.equal(await reapOrphanSidecar(id), "reaped");
    assert.equal(alive(pid), false);
  });

  it("a recycled pid (command line isn't that daemon) is NEVER signaled", async () => {
    const id = randomUUID();
    const pid = orphan("ws://127.0.0.1:4"); // listening elsewhere
    await settle();
    recordSidecar(id, { pid, endpoint: "ws://127.0.0.1:5", startedAt: 1 });
    assert.equal(await reapOrphanSidecar(id), "not-daemon");
    assert.equal(alive(pid), true, "left alone");
    assert.equal(readSidecarRecord(id), null, "the stale record is dropped");
  });

  it("a daemon THIS process runs is left to its own lifecycle", async () => {
    const id = randomUUID();
    const ep = "ws://127.0.0.1:6";
    const sc = await startSidecarDaemon(
      process.execPath,
      [
        "-e",
        "console.log('listening on');setInterval(()=>{},1e9)",
        "app-server",
        "--listen",
        ep,
      ],
      ep,
      {
        cwd: tmpdir(),
        env: { ...process.env } as Record<string, string>,
        readyNeedle: "listening on",
      },
    );
    try {
      recordSidecar(id, {
        pid: sc.proc.pid as number,
        endpoint: ep,
        startedAt: 1,
      });
      assert.equal(await reapOrphanSidecar(id), "ours");
      assert.equal(alive(sc.proc.pid as number), true);
    } finally {
      await sc.dispose();
    }
  });

  it("alive but unidentifiable (no ps, no /proc): NOT signaled, record KEPT", {
    skip: existsSync("/proc/self/cmdline"),
  }, async () => {
    const id = randomUUID();
    const ep = "ws://127.0.0.1:11";
    const pid = orphan(ep);
    await settle();
    recordSidecar(id, { pid, endpoint: ep, startedAt: 1 });
    const path = process.env.PATH;
    process.env.PATH = ""; // `ps` can't be found
    try {
      assert.equal(await reapOrphanSidecar(id), "unverified");
    } finally {
      process.env.PATH = path;
    }
    assert.equal(alive(pid), true, "never signaled");
    assert.equal(readSidecarRecord(id)?.pid, pid, "kept for a later try");
    assert.equal(await reapOrphanSidecar(id), "reaped", "…which works");
  });

  it("the boot sweep reaps every recorded orphan", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const pa = orphan("ws://127.0.0.1:7");
    const pb = orphan("ws://127.0.0.1:8");
    await settle();
    recordSidecar(a, { pid: pa, endpoint: "ws://127.0.0.1:7", startedAt: 1 });
    recordSidecar(b, { pid: pb, endpoint: "ws://127.0.0.1:8", startedAt: 1 });
    const out = await reapAllOrphanSidecars();
    const byId = Object.fromEntries(out.map((o) => [o.agentId, o.outcome]));
    assert.equal(byId[a], "reaped");
    assert.equal(byId[b], "reaped");
    assert.equal(alive(pa) || alive(pb), false);
  });
});

describe("spawnAgent stops the orphan BEFORE starting the new daemon", () => {
  const NAME = "codex";
  const cwd = mkdtempSync(join(tmpdir(), "aos-sr-cwd-"));
  const started: number[] = [];
  let orphanAliveAtNewStart: boolean | undefined;
  let orphanPid = 0;
  // A stand-in codex binary: answers `app-server --help` like a Codex that
  // predates unix listeners (so this TCP-only fake daemon takes V4's honest
  // compat path to loopback TCP, as a real old Codex would), else runs node.
  // It must `exec` node, not run it as a child: the daemon's own command line
  // then stays `node … app-server --listen <endpoint>`, which is what the
  // reaper's isDaemonFor guard (and the orphan assertion below) match on.
  const fakeBin = join(cwd, "codex-fake.sh");
  writeFileSync(
    fakeBin,
    `#!/bin/sh\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then echo "--listen <URL>  Supported values: stdio://, ws://IP:PORT"; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  const fake: AgentProvider = {
    ...codexProvider,
    name: NAME as never,
    displayName: "FakeCodex",
    resolveBinary: () => fakeBin,
    buildSidecar: (r) => {
      // Called right before the new daemon starts: the orphan must be gone.
      orphanAliveAtNewStart = orphanPid ? alive(orphanPid) : undefined;
      return {
        args: [
          "-e",
          "console.log('listening on');setInterval(()=>{},1e9)",
          "app-server",
          "--listen",
          r.sidecarEndpoint as string,
        ],
        readyNeedle: "listening on",
      };
    },
    buildArgs: () => ["-e", "setTimeout(()=>{},30000)"],
    hasResumableThread: () => true,
  };
  const ids: UUID[] = [];

  beforeEach(() => _setProviderForTesting(NAME, fake));
  afterEach(() => {
    for (const id of ids.splice(0)) killAttachment(id);
  });
  after(() => {
    _setProviderForTesting(NAME, null);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a resumed agent's orphaned daemon is reaped, and the new one is recorded then forgotten on exit", async () => {
    const id = randomUUID() as UUID;
    ids.push(id);
    insertAgent(
      buildAgent({
        id,
        name: `sr-${id.slice(0, 4)}`,
        workingDirectory: cwd,
        provider: NAME as never,
        providerSessionId: id,
        permissionMode: "ask",
        status: "running",
      }),
    );
    patchAgent(id, { providerThreadId: "thread-held" });
    markActivity(id, Date.now() - 60_000);
    markExited(id, "crashed");

    // What a SIGKILLed server leaves: a live daemon and its record.
    const oldEp = "ws://127.0.0.1:9";
    orphanPid = orphan(oldEp);
    await settle();
    recordSidecar(id, { pid: orphanPid, endpoint: oldEp, startedAt: 1 });

    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });

    assert.equal(
      orphanAliveAtNewStart,
      false,
      "orphan stopped before the new daemon started",
    );
    assert.equal(alive(orphanPid), false);
    const rec = readSidecarRecord(id);
    assert.ok(rec, "the new daemon is recorded");
    assert.notEqual(rec?.pid, orphanPid);
    assert.equal(alive(rec?.pid as number), true);
    started.push(rec?.pid as number);

    killAttachment(id);
    ids.splice(ids.indexOf(id), 1);
    for (let i = 0; i < 60 && readSidecarRecord(id); i++) await settle();
    assert.equal(readSidecarRecord(id), null, "forgotten once it exited");
    assert.equal(existsSync(join(CFG, "sidecars", `${id}.json`)), false);
  });
});
