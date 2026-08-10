/**
 * Agent entity — the canonical durable record for an autonomOS agent.
 *
 * Stored as one JSON file per agent at ~/.autonomos/agents/{id}.json.
 * Identity is durable (id is stable across restarts and process deaths).
 * Hierarchy references use ids, not names — names are display-only and may
 * change freely without affecting structure.
 *
 * Lifecycle: an Agent exists from spawn until permanent removal. Its `status`
 * field tracks whether the underlying PTY is currently running or has exited.
 */

import type { AgentActivityState } from "./api";
import type { PermissionMode } from "./permissions";

export type UUID = string;

export type Provider = "claude-code" | "codex" | "gemini-cli";

/** Lifecycle status. Two values today; future states (archived, detached) are
 *  strictly additive — clients should treat unknown values as "exited". */
export type AgentStatus = "running" | "exited";

/** Why a session stopped, for UI triage. Single source of truth — the
 *  `ExitReason` type and the `isExitReason` validator both derive from this
 *  tuple, so adding a reason can't silently desync a hand-maintained allow-list
 *  (e.g. an API route that validates an incoming `reason` against the union). */
export const EXIT_REASONS = ["user_killed", "self_exited", "crashed"] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

/** Runtime guard for validating untrusted input (e.g. a request body) against
 *  the ExitReason union. Narrows cleanly — no cast at the call site. */
export function isExitReason(value: unknown): value is ExitReason {
  return (EXIT_REASONS as readonly string[]).includes(value as string);
}

export interface Agent {
  /** Schema version for forward-compatible reads. Current: 1. */
  schemaVersion: 1;

  /** Stable primary key. UUIDv4 for new agents; for migrated agents this is
   *  the original `claudeSessionId` to preserve continuity (Option A). */
  id: UUID;

  /** Display name. Mutable, human-facing, never an FK target. */
  name: string;

  /** FK to another Agent.id, or null for root-level agents. */
  managerId: UUID | null;

  /** Optional template the agent was spawned from. */
  template?: string;

  /** Optional project scope (e.g. "autonomOS", "homelab"). */
  project?: string;

  /** Working directory the PTY runs in. */
  workingDirectory: string;

  /** How much autonomy the agent has over tool use. Maps to provider-native
   *  permission flags at spawn. Replaces the old `autonomousMode: boolean`. */
  permissionMode: PermissionMode;

  /** Lifecycle status. */
  status: AgentStatus;

  /** Why the PTY stopped. Only set when status === "exited". */
  exitReason?: ExitReason;

  /** Timestamp the PTY transitioned to exited. Only set when status === "exited". */
  exitedAt?: number;

  /** Provider that backs this agent's PTY. */
  provider: Provider;

  /** Provider-specific session id. For claude-code, this is the CC sessionId
   *  used by --resume. For migrated agents, equals `id`. */
  providerSessionId: string;

  /** True when this record was ADOPTED from an external provider session — one
   *  started outside autonomOS (terminal `claude`) and discovered in the
   *  Projects panel (ADR-056).
   *
   *  Load-bearing, not cosmetic: `providerSessionId` here is the user's real
   *  external session, and it is the ONLY pointer back to their conversation.
   *  The onExit resume safety net regenerates `providerSessionId` on a failed
   *  resume — correct for a managed agent, destructive for this one. The flag
   *  must be PERSISTED rather than inferred at spawn time, because after the
   *  adopting spawn an adopted record is otherwise indistinguishable from a
   *  fresh one (both satisfy id === providerSessionId), so every LATER resume
   *  would re-arm the net and erase the pointer on its first failure. */
  adoptedExternal?: boolean;

  /** Name of the env preset applied to this agent at spawn, or undefined for a
   *  default backend. Persists the preset NAME only — never its env/secret
   *  values (those live in the preset file). Re-applied on resume so an
   *  override survives a restart, following the same "the record is the source
   *  on a body-less resume" rule as `permissionMode`. See ADR-067. */
  envPreset?: string;

  /** Codex only: the app-server thread id (== Codex session id) of this agent's
   *  conversation, captured once the daemon-backed TUI creates its thread. Used
   *  to resume the conversation across a server/daemon restart via
   *  `codex resume <threadId> --remote`. Undefined until captured, or for
   *  providers that don't use the daemon model. */
  providerThreadId?: string;

  /** Most recent PTY-spawn timestamp (initial create or resume). */
  startedAt: number;

  /** Initial creation timestamp. Never changes once set. */
  createdAt: number;

  /** Updated on any mutation. */
  updatedAt: number;

  /** Optimistic-concurrency counter. Mutations bump this by 1. */
  version: number;
}

/**
 * WebSocket delta events streamed from server → dashboard.
 *
 * Six granular events plus `reconcile` (full snapshot, sent on every connect/
 * reconnect). All event names are past-tense single words for consistent
 * client-side switch-case rendering.
 *
 * Forward-compat: client should ignore unknown event types rather than crash.
 */
export type AgentDelta =
  /** New agent appeared (fresh spawn, includes initial PTY attach). */
  | { type: "agent.created"; agent: Agent }
  /** Non-structural field change (name via /rename, future PATCH endpoints). */
  | {
      type: "agent.updated";
      id: UUID;
      patch: Partial<Agent>;
      version: number;
    }
  /** managerId changed via set_manager. Triggers tree restructure on the client. */
  | {
      type: "agent.reparented";
      id: UUID;
      managerId: UUID | null;
      version: number;
    }
  /** Exited agent resumed (status: exited → running). Carries the FULL
   *  refreshed record: a resume can change more than status (permissionMode
   *  and envPreset follow the "explicit param wins" rule, providerSessionId
   *  may regenerate), and a field-list here would silently drop whichever
   *  one the client forgot to apply. */
  | {
      type: "agent.attached";
      id: UUID;
      agent: Agent;
      provider: Provider;
      providerSessionId: string;
      version: number;
    }
  /** PTY died (user_killed / self_exited / crashed). */
  | {
      type: "agent.exited";
      id: UUID;
      exitReason: ExitReason;
      version: number;
    }
  /** Hard delete — file removed. */
  | { type: "agent.deleted"; id: UUID }
  /** ACTIVITY status changed (hook relay / Codex daemon feed) or the unread
   *  notification count moved. Added by the API consolidation's push
   *  migration: this was the ONE thing the delta union didn't model, forcing
   *  the dashboard's highest-frequency poll (3s) for data the server already
   *  had event-shaped at its chokepoint. `state` is the full activity state,
   *  not a patch — idempotent to apply, safe to reorder with reconcile.
   *  `ts` per the ADR-078 WS envelope convention. */
  | {
      type: "agent.status";
      id: string;
      state: AgentActivityState;
      unread: number;
      ts: number;
    }
  /** Full snapshot — sent on connect and reconnect. Client replaces local
   *  state wholesale. Statuses arrive via the companion `statuses` map so a
   *  reconnect needs no follow-up poll. */
  | {
      type: "reconcile";
      agents: Agent[];
      statuses?: Record<string, { state: AgentActivityState; unread: number }>;
    };
