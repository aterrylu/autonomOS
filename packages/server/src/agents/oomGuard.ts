// OOM containment for agent processes.
//
// The failure this exists for: an agent runs a build, the kernel OOM-kills
// it, and systemd's default OOMPolicy=stop then stops the WHOLE autonomos
// unit, so the server and every agent die together. The unit template now
// says OOMPolicy=continue (service-templates.ts); this module is the
// per-process half, so the right process is the one that dies and the
// operator is told which agent it belonged to (ADR-156).
//
// Two layers on Linux, each measured on systemd 255 / cgroup v2:
//
//  1. oom_score_adj: every agent process tree is raised to base+500 (capped
//     at 1000); the server keeps the base it inherited. Any unprivileged
//     process may RAISE the score of its own-uid processes. The kernel then
//     picks agents before the server, in a global OOM and in a unit-wide one.
//     Needs nothing from systemd.
//
//  2. Per-agent cgroups, only when the unit delegated its cgroup to us
//     (Delegate=yes, which the template marks with AUTONOMOS_CGROUP_DELEGATED=1;
//     the cgroup itself carries no marker, measured). The server moves every
//     process of the unit into a `server` leaf (cgroup v2 forbids processes in
//     a cgroup that has controllers enabled for its children), enables
//     memory+pids for the children, and each agent gets `agent-<id>`:
//       - systemd-oomd only ever kills LEAF cgroups (or memory.oom.group
//         ones; systemd v255 oomd-manager.c). Without sub-cgroups the unit
//         IS the leaf, so an oomd kill took the server and every agent at
//         once, whatever OOMPolicy says.
//       - Each agent's memory.events counts the OOM kills of ITS processes,
//         so a kill is attributed to the right agent, including a build the
//         agent survives.
//
// Off Linux only the exit verdict applies: macOS reclaims memory by SIGKILL
// too (jetsam), and the operator should hear about it the same way.
//
// Everything here is best-effort and never throws: a failure is logged (per
// agent, not once) and the spawn goes on. Isolation must never be the reason
// an agent fails to start.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** The leaf the server lives in once the unit's cgroup is delegated to us.
 *  upgradeJob.detectSupervisor accepts it as "our unit". */
export const SERVER_LEAF = "server";
/** How far above the server's own score agent processes are raised. */
export const AGENT_OOM_SCORE_RAISE = 500;
const OOM_SCORE_MAX = 1000;
const DELEGATE_ATTEMPTS = 3;

export type OomGuardOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  procRoot?: string;
  cgroupRoot?: string;
  selfPid?: number;
  log?: (msg: string) => void;
};

/** How an agent's main process ended, when memory had a hand in it or it was
 *  SIGKILLed from outside (the server's own kills never reach the verdict:
 *  they take the agent out of `live` first). */
export type OomVerdict =
  /** It crashed, and the kernel OOM-killed one of its processes (its cgroup
   *  counted it): the main process itself, or one it depended on (the Codex
   *  daemon, whose TUI then exits with a code, not a signal). */
  | "oom"
  /** It exited cleanly after one of its processes was OOM-killed (a build it
   *  started): reported, but it ended on its own, so it isn't resumed. */
  | "oom-then-exited"
  /** SIGKILLed while the unit counted an OOM kill, but with no per-agent
   *  cgroups to say whose (a non-delegated unit). */
  | "oom-likely"
  /** SIGKILLed from outside autonomOS with no OOM kill counted: on Linux
   *  usually systemd-oomd (which kills whole cgroups without the kernel's OOM
   *  counter); on macOS usually jetsam; or kill -9. */
  | "sigkill";

type AgentEntry = {
  dir: string | null;
  seenKills: number;
  /** The agent's main process (its PTY child). The poll leaves an agent
   *  whose leader is gone to the exit verdict, so one kill isn't reported
   *  twice, differently (the exit handler runs after the timer under load). */
  leader: number | null;
};

