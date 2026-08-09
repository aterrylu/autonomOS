// DEV/PERF ONLY route — mounted by run.ts only in perf-harness mode
// (AUTONOMOS_PERF=1 AND a loopback bind; see run.ts's perfMode).
// Lets the L2 Playwright harness register synthetic terminal sessions (so the
// REAL dashboard lists + opens them) and fire deterministic Ink-style bursts
// through the REAL terminal WS path, so in-browser render cost can be measured.
// Never mounted in production (env-gated), and writes only to the isolated
// AUTONOMOS_CONFIG_DIR the harness sets.

import type { UUID } from "@autonomos/core";
import { Hono } from "hono";
import {
  _registerSyntheticAttachment,
  getAttachment,
} from "../agents/runtime.js";
import { insertAgent } from "../agents/store.js";
import { FakePty } from "../perf/fake-pty.js";
import { buildBurst, burstBytes, DEFAULT_BURST } from "../perf/ink-burst.js";

const ptys = new Map<string, FakePty>();

export const perfRouter = new Hono();

perfRouter.get("/health", (c) => c.json({ ok: true, sessions: ptys.size }));

function scaledBurst(mb: number | undefined): string[] {
  const totalBytes =
    mb !== undefined && Number.isFinite(mb) && mb > 0
      ? Math.round(mb * 1024 * 1024)
      : DEFAULT_BURST.totalBytes;
  return buildBurst({ ...DEFAULT_BURST, totalBytes });
}

/** Register a synthetic session: store record (so the dashboard lists it) +
 *  attachment backed by a FakePty (so the terminal WS streams from it).
 *  Optional `seedMb` immediately emits a burst BEFORE any client connects —
 *  that fills the server-side scrollback (`outputBuffer`) so the next WS
 *  connect exercises the reconnect-REPLAY path, which is what the
 *  agent-switch benchmark measures. */
perfRouter.post("/session", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    seedMb?: number;
  };
  const id = (body.id ?? "00000000-0000-4000-8000-0000000000ff") as UUID;
  const name = body.name ?? "perf-burst";
  const now = Date.now();

  insertAgent({
    schemaVersion: 1,
    id,
    name,
    managerId: null,
    workingDirectory: "/tmp",
    permissionMode: "ask",
    status: "running",
    provider: "claude-code",
    providerSessionId: id,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });

  // Idempotent: reuse + clear the replay buffer so each measurement run starts
  // from a known state (then re-seed if asked).
  let pty = ptys.get(id);
  if (pty) {
    const existing = getAttachment(id);
    if (existing) {
      existing.outputBuffer.length = 0;
      existing.outputSize = 0;
    }
  } else {
    pty = new FakePty();
    ptys.set(id, pty);
    _registerSyntheticAttachment(id, pty.asIPty());
  }

  let seeded: { chunks: number; bytes: number } | undefined;
  if (body.seedMb !== undefined) {
    const burst = scaledBurst(body.seedMb);
    pty.emitBurst(burst);
    seeded = { chunks: burst.length, bytes: burstBytes(burst) };
  }

  return c.json({ id, name, seeded });
});

/** Fire one burst into the session's PTY. Returns the chunk/byte counts so the
 *  client can assert it received the whole thing. Optional ?mb=N scales the
 *  burst (default ~1MB). */
perfRouter.post("/emit/:id", (c) => {
  const id = c.req.param("id");
  const pty = ptys.get(id);
  if (!pty) return c.json({ error: "session not registered" }, 404);

  // Number(undefined) is NaN, which scaledBurst already rejects.
  const burst = scaledBurst(Number(c.req.query("mb")));
  pty.emitBurst(burst);
  return c.json({ chunks: burst.length, bytes: burstBytes(burst) });
});
