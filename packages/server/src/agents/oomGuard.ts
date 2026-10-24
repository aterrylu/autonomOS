// OOM containment for agent processes (Linux).
//
// The failure this exists for: an agent runs a build, the kernel OOM-kills
// it, and systemd's default OOMPolicy=stop then stops the WHOLE autonomos
// unit, so the server and every agent die together. The unit template now
// says OOMPolicy=continue (service-templates.ts); this module is the
// per-process half, so the right process is the one that dies and the
// operator is told which agent it belonged to.
//
// Two layers, each measured on systemd 255 / cgroup v2 (see ADR):
//
//  1. oom_score_adj: every agent process tree is raised to base+500 (capped
//     at 1000); the server keeps the base it inherited. Any unprivileged
//     process may RAISE the score of its own-uid processes. The kernel then
//     picks agents before the server in a global OOM, and in a unit-wide one.
//     Needs nothing from systemd, so it applies on every Linux install.
//
//  2. Per-agent cgroups, only when the unit delegated its cgroup to us
//     (Delegate=yes, which the template marks with AUTONOMOS_CGROUP_DELEGATED=1;
//     the cgroup itself carries no marker, measured). The server moves every
//     process of the unit into a `server` leaf (cgroup v2 forbids processes in
//     a cgroup that has controllers enabled for its children), enables
//     memory+pids for the children, and each agent gets `agent-<id>`.
//     Two things follow:
//       - systemd-oomd only ever kills LEAF cgroups (or memory.oom.group
//         ones; systemd v255 oomd-manager.c). Without sub-cgroups the unit
//         IS the leaf, so an oomd kill took the server and every agent at
//         once, whatever OOMPolicy says. Now the candidates are the server
//         leaf and one leaf per agent.
//       - Each agent's memory.events counts the OOM kills of ITS processes,
//         so a kill is attributed to the right agent, including a build the
//         agent survives.
//
// Everything here is best-effort: a failure logs once and leaves the spawn
// alone. Isolation must never be the reason an agent fails to start.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The leaf the server lives in once the unit's cgroup is delegated to us.
 *  upgradeJob.detectSupervisor accepts it as "our unit". */
export const SERVER_LEAF = "server";
/** How far above the server's own score agent processes are raised. */
export const AGENT_OOM_SCORE_RAISE = 500;
const OOM_SCORE_MAX = 1000;

export type OomGuardOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  procRoot?: string;
  cgroupRoot?: string;
  selfPid?: number;
  log?: (msg: string) => void;
};

/** How an agent's main process died, when it died by SIGKILL that the server
 *  didn't send (server-initiated kills never reach the exit verdict). */
export type OomVerdict =
  /** The kernel OOM-killed a process of this agent (its cgroup counted it). */
  | "oom"
  /** Not attributable to one agent, but an OOM kill happened in the unit
   *  around the same time (no per-agent cgroups: non-delegated unit). */
  | "oom-likely"
  /** SIGKILL from outside autonomOS with no OOM kill counted: on Linux
   *  usually systemd-oomd (which kills whole cgroups without the kernel's
   *  OOM counter); on macOS usually jetsam (memory pressure); or kill -9. */
  | "sigkill";

type AgentEntry = { dir: string | null; seenKills: number };

export class OomGuard {
  readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly procRoot: string;
  private readonly cgroupRoot: string;
  private readonly selfPid: number;
  private readonly log: (msg: string) => void;

  private initialized = false;
  private agentScore: number | null = null;
  /** Absolute path of the unit's cgroup when per-agent cgroups are on. */
  private unitDir: string | null = null;
  /** Our own cgroup, for unit-level counts when per-agent cgroups are off. */
  private ownDir: string | null = null;
  private unitSeenKills = 0;
  private readonly agents = new Map<string, AgentEntry>();
  private readonly warned = new Set<string>();

