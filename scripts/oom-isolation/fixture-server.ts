// A stand-in for the autonomOS server, run as the ExecStart of the REAL
// rendered unit by scripts/oom-isolation-ci.sh. It does exactly what the
// runtime does for OOM containment, with the real module (OomGuard: init at
// boot, attach after each agent spawn, exitVerdict on an agent's exit), and
// spawns two fake agents:
//   agent-a  allocates until the unit's memory cap is hit (the runaway build)
//   agent-b  idles (a sibling that must survive)
// The server holds MORE memory than agent-a reaches before the OOM, so without
// the guard the kernel's natural pick is the server (measured on systemd 255).
//
// Env: OOM_FIXTURE_OUT (result dir), OOM_FIXTURE_GUARD=off (variant C),
//      OOM_FIXTURE_SERVER_MB (default 350).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OomGuard } from "../../packages/server/src/agents/oomGuard.ts";

const out = process.env.OOM_FIXTURE_OUT ?? "/tmp";
const guardOn = process.env.OOM_FIXTURE_GUARD !== "off";
const serverMb = Number(process.env.OOM_FIXTURE_SERVER_MB ?? 350);
const log = (m: string) => console.error(`[fixture] ${m}`);

const guard = new OomGuard({ log });
if (guardOn) guard.init();
log(`guard=${guardOn ? "on" : "off"} isolated=${guard.isolated}`);

// Resident, not just reserved: Buffer.alloc(n, 1) writes every page.
const hold = Buffer.alloc(serverMb * 1024 * 1024, 1);

const agentB = spawn("sleep", ["600"], { stdio: "ignore" });
if (guardOn) guard.attach("agent-b", agentB.pid);

const agentA = spawn(
  process.execPath,
  [
    "-e",
    // 32 MB per step, every page written, held: a build that keeps growing.
    "const k=[];setInterval(()=>{k.push(Buffer.alloc(32*1024*1024,1))},100)",
  ],
  { stdio: "ignore" },
);
if (guardOn) guard.attach("agent-a", agentA.pid);

writeFileSync(
  join(out, "pids.json"),
  JSON.stringify({
    server: process.pid,
    agentA: agentA.pid,
    agentB: agentB.pid,
    // What the boot notice keys on (runtime.ts oomBootNotices), read under
    // the real unit: true only for a unit without the template's marker.
    predatesIsolation: guard.unitPredatesIsolation,
  }),
);

// Heartbeat: proves the server process is the SAME one, still running.
setInterval(() => {
  writeFileSync(join(out, "heartbeat"), `${process.pid} ${Date.now()} ${hold.length}`);
}, 250);

agentA.on("exit", (code, signal) => {
  const sig = signal === "SIGKILL" ? 9 : undefined;
  const verdict = guardOn ? guard.exitVerdict("agent-a", sig) : null;
  setTimeout(() => {
    writeFileSync(
      join(out, "result.json"),
      JSON.stringify({
        serverPid: process.pid,
        agentA: { code, signal, verdict },
        agentBAlive: agentB.exitCode === null && agentB.signalCode === null,
      }),
    );
    log(`agent-a exited code=${code} signal=${signal} verdict=${verdict}`);
  }, 1_000);
});
