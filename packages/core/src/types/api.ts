/**
 * REST wire types — the single declaration for shapes that cross the
 * dashboard ↔ server HTTP boundary (consolidation ADR-078).
 *
 * Before this module the dashboard re-declared these by hand (even `Agent`
 * lived as an inline anonymous type in store.ts), so a server-side field
 * rename type-checked clean on both sides while breaking at runtime. Server
 * route handlers and the dashboard api/ client both import from here; a
 * shape change now surfaces as a compile error on whichever side lags.
 *
 * NOT here: the channel-server's types (it must not import @autonomos/core —
 * bundling constraint), and provider-internal shapes that never cross HTTP.
 */

import type { PermissionMode } from "./permissions";
import type { ProviderCapabilities } from "./provider";

// ── Agent activity status (the hooks read surface) ────────────────

/** Live activity state derived from the hook relay (distinct from the Agent
 * RECORD's lifecycle `status` — running/exited). */
export type AgentActivityStatus =
  | "unknown"
  | "ready"
  | "working"
  | "tool_running"
  | "idle"
  | "needs_input"
  | "error"
  | "compacting"
  | "orchestrating"
  | "stopped";

export interface AgentActivityState {
  status: AgentActivityStatus;
  currentTool?: string;
  toolDetail?: string;
  lastEvent: string;
  updatedAt: number;
  /** See routes/hooks.ts compaction handling (ADR-053). */
  preCompactStatus?: AgentActivityStatus;
}

/** `GET /api/hooks` — bulk statuses + unread counts, keyed by agent id. */
export type AgentStatusMap = Record<
  string,
  { status: AgentActivityState; unread: number }
>;

// ── Notifications feed ────────────────────────────────────────────

export interface FeedNotification {
  event: string;
  message?: string;
  timestamp: number;
  read: boolean;
  proactive?: boolean;
  id?: string;
  sessionId: string;
  sessionName: string;
}

/** `GET /api/hooks/notifications` */
export interface NotificationFeed {
  notifications: FeedNotification[];
  totalUnread: number;
}

// ── Agent tree (`GET /api/agents/tree`) ───────────────────────────

export interface AgentTreeNode {
  id: string;
  /** Legacy alias of `id` kept for pre-merger dashboard compatibility. */
  claudeSessionId: string;
  name: string;
  template?: string;
  project?: string;
  status: string;
  provider: string;
  permissionMode: PermissionMode;
  children: AgentTreeNode[];
}

// ── Host / providers / settings ───────────────────────────────────

/** `GET /api/host` (auth-exempt liveness + build identity). */
export interface HostInfo {
  hostname: string;
  dashboard: { build: string | null; builtAt: string | null } | null;
}

/** `GET /api/providers` entry. */
export interface ProviderInfo {
  name: string;
  displayName: string;
  installed: boolean;
  version: string | null;
  recommended: boolean;
  capabilities: ProviderCapabilities;
}

/** `GET /api/settings` — the MASKED projection (never raw credentials). */
export interface MaskedSettings {
  claudeSessionKey: string | null;
  autoDetectClaudeAccount: boolean;
  channels: string[];
  autoTrust: boolean;
  /** Passive release check for the update badge (#323); default on. */
  updateCheck: boolean;
  customEnvVars: Record<string, string>;
  statusLine: { enabled: boolean };
}

export type ChannelStatus = "ok" | "disabled" | "not-installed" | "unknown";

/** `GET /api/channels/status` entry. */
export interface ChannelStatusEntry {
  id: string;
  label: string;
  icon: string;
  status: ChannelStatus;
  /** Actionable command the user can run to reach "ok". */
  fix: string | null;
}

// ── Usage queue (`GET /api/usage-queue`) ──────────────────────────

export interface UsageCapStatus {
  capped: boolean;
  resetsAt: string | null;
  /** Label of the capping window (e.g. "5h", "Sonnet 7d") — ADR-075. */
  window: string | null;
}

export interface UsageQueueSnapshot {
  armed: string[];
  caps: Record<string, UsageCapStatus>;
}

// ── Projects (`GET /api/projects`) ────────────────────────────────

export interface ProjectSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
  firstPrompt?: string;
  /** User-set title via /rename — SDK bug: currently returns undefined. */
  customTitle?: string;
  /** True if this session is managed by autonomOS (has an agent record). */
  isAutonomosAgent?: boolean;
  /** Lifecycle status for autonomOS agents. */
  autonomosStatus?: "running" | "exited";
  /** Template used to spawn this agent. */
  template?: string;
  /** Manager display name in the org chart (resolved from managerId). */
  manager?: string;
  /** Project scope. */
  project?: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  sessions: ProjectSession[];
  lastActive: number;
}
