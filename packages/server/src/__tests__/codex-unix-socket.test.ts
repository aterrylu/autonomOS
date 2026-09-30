import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  _resetCodexSocketCacheForTesting,
  chooseCodexEndpoint,
  codexReadyProbe,
  judgeDir,
  MAX_SOCKET_PATH_BYTES,
  tcpAfterFailedUnixStart,
  verifyDaemonSocket,
} from "../agents/codexSocket.js";
import { startSidecarDaemon } from "../agents/sidecar.js";
import {
  _resetCodexControlForTesting,
  deliverToCodex,
} from "../gateway/codexControl.js";
import {
  type RealCodexDaemon,
  startRealCodexDaemon,
} from "./helpers/real-codex-daemon.js";
import { waitUntil } from "./helpers/wait.js";

/**
 * Security audit V4: a Codex agent's `app-server` daemon listened on loopback
 * TCP with no authentication and `danger-full-access`, so any local process of
 * any user could run commands as the operator. It now listens on a unix socket
 * that Codex places in an owner-only directory, and every precondition that
 * fails falls back to TCP with a notice (never refuses the spawn).
 *
 * Every directory here is a fresh temp dir. The real /tmp/codex-daemon-<uid> is
 * never touched: `chooseCodexEndpoint` takes the daemon dir as a parameter.
 */

// Short root: unix socket paths are capped near 104 bytes.
const ROOT = mkdtempSync("/tmp/aos-v4t-");
let n = 0;
function dir(mode = 0o700): string {
  const d = join(ROOT, `d${n++}`);
  mkdirSync(d, { mode });
  chmodSync(d, mode);
  return d;
}

/** A stand-in codex binary whose `app-server --help` does or doesn't list unix://. */
function fakeCodex(supportsUnix: boolean): string {
  const p = join(ROOT, `codex${n++}.sh`);
  writeFileSync(
    p,
    `#!/bin/sh\necho "  --listen <URL>  Supported values: stdio://${supportsUnix ? ", unix://, unix://PATH" : ""}, ws://IP:PORT"\n`,
    { mode: 0o755 },
  );
  return p;
}

/** Whether anything accepts on a unix socket right now (spawns a tiny node
 *  probe, so it can be polled from a synchronous predicate). */
function acceptsSync(path: string): boolean {
  const r = spawnSync(process.execPath, [
    "-e",
    `const s=require("net").connect(process.argv[1]);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));`,
    path,
  ]);
  return r.status === 0;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function listenUnix(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(() => {});
    srv.listen(path, () => resolve(srv));
  });
}

after(() => rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => _resetCodexSocketCacheForTesting());

describe("judgeDir: hostile vs merely loose", () => {
  it("accepts a 0700 directory we own", () => {
    assert.deepEqual(judgeDir(dir()), { ok: true });
  });
  it("calls our own loose directory LOOSE (fixable), not hostile", () => {
    const v = judgeDir(dir(0o755));
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.hostile, false);
  });
  it("calls a symlink, a file, a missing path HOSTILE", () => {
    const link = join(ROOT, `l${n++}`);
    symlinkSync(dir(), link);
    const file = join(ROOT, `f${n++}`);
    writeFileSync(file, "x");
    for (const p of [link, file, join(ROOT, "nope")]) {
      const v = judgeDir(p);
      assert.equal(!v.ok && v.hostile, true, p);
    }
  });
  it("calls another user's directory HOSTILE (mocked stat, since we can't chown)", () => {
    const d = dir();
    const other = (process.getuid?.() ?? 0) + 1;
    const v = judgeDir(d, undefined, () => ({
      ...lstatSync(d),
      uid: other,
      isSymbolicLink: () => false,
      isDirectory: () => true,
    }));
    assert.equal(!v.ok && v.hostile, true);
    assert.match(!v.ok ? v.reason : "", /owned by uid/);
  });
});