export type PollResult = {
  /** Kills of processes an agent started while the agent itself survived. */
  perAgent: Array<{ agentId: string; kills: number }>;
  /** Kills no live agent can claim: the server's own processes, a dead
   *  agent's leftovers, or (without per-agent cgroups) anything in the unit
   *  that no exit claimed within a poll cycle. */
  unattributed: number;
};

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
  /** Our own cgroup when we run as a systemd service, for unit-level counts
   *  without per-agent cgroups. null outside a service (a terminal's scope
   *  holds unrelated processes, so its kills aren't ours to report). */
  private ownServiceDir: string | null = null;
  private unitSeenKills = 0;
  /** Without per-agent cgroups: unit-level kills not yet claimed by an exit.
   *  The poll reports them only after a full cycle unclaimed. */
  private pendingUnit = { count: 0, since: 0 };
  /** With per-agent cgroups: kill counts of cgroups no live agent owns (the
   *  server leaf, dead agents' leftovers), by dir. */
  private readonly otherSeen = new Map<string, number>();
  private readonly agents = new Map<string, AgentEntry>();
  private readonly warnedKeys = new Set<string>();
  /** Why per-agent isolation is off although the unit asked for it. */
  degradedReason: string | null = null;

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

  /** The unit asked for per-agent cgroups (the template's marker). */
  get delegationRequested(): boolean {
    return this.env.AUTONOMOS_CGROUP_DELEGATED === "1";
  }

  /** Once, at boot, before any agent is spawned. Idempotent. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (this.platform !== "linux") return;

    const base = this.readInt(join(this.procRoot, "self", "oom_score_adj"));
    if (base !== null) {
      this.agentScore = Math.min(OOM_SCORE_MAX, base + AGENT_OOM_SCORE_RAISE);
    }

    const own = this.ownCgroupDir();
    if (!own) return;
    // A server that restarts inside a still-delegated unit finds itself
    // already in the leaf: the unit is its parent.
    const unit = basename(own) === SERVER_LEAF ? join(own, "..") : own;
    const underService = basename(unit).endsWith(".service");
    if (this.delegationRequested && underService) {
      try {
        this.delegate(unit);
        this.unitDir = unit;
        this.otherSeen.set(
          join(unit, SERVER_LEAF),
          this.readKills(join(unit, SERVER_LEAF)) ?? 0,
        );
      } catch (err) {
        this.degradedReason = errText(err);
        this.log(
          `[oom] per-agent cgroups unavailable (${this.degradedReason}); agents still get a raised OOM score`,
        );
      }
    }
    if (!this.unitDir && underService) {
      this.ownServiceDir = unit;
      this.unitSeenKills = this.readKills(unit) ?? 0;
    }
  }

  /** After spawning a process for `agentId`: its PTY child (`leader`), or a
   *  daemon it owns. Raises the OOM score of the process and its current
   *  descendants and, when isolated, moves them into the agent's cgroup. */
  attach(
    agentId: string,
    pid: number | undefined,
    opts: { leader?: boolean } = {},
  ): void {
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
          if (!isGone(err)) {
            this.warn(
              `adj:${agentId}`,
              `[oom] couldn't raise the OOM score of agent ${agentId} (pid ${p}): ${errText(err)}`,
            );
          }
        }
      }
    }
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { dir: null, seenKills: 0, leader: null };
      this.agents.set(agentId, entry);
    }
    if (opts.leader) entry.leader = pid;
    if (!this.unitDir) return;

    const dir = join(this.unitDir, `agent-${safeId(agentId)}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.warn(
        `mkdir:${agentId}`,
        `[oom] couldn't create agent ${agentId}'s cgroup: ${errText(err)}`,
      );
      return;
    }
    // A new life of the agent (or its cgroup first appearing): only kills
    // from now on are news. Taken BEFORE the move, so nothing is missed.
    const fresh = entry.dir !== dir || opts.leader === true;
    const baseline = fresh ? (this.readKills(dir) ?? 0) : entry.seenKills;
    let movedFirst = false;
    for (const [i, p] of pids.entries()) {
      try {
        writeFileSync(join(dir, "cgroup.procs"), String(p));
        if (i === 0) movedFirst = true;
      } catch (err) {
        if (isGone(err)) continue;
        this.warn(
          `move:${agentId}:${p}`,
          `[oom] couldn't move agent ${agentId} (pid ${p}) into its own cgroup: ${errText(err)}. It stays in the server's cgroup, unattributed.`,
        );
        if (i === 0) break;
      }
    }
    // The cgroup is the agent's only once its process is really in it;
    // otherwise its (empty) counter would say "no OOM" for a real one.
    if (movedFirst) {
      entry.dir = dir;
      entry.seenKills = baseline;
      this.otherSeen.delete(dir);
    }
  }

  /** The agent's main process ended (exit code, or the signal that killed
   *  it), and the server didn't stop it. Null when memory had no part in it
   *  and it wasn't an outside SIGKILL. */
  exitVerdict(
    agentId: string,
    signal: number | undefined,
    exitCode = 0,
  ): OomVerdict | null {
    if (!this.initialized) return null;
    const crashed = !!signal || exitCode !== 0;
    if (this.platform !== "linux") return signal === 9 ? "sigkill" : null;

    const entry = this.agents.get(agentId);
    if (entry?.dir) {
      const kills = this.takeNewKills(entry);
      if (kills > 0) return crashed ? "oom" : "oom-then-exited";
      return signal === 9 ? "sigkill" : null;
    }
    // No per-agent cgroup: an unclaimed unit-level kill is the best evidence.
    // Claimed only by a crash that looks like one (a SIGKILL).
    this.collectUnitKills();
    if (signal === 9 && this.pendingUnit.count > 0) {
      this.pendingUnit = { count: 0, since: 0 };
      return "oom-likely";
    }
    return signal === 9 ? "sigkill" : null;
  }

  /** OOM kills since the last call that no exit has claimed. */
  pollKills(
    isLive: (agentId: string) => boolean,
    now = Date.now(),
    cycleMs = 5_000,
  ): PollResult {
    const perAgent: PollResult["perAgent"] = [];
    if (!this.initialized || this.platform !== "linux") {
      return { perAgent, unattributed: 0 };
    }
    if (this.unitDir) {
      for (const [agentId, entry] of this.agents) {
        if (!entry.dir || !isLive(agentId)) continue;
        // Its main process is gone (the exit handler hasn't run yet): the
        // exit verdict reports it, once.
        if (entry.leader !== null && !this.processAlive(entry.leader)) continue;
        const kills = this.takeNewKills(entry);
        if (kills > 0) perAgent.push({ agentId, kills });
      }
      return { perAgent, unattributed: this.takeOtherKills() };
    }
    this.collectUnitKills(now);
    let unattributed = 0;
    if (this.pendingUnit.count > 0 && now - this.pendingUnit.since >= cycleMs) {
      unattributed = this.pendingUnit.count;
      this.pendingUnit = { count: 0, since: 0 };
    }
    return { perAgent, unattributed };
  }

  /** This life of the agent is over (it exited, or the server stopped or
   *  deleted it). Its cgroup is removed once empty; anything it left behind
   *  is still watched (as unattributed) until then. */
  release(agentId: string, delayMs = 10_000): void {
    const entry = this.agents.get(agentId);
    this.agents.delete(agentId);
    const dir = entry?.dir;
    if (!dir) return;
    this.otherSeen.set(dir, entry.seenKills);
    const t = setTimeout(() => {
      // Respawned meanwhile: the new life owns the cgroup now.
      for (const e of this.agents.values()) if (e.dir === dir) return;
      try {
        rmdirSync(dir);
        this.otherSeen.delete(dir);
      } catch {
        // EBUSY (lingering processes) or ENOENT: leave it, keep watching.
      }
    }, delayMs);
    t.unref?.();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Move the unit's processes into the server leaf and enable memory+pids
   *  for children. All or nothing: on failure everything is moved back, so a
   *  half-done setup never leaves agents sharing the server's leaf. */
  private delegate(unit: string): void {
    const leaf = join(unit, SERVER_LEAF);
    const available = readFileSync(join(unit, "cgroup.controllers"), "utf-8")
      .split(/\s+/)
      .filter(Boolean);
    if (!available.includes("memory")) {
      throw new Error("the memory controller isn't delegated to the unit");
    }
    mkdirSync(leaf, { recursive: true });
    const want = ["memory", "pids"].filter((c) => available.includes(c));
    let lastErr: unknown;
    // A process forked between reading cgroup.procs and enabling controllers
    // makes the write fail (EBUSY): move again and retry.
    for (let attempt = 0; attempt < DELEGATE_ATTEMPTS; attempt++) {
      this.moveAll(unit, leaf);
      try {
        writeFileSync(
          join(unit, "cgroup.subtree_control"),
          want.map((c) => `+${c}`).join(" "),
        );
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      this.moveAll(leaf, unit);
      try {
        rmdirSync(leaf);
      } catch {
        // not empty: harmless, controllers aren't enabled
      }
      throw lastErr;
    }
    // A previous life's empty agent cgroups (systemd trims the subtree on a
    // clean stop; this covers the rest). Busy ones are watched as leftovers.
    for (const d of readdirSync(unit)) {
      if (!d.startsWith("agent-")) continue;
      try {
        rmdirSync(join(unit, d));
      } catch {
        this.otherSeen.set(join(unit, d), this.readKills(join(unit, d)) ?? 0);
      }
    }
  }

  private moveAll(from: string, to: string): void {
    let procs: string[];
    try {
      procs = readFileSync(join(from, "cgroup.procs"), "utf-8")
        .split("\n")
        .filter(Boolean);
    } catch {
      return;
    }
    for (const p of procs) {
      try {
        writeFileSync(join(to, "cgroup.procs"), p);
      } catch (err) {
        if (!isGone(err)) throw err;
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

  /** Non-isolated: move new unit-level kills into the pending (unclaimed)
   *  pool, stamped with when they were first seen. */
  private collectUnitKills(now = Date.now()): void {
    if (!this.ownServiceDir) return;
    const total = this.readKills(this.ownServiceDir);
    if (total === null) return;
    const fresh = Math.max(0, total - this.unitSeenKills);
    this.unitSeenKills = total;
    if (fresh > 0) {
      if (this.pendingUnit.count === 0) this.pendingUnit.since = now;
      this.pendingUnit.count += fresh;
    }
  }

  /** Isolated: new kills in cgroups no live agent owns. */
  private takeOtherKills(): number {
    let total = 0;
    for (const [dir, seen] of this.otherSeen) {
      const now = this.readKills(dir);
      if (now === null) {
        if (!existsSync(dir)) this.otherSeen.delete(dir);
        continue;
      }
      total += Math.max(0, now - seen);
      this.otherSeen.set(dir, now);
    }
    return total;
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

  /** Alive and not a zombie (a killed process lingers as Z until reaped). */
  private processAlive(pid: number): boolean {
    try {
      const stat = readFileSync(
        join(this.procRoot, String(pid), "stat"),
        "utf-8",
      );
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
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

  /** Once per key: a failure is reported for each agent (and pid) it hits,
   *  never just the first one of the server's life. */
  private warn(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return;
    if (this.warnedKeys.size > 1000) this.warnedKeys.clear();
    this.warnedKeys.add(key);
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