  constructor(opts: OomGuardOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.procRoot = opts.procRoot ?? "/proc";
    this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
    this.selfPid = opts.selfPid ?? process.pid;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Per-agent cgroups are on (the unit delegated its cgroup and setup worked). */
  get isolated(): boolean {
    return this.unitDir !== null;
  }

  /** Once, at boot, before any agent is spawned. Idempotent. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    // Off Linux there's nothing to set up: only the exit verdict applies
    // (macOS kills for memory with SIGKILL too: jetsam).
    if (this.platform !== "linux") return;

    const base = this.readInt(join(this.procRoot, "self", "oom_score_adj"));
    if (base !== null) {
      this.agentScore = Math.min(OOM_SCORE_MAX, base + AGENT_OOM_SCORE_RAISE);
    }

    const own = this.ownCgroupDir();
    this.ownDir = own;
    if (!own) return;
    if (this.env.AUTONOMOS_CGROUP_DELEGATED === "1") {
      // A server that restarts inside a still-delegated unit finds itself
      // already in the leaf: the unit is its parent.
      const unit = own.endsWith(`/${SERVER_LEAF}`)
        ? own.slice(0, -SERVER_LEAF.length - 1)
        : own;
      try {
        this.delegate(unit);
        this.unitDir = unit;
      } catch (err) {
        this.warnOnce(
          "delegate",
          `[oom] per-agent cgroups unavailable (${errText(err)}); agents still get a raised OOM score`,
        );
      }
    }
    const countDir = this.unitDir ?? own;
    this.unitSeenKills = this.readKills(countDir) ?? 0;
  }

  /** After spawning a process for `agentId` (its PTY child, or a daemon it
   *  owns). Raises the OOM score of the process and its current descendants
   *  and, when isolated, moves them into the agent's cgroup. Never throws. */
  attach(agentId: string, pid: number | undefined): void {
    if (!this.initialized || this.platform !== "linux" || !pid || pid <= 0) {
      return;
    }
    const pids = [pid, ...this.descendants(pid)];
    if (this.agentScore !== null) {
      for (const p of pids) {
        try {
          writeFileSync(
            join(this.procRoot, String(p), "oom_score_adj"),
            String(this.agentScore),
          );
        } catch (err) {
          // ESRCH: already gone. Anything else: say so once, carry on.
          if (!isGone(err)) {
            this.warnOnce(
              "adj",
              `[oom] couldn't raise an agent's OOM score: ${errText(err)}`,
            );
          }
        }
      }
    }
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { dir: null, seenKills: 0 };
      this.agents.set(agentId, entry);
    }
    if (!this.unitDir) return;
    const dir = join(this.unitDir, `agent-${safeId(agentId)}`);
    try {
      mkdirSync(dir, { recursive: true });
      if (entry.dir !== dir) {
        entry.dir = dir;
        // The cgroup may predate this life of the agent (a respawn reuses it):
        // only kills from now on are news.
        entry.seenKills = this.readKills(dir) ?? 0;
      }
      for (const p of pids) {
        try {
          writeFileSync(join(dir, "cgroup.procs"), String(p));
        } catch (err) {
          if (!isGone(err)) throw err;
        }
      }
    } catch (err) {
      this.warnOnce(
        "attach",
        `[oom] couldn't move an agent into its own cgroup: ${errText(err)}`,
      );
    }
  }

  /** The agent's main process exited by `signal` and the server didn't kill
   *  it. Returns how to describe it, or null when it isn't an outside kill. */
  exitVerdict(agentId: string, signal: number | undefined): OomVerdict | null {
    if (!this.initialized) return null;
    const entry = this.agents.get(agentId);
    const agentNew = entry?.dir ? this.takeNewKills(entry) : 0;
    const unitNew = this.takeUnitKills();
    if (signal !== 9) return null;
    if (this.platform !== "linux") return "sigkill";
    if (entry?.dir) return agentNew > 0 ? "oom" : "sigkill";
    return unitNew > 0 ? "oom-likely" : "sigkill";
  }

  /** OOM kills since the last call, per live agent (a process the agent
   *  started, e.g. a build, while the agent itself survived). Isolated mode
   *  only; `unattributed` counts unit-level kills when it's off. */
  pollKills(isLive: (agentId: string) => boolean): {
    perAgent: Array<{ agentId: string; kills: number }>;
    unattributed: number;
  } {
    const perAgent: Array<{ agentId: string; kills: number }> = [];
    if (!this.initialized) return { perAgent, unattributed: 0 };
    if (this.unitDir) {
      for (const [agentId, entry] of this.agents) {
        if (!entry.dir || !isLive(agentId)) continue;
        const kills = this.takeNewKills(entry);
        if (kills > 0) perAgent.push({ agentId, kills });
      }
      // Keep the unit baseline current so exitVerdict stays per-agent.
      this.takeUnitKills();
      return { perAgent, unattributed: 0 };
    }
    return { perAgent, unattributed: this.takeUnitKills() };
  }