describe("chooseCodexEndpoint: unix, compat TCP, or refuse", () => {
  it("picks a fresh per-spawn unix socket in a 0700 cx dir", async () => {
    const configDir = dir();
    const a = await chooseCodexEndpoint(
      "agent-1",
      fakeCodex(true),
      configDir,
      dir(),
    );
    const b = await chooseCodexEndpoint(
      "agent-1",
      fakeCodex(true),
      configDir,
      dir(),
    );
    assert.equal(a.kind, "unix");
    assert.equal(b.kind, "unix");
    if (a.kind !== "unix" || b.kind !== "unix") return;
    assert.equal(a.endpoint, `unix://${a.socketPath}`);
    assert.notEqual(
      a.socketPath,
      b.socketPath,
      "every spawn gets its own path",
    );
    assert.ok(Buffer.byteLength(a.socketPath) <= MAX_SOCKET_PATH_BYTES);
    assert.equal(statSync(join(configDir, "cx")).mode & 0o777, 0o700);
  });

  it("COMPAT → TCP: a Codex without unix listen", async () => {
    const c = await chooseCodexEndpoint("a", fakeCodex(false), dir(), dir());
    assert.equal(c.kind, "tcp");
    assert.match(c.kind === "tcp" ? c.reason : "", /doesn't support/);
  });

  it("COMPAT → TCP: a socket path over the sun_path limit", async () => {
    const deep = join(dir(), "x".repeat(MAX_SOCKET_PATH_BYTES));
    const c = await chooseCodexEndpoint("a", fakeCodex(true), deep, dir());
    assert.equal(c.kind, "tcp");
    assert.match(c.kind === "tcp" ? c.reason : "", /bytes/);
  });

  it("HOSTILE → refuse (never TCP): the daemon dir is a symlink", async () => {
    const link = join(ROOT, `l${n++}`);
    symlinkSync(dir(), link);
    const c = await chooseCodexEndpoint("a", fakeCodex(true), dir(), link);
    assert.equal(c.kind, "refuse");
    assert.match(c.kind === "refuse" ? c.reason : "", /symlink.*sudo rm -rf/s);
  });

  it("HOSTILE → refuse: the daemon dir is another user's, naming the owner and the fix", async () => {
    const d = dir();
    const other = (process.getuid?.() ?? 0) + 1;
    const foreign = (p: string) =>
      p === d
        ? {
            ...lstatSync(d),
            uid: other,
            isSymbolicLink: () => false,
            isDirectory: () => true,
          }
        : lstatSync(p);
    const c = await chooseCodexEndpoint(
      "a",
      fakeCodex(true),
      dir(),
      d,
      foreign,
    );
    assert.equal(c.kind, "refuse");
    const reason = c.kind === "refuse" ? c.reason : "";
    assert.match(reason, new RegExp(`owner uid ${other}`));
    assert.match(reason, new RegExp(`sudo rm -rf ${d}`));
  });

  it("our own LOOSE daemon dir is tightened to 0700 and used (not refused, not TCP)", async () => {
    const d = dir(0o777);
    const c = await chooseCodexEndpoint("a", fakeCodex(true), dir(), d);
    assert.equal(c.kind, "unix");
    assert.equal(statSync(d).mode & 0o777, 0o700);
  });

  it("creates the daemon dir 0700 itself when it doesn't exist yet", async () => {
    const d = join(dir(), "codex-daemon-test");
    const c = await chooseCodexEndpoint("a", fakeCodex(true), dir(), d);
    assert.equal(c.kind, "unix");
    assert.equal(statSync(d).mode & 0o777, 0o700);
  });

  it("sweeps THIS agent's stale sockets, never another agent's", async () => {
    const configDir = dir();
    const mine = await chooseCodexEndpoint(
      "agent-A",
      fakeCodex(true),
      configDir,
      dir(),
    );
    const theirs = await chooseCodexEndpoint(
      "agent-B",
      fakeCodex(true),
      configDir,
      dir(),
    );
    if (mine.kind !== "unix" || theirs.kind !== "unix")
      throw new Error("precondition");
    symlinkSync("/nonexistent/old-daemon", mine.socketPath);
    symlinkSync("/nonexistent/live-daemon", theirs.socketPath);
    await chooseCodexEndpoint("agent-A", fakeCodex(true), configDir, dir());
    assert.equal(
      existsSync(mine.socketPath) || isLink(mine.socketPath),
      false,
      "A's stale link removed",
    );
    assert.equal(isLink(theirs.socketPath), true, "B's entry untouched");
  });

  it("a probe that FAILS still gets unix (optimistic), never TCP, and isn't cached", async () => {
    // Another local user can make the probe slow by loading the machine, so
    // "couldn't check" must not mean TCP (the CX-01 endpoint).
    const bin = join(ROOT, `codex${n++}.sh`);
    writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    // A whole-second mtime, set identically both times: the cache key is
    // path@mtime, and a sub-ms mismatch would re-probe regardless of caching.
    const pinned = new Date(1_700_000_000_000);
    utimesSync(bin, pinned, pinned);
    const c = await chooseCodexEndpoint("a", bin, dir(), dir());
    assert.equal(c.kind, "unix");
    assert.equal(c.kind === "unix" && c.support, "unknown");
    // The binary recovers with the SAME mtime: only an uncached probe notices.
    writeFileSync(bin, `#!/bin/sh\necho "Supported values: unix://PATH"\n`, {
      mode: 0o755,
    });
    utimesSync(bin, pinned, pinned);
    assert.equal(
      statSync(bin).mtimeMs,
      pinned.getTime(),
      "precondition: same cache key",
    );
    const again = await chooseCodexEndpoint("a", bin, dir(), dir());
    assert.equal(again.kind === "unix" && again.support, "yes");
  });

  it("after a failed optimistic unix start: TCP only on a DEFINITE no", async () => {
    const unknownChoice = {
      kind: "unix" as const,
      endpoint: "unix:///x",
      socketPath: "/x",
      support: "unknown" as const,
    };
    // Re-probe says definitely unsupported → the compat reason.
    assert.match(
      (await tcpAfterFailedUnixStart(unknownChoice, fakeCodex(false))) ?? "",
      /doesn't support/,
    );
    // Re-probe fails again (e.g. still overloaded) → no downgrade.
    const failing = join(ROOT, `codex${n++}.sh`);
    writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(await tcpAfterFailedUnixStart(unknownChoice, failing), null);
    // Re-probe says supported → the failure wasn't about support: no downgrade.
    assert.equal(
      await tcpAfterFailedUnixStart(unknownChoice, fakeCodex(true)),
      null,
    );
    // A start that failed after a DEFINITE yes never falls back.
    assert.equal(
      await tcpAfterFailedUnixStart(
        { ...unknownChoice, support: "yes" },
        fakeCodex(false),
      ),
      null,
    );
  });

  it("re-probes the capability when the codex binary changes in place", async () => {
    const bin = fakeCodex(false);
    assert.equal(
      (await chooseCodexEndpoint("a", bin, dir(), dir())).kind,
      "tcp",
    );
    writeFileSync(bin, `#!/bin/sh\necho "Supported values: unix://PATH"\n`, {
      mode: 0o755,
    });
    utimesSync(bin, new Date(), new Date(Date.now() + 5_000));
    assert.equal(
      (await chooseCodexEndpoint("a", bin, dir(), dir())).kind,
      "unix",
    );
  });
});

describe("verifyDaemonSocket (before anything connects)", () => {
  it("accepts a fresh symlinked socket we own in a 0700 dir", async () => {
    const real = join(dir(), "s");
    const srv = await listenUnix(real);
    const link = join(dir(), "link.sock");
    symlinkSync(real, link);
    try {
      assert.equal(verifyDaemonSocket(link, Date.now() - 5_000), null);
    } finally {
      srv.close();
    }
  });

  it("refuses a socket whose real directory others can enter", async () => {
    const real = join(dir(0o755), "s");
    const srv = await listenUnix(real);
    const link = join(dir(), "link.sock");
    symlinkSync(real, link);
    try {
      assert.match(
        verifyDaemonSocket(link) ?? "",
        /directory unsafe.*mode 755/,
      );
    } finally {
      srv.close();
    }
  });

  it("refuses a socket older than this spawn (an orphaned daemon's)", async () => {
    const real = join(dir(), "s");
    const srv = await listenUnix(real);
    try {
      assert.match(
        verifyDaemonSocket(real, Date.now() + 60_000) ?? "",
        /predates this spawn/,
      );
    } finally {
      srv.close();
    }
  });

  it("refuses a link to something that isn't a socket", () => {
    const file = join(dir(), "f");
    writeFileSync(file, "x");
    const link = join(dir(), "link.sock");
    symlinkSync(file, link);
    assert.match(verifyDaemonSocket(link) ?? "", /not a socket/);
  });
});

describe("sidecar readiness by probe (a unix listener prints no banner)", () => {
  // A daemon that writes 300KB to stdout BEFORE listening, like a chatty
  // start-up. Nobody scans output in probe mode; unless the pipes are drained,
  // `head` blocks at the pipe buffer and the socket never appears.
  function chattyDaemon(sock: string): string[] {
    return [
      "-c",
      `head -c 300000 /dev/zero; exec node -e 'require("net").createServer(()=>{}).listen(process.argv[1])' ${sock}`,
    ];
  }

  it("is ready once the probe passes, even with no banner and a full pipe", async () => {
    const sock = join(dir(), "s");
    const sc = await startSidecarDaemon(
      "sh",
      chattyDaemon(sock),
      `unix://${sock}`,
      {
        cwd: ROOT,
        env: process.env as Record<string, string>,
        readyNeedle: "listening on",
        readyTimeoutMs: 10_000,
        readyProbe: async () => existsSync(sock),
      },
    );
    await sc.dispose();
  });

  it("fails the start, and kills the daemon, when the probe throws", async () => {
    const sock = join(dir(), "s");
    let pid: number | undefined;
    await assert.rejects(
      startSidecarDaemon("sh", chattyDaemon(sock), `unix://${sock}`, {
        cwd: ROOT,
        env: process.env as Record<string, string>,
        readyNeedle: "listening on",
        readyTimeoutMs: 10_000,
        readyProbe: async () => {
          if (!existsSync(sock)) return false;
          throw new Error("unsafe Codex socket: test");
        },
      }).then((s) => {
        pid = s.proc.pid;
      }),
      /unsafe Codex socket/,
    );
    assert.equal(pid, undefined, "the start must not resolve");
    // …and the daemon it started is gone: nothing accepts on its socket.
    await waitUntil(
      () => !existsSync(sock) || !acceptsSync(sock),
      "the rejected daemon to stop listening",
    );
  });
});

describe("sidecar readiness never adopts another daemon (review: orphans)", () => {
  it("does not adopt an orphan's socket: it predates the spawn, and ours exits", async () => {
    // An orphan from an earlier spawn holds a socket that accepts; the daemon
    // WE start fails at once (as codex does: "control socket is already in
    // use"). The runtime's probe is verify-then-accept with the spawn's start
    // time, so the orphan's older socket never counts as ours, and our
    // daemon's exit fails the start with what it said.
    const orphanSock = join(dir(), "orphan");
    const orphan = await listenUnix(orphanSock);
    const spawnStartedAt = Date.now() + 5_000; // the orphan is well older
    try {
      await assert.rejects(
        startSidecarDaemon(
          "sh",
          [
            "-c",
            "sleep 0.3; echo 'Error: app-server control socket is already in use' >&2; exit 1",
          ],
          `unix://${orphanSock}`,
          {
            cwd: ROOT,
            env: process.env as Record<string, string>,
            readyNeedle: "listening on",
            readyTimeoutMs: 5_000,
            // The production probe. It THROWS on a socket that fails
            // verification; here the orphan's socket is older than the spawn.
            readyProbe: codexReadyProbe(orphanSock, spawnStartedAt),
          },
        ),
        /unsafe Codex socket.*predates this spawn/s,
      );
    } finally {
      orphan.close();
    }
  });

  it("puts what the daemon said in a probe-mode failure", async () => {
    await assert.rejects(
      startSidecarDaemon(
        "sh",
        ["-c", "echo 'boom: bad flag' >&2; sleep 30"],
        "unix:///nowhere",
        {
          cwd: ROOT,
          env: process.env as Record<string, string>,
          readyNeedle: "listening on",
          readyTimeoutMs: 800,
          readyProbe: async () => false,
        },
      ),
      /did not signal readiness.*daemon said: boom: bad flag/s,
    );
  });
});

describe("codexControl dials a unix:// endpoint (WebSocket over the socket)", () => {
  let daemon: RealCodexDaemon;
  before(async () => {
    daemon = await startRealCodexDaemon({ socketPath: join(dir(), "d.sock") });
  });
  after(async () => {
    _resetCodexControlForTesting();
    await daemon.close();
  });

  it("delivers a turn over the unix socket", async () => {
    assert.ok(
      daemon.endpoint.startsWith("unix://"),
      "precondition: unix endpoint",
    );
    // Not awaited: a delivery that can't reach its daemon stays buffered for a
    // retry and never settles (by design), so the bounded wait below is the
    // oracle, and a broken dial fails in seconds instead of hanging.
    void deliverToCodex(
      "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa",
      daemon.endpoint,
      "V4-UNIX-TURN",
    );
    await waitUntil(
      () => daemon.turns.some((t) => t.text.includes("V4-UNIX-TURN")),
      () => `the turn never reached the daemon (saw ${daemon.turns.length})`,
    );
  });
});