  /** The agent is gone for good this life. Its cgroup is removed once empty
   *  (processes it orphaned may linger; a later respawn reuses it). */
  release(agentId: string, delayMs = 10_000): void {
    const entry = this.agents.get(agentId);
    this.agents.delete(agentId);
    const dir = entry?.dir;
    if (!dir) return;
    const t = setTimeout(() => {
      if (this.agents.get(agentId)?.dir === dir) return; // respawned meanwhile
      try {
        rmdirSync(dir);
      } catch {
        // EBUSY (lingering processes) or ENOENT: leave it.
      }
    }, delayMs);
    t.unref?.();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private delegate(unit: string): void {
    const leaf = join(unit, SERVER_LEAF);
    mkdirSync(leaf, { recursive: true });
    // Every process of the unit, not just this one: a wrapper (tsx, a shell)
    // left behind would keep the unit cgroup "internal" and make the
    // controller write below fail with EBUSY.
    const procs = readFileSync(join(unit, "cgroup.procs"), "utf-8")
      .split("\n")
      .filter(Boolean);
    for (const p of procs) {
      try {
        writeFileSync(join(leaf, "cgroup.procs"), p);
      } catch (err) {
        if (!isGone(err)) throw err;
      }
    }
    const available = readFileSync(join(unit, "cgroup.controllers"), "utf-8")
      .split(/\s+/)
      .filter(Boolean);
    if (!available.includes("memory")) {
      throw new Error("the memory controller isn't delegated to the unit");
    }
    const want = ["memory", "pids"].filter((c) => available.includes(c));
    writeFileSync(
      join(unit, "cgroup.subtree_control"),
      want.map((c) => `+${c}`).join(" "),
    );
    // A previous life's empty agent cgroups (systemd trims the subtree on a
    // clean stop; this covers the rest).
    for (const d of readdirSync(unit)) {
      if (!d.startsWith("agent-")) continue;
      try {
        rmdirSync(join(unit, d));
      } catch {
        // still has processes: leave it
      }
    }
  }

  private ownCgroupDir(): string | null {
    let text: string;
    try {
      text = readFileSync(
        join(this.procRoot, String(this.selfPid), "cgroup"),
        "utf-8",
      );
    } catch {
      return null;
    }
    // cgroup v2 only: the unified hierarchy's single "0::<path>" line.
    const line = text.split("\n").find((l) => l.startsWith("0::"));
    if (!line) return null;
    const dir = join(this.cgroupRoot, line.slice(3).trim());
    return existsSync(join(dir, "cgroup.procs")) ? dir : null;
  }

  private takeNewKills(entry: AgentEntry): number {
    if (!entry.dir) return 0;
    const now = this.readKills(entry.dir);
    if (now === null) return 0;
    const fresh = Math.max(0, now - entry.seenKills);
    entry.seenKills = now;
    return fresh;
  }

  private takeUnitKills(): number {
    const dir = this.unitDir ?? this.ownDir;
    if (!dir) return 0;
    const now = this.readKills(dir);
    if (now === null) return 0;
    const fresh = Math.max(0, now - this.unitSeenKills);
    this.unitSeenKills = now;
    return fresh;
  }

  /** memory.events `oom_kill`: OOM kills of this cgroup's processes
   *  (hierarchical). null when the file isn't there (no memory controller). */
  private readKills(dir: string): number | null {
    try {
      const text = readFileSync(join(dir, "memory.events"), "utf-8");
      const m = text.match(/^oom_kill (\d+)$/m);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /** Every current descendant of `pid`, from /proc/<n>/stat's ppid. */
  private descendants(pid: number): number[] {
    const children = new Map<number, number[]>();
    let entries: string[];
    try {
      entries = readdirSync(this.procRoot);
    } catch {
      return [];
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(join(this.procRoot, name, "stat"), "utf-8");
        // comm (field 2) may hold spaces and parens: parse after the LAST ')'.
        const ppid = Number(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
        );
        const list = children.get(ppid) ?? [];
        list.push(Number(name));
        children.set(ppid, list);
      } catch {
        // raced with an exit
      }
    }
    const out: number[] = [];
    const queue = [pid];
    while (queue.length) {
      const next = children.get(queue.shift() as number) ?? [];
      out.push(...next);
      queue.push(...next);
    }
    return out;
  }

  private readInt(path: string): number | null {
    try {
      const n = Number(readFileSync(path, "utf-8").trim());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(msg);
  }
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ESRCH" || code === "ENOENT";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The server's one guard. */
export const oomGuard = new OomGuard();
