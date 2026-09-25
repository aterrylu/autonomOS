/**
 * Each runtime's permission options, in the runtime's OWN vocabulary.
 *
 * The single source for the per-runtime permission redesign (Terry, 2026-09-25):
 * every user-facing label is the canonical value the CLI itself accepts and
 * reports — no invented names — and each value's description is the CLI's own
 * wording (help text / schema), noted in `source`.
 *
 * PR 1 of the redesign: the table and the drift probe that checks it against
 * the INSTALLED CLI (server/runtimeProbe.ts). Nothing spawns from it yet; the
 * shared ask|auto|plan|bypass vocabulary (permissions.ts) still drives argv.
 *
 * `verifiedOn` records the CLI version each axis was last checked against by
 * hand. The runtime probe re-checks the installed version on every server start.
 */

import type { Provider } from "./agent";

export interface RuntimePermissionValue {
  /** The canonical value, exactly as the CLI accepts it. Also the label. */
  value: string;
  /** What it does, in the CLI's own words where the CLI documents it. */
  description: string;
  /** A behavior the user should know before picking it. */
  caveat?: string;
}

export interface RuntimePermissionAxis {
  /** The CLI's own name for the setting (flag or config key). */
  key: string;
  /** How autonomOS applies it — for docs and the drift probe. */
  via: string;
  /** Where the descriptions come from. */
  source: string;
  values: readonly RuntimePermissionValue[];
  /** EXPERIMENTAL in the CLI itself. */
  experimental?: boolean;
  /**
   * How the drift probe checks this axis against the installed CLI, without
   * starting a session: `parse-time` — an invalid value fails argv parsing
   * with the list of allowed choices; `config-load` — Codex's config loader
   * lists the allowed variants and loads (or rejects) each value we use;
   * `schema` — Codex's offline app-server schema lists the enum.
   */
  probe: "parse-time" | "config-load" | "schema";
  /**
   * Values the CLI still accepts that are deliberately NOT offered, and why —
   * so the drift probe doesn't report them as new.
   */
  notOffered?: readonly { value: string; why: string }[];
}

/** What the drift probe found for one axis of the installed CLI. */
export interface RuntimeAxisCheck {
  key: string;
  /** Values the installed CLI accepts, or null if they couldn't be read. */
  accepted: string[] | null;
  /** Table values the installed CLI no longer accepts. */
  rejected: string[];
  /** Values the installed CLI accepts that the table doesn't list yet. */
  unlisted: string[];
}

/** The drift probe's verdict for one installed runtime. */
export interface RuntimePermissionCheck {
  version: string | null;
  checkedAt: string;
  /** The installed version differs from the version the table was verified on. */
  versionChanged: boolean;
  axes: RuntimeAxisCheck[];
  /** Set when the probe itself failed (binary missing, timeout, …). */
  error?: string;
}

export interface RuntimePermissions {
  runtime: Provider;
  verifiedOn: string;
  axes: readonly RuntimePermissionAxis[];
}

export const RUNTIME_PERMISSIONS: Readonly<
  Record<Provider, RuntimePermissions>
> = {
  "claude-code": {
    runtime: "claude-code",
    verifiedOn: "2.1.282",
    axes: [
      {
        key: "permission-mode",
        via: "--permission-mode <value> (bypassPermissions: --dangerously-skip-permissions)",
        source:
          "Claude Code --help choices; descriptions from Claude Code's permission-mode docs",
        probe: "parse-time",
        values: [
          {
            value: "manual",
            description:
              "Standard behavior: prompts for permission on first use of each tool.",
          },
          {
            value: "acceptEdits",
            description: "Automatically accepts file edits for the session.",
          },
          {
            value: "auto",
            description: "A classifier approves or blocks each tool call.",
            caveat:
              "Falls back to manual when auto mode isn't available for your plan or model.",
          },
          {
            value: "dontAsk",
            description:
              "Denies anything that would prompt; only tools pre-approved by your permission rules run.",
            caveat:
              "Never prompts, so work that needs approval is refused rather than asked about.",
          },
          {
            value: "plan",
            description: "Can analyze but not modify files or run commands.",
          },
          {
            value: "bypassPermissions",
            description: "Skips all permission prompts.",
          },
        ],
      },
    ],
  },
  codex: {
    runtime: "codex",
    verifiedOn: "0.154.0",
    axes: [
      {
        key: "approval_policy",
        via: "-c approval_policy=<value> (daemon) / -a <value> (TUI)",
        source: "codex --help (--ask-for-approval)",
        probe: "config-load",
        notOffered: [
          {
            value: "on-failure",
            why: "removed; still loads but is silently coerced to on-request (0.154)",
          },
          {
            value: "untrusted",
            why: 'removed; the config loader rejects it ("no longer supported")',
          },
          {
            value: "granular",
            why: "a per-category object, not a single value",
          },
        ],
        values: [
          {
            value: "on-request",
            description: "The model decides when to ask the user for approval.",
          },
          {
            value: "never",
            description:
              "Never ask for user approval; execution failures are immediately returned to the model.",
          },
        ],
      },
      {
        key: "sandbox_mode",
        via: "-c sandbox_mode=<value> / -s <value>",
        source:
          "codex --help (--sandbox): the sandbox policy for model-generated shell commands",
        probe: "config-load",
        values: [
          {
            value: "read-only",
            description: "Model-generated commands can read but not write.",
          },
          {
            value: "workspace-write",
            description:
              "Model-generated commands can write inside the workspace.",
          },
          {
            value: "danger-full-access",
            description: "Model-generated commands run with no sandbox.",
          },
        ],
      },
      {
        key: "approvals_reviewer",
        via: "-c approvals_reviewer=<value>",
        source:
          "codex app-server schema (ApprovalsReviewer): who approval requests are routed to for review",
        probe: "config-load",
        values: [
          { value: "user", description: "Approval requests come to you." },
          {
            value: "auto_review",
            description: "Approval requests go through automatic review.",
          },
          {
            value: "guardian_subagent",
            description: "Approval requests go to a guardian subagent.",
          },
        ],
      },
      {
        key: "collaboration_mode",
        via: "app-server thread/settings/update { collaborationMode } (not a launch setting)",
        source: "codex app-server schema (ModeKind)",
        probe: "schema",
        experimental: true,
        values: [
          {
            value: "default",
            description: "Codex's default collaboration mode.",
          },
          { value: "plan", description: "Codex's Plan collaboration mode." },
        ],
      },
    ],
  },
  "gemini-cli": {
    runtime: "gemini-cli",
    verifiedOn: "0.46.0",
    axes: [
      {
        key: "approval-mode",
        via: "--approval-mode <value>",
        source: "gemini --help (--approval-mode)",
        probe: "parse-time",
        values: [
          { value: "default", description: "Prompt for approval." },
          { value: "auto_edit", description: "Auto-approve edit tools." },
          { value: "plan", description: "Read-only mode." },
          { value: "yolo", description: "Auto-approve all tools." },
        ],
      },
    ],
  },
};

// ── An agent's permission setting, in its runtime's vocabulary ─────────────

/**
 * One agent's permission setting: a canonical value for EVERY axis of its
 * runtime (e.g. Codex: approval_policy, sandbox_mode, approvals_reviewer,
 * collaboration_mode). Always complete — `completePermission` fills any axis a
 * caller didn't name from the runtime's effective default.
 */
export interface RuntimePermission {
  runtime: Provider;
  values: Readonly<Record<string, string>>;
}

/**
 * What each runtime runs when nobody chose anything: exactly today's `ask`
 * behavior (ADR-115: migration keeps every agent's effective behavior).
 */
export const DEFAULT_RUNTIME_VALUES: Readonly<
  Record<Provider, Readonly<Record<string, string>>>
> = {
  "claude-code": { "permission-mode": "manual" },
  codex: {
    approval_policy: "on-request",
    sandbox_mode: "danger-full-access",
    approvals_reviewer: "user",
    collaboration_mode: "default",
  },
  "gemini-cli": { "approval-mode": "default" },
};

/** Every runtime with a permission table, in display order. */
export const PERMISSION_RUNTIMES: readonly Provider[] = [
  "claude-code",
  "codex",
  "gemini-cli",
];

/** Same runtime and the same value on every axis. */
export function samePermission(
  a: RuntimePermission,
  b: RuntimePermission,
): boolean {
  if (a.runtime !== b.runtime) return false;
  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
  for (const k of keys) if (a.values[k] !== b.values[k]) return false;
  return true;
}

/** Fill every axis the partial doesn't name from the runtime's default. */
export function completePermission(
  runtime: Provider,
  partial: Readonly<Record<string, string>> = {},
): RuntimePermission {
  return {
    runtime,
    // `?? {}`: a record can name a runtime this build no longer has a table
    // for (a removed provider, a test fake) — it gets no axes, never a crash.
    values: { ...(DEFAULT_RUNTIME_VALUES[runtime] ?? {}), ...partial },
  };
}

/** The runtime's default setting (see DEFAULT_RUNTIME_VALUES). */
export function defaultRuntimePermission(runtime: Provider): RuntimePermission {
  return completePermission(runtime);
}

/**
 * The shared-vocabulary mode an agent record carried before ADR-115, mapped to
 * the native setting it ACTUALLY ran — never a wider or narrower one. Codex
 * never supported `auto`/`plan`: both always ran as on-request.
 */
export function permissionFromLegacyMode(
  runtime: Provider,
  mode: "ask" | "auto" | "plan" | "bypass",
): RuntimePermission {
  const byRuntime: Record<
    Provider,
    Record<typeof mode, Record<string, string>>
  > = {
    "claude-code": {
      ask: { "permission-mode": "manual" },
      auto: { "permission-mode": "acceptEdits" },
      plan: { "permission-mode": "plan" },
      bypass: { "permission-mode": "bypassPermissions" },
    },
    codex: {
      ask: {},
      auto: {},
      plan: {},
      bypass: { approval_policy: "never" },
    },
    "gemini-cli": {
      ask: { "approval-mode": "default" },
      auto: { "approval-mode": "auto_edit" },
      plan: { "approval-mode": "plan" },
      bypass: { "approval-mode": "yolo" },
    },
  };
  return completePermission(runtime, byRuntime[runtime]?.[mode] ?? {});
}

/** A legacy mode that had no exact native equivalent on this runtime. */
export function legacyModeWasClamped(
  runtime: Provider,
  mode: "ask" | "auto" | "plan" | "bypass",
): boolean {
  return runtime === "codex" && (mode === "auto" || mode === "plan");
}

/**
 * The closest shared-vocabulary mode for a native setting — ONLY for readers
 * that haven't moved to `permission` yet (the dashboard until the redesign's
 * UI PR). Lossy by nature; never used to spawn.
 */
export function legacyModeFor(
  p: RuntimePermission,
): "ask" | "auto" | "plan" | "bypass" {
  const v = p.values;
  switch (p.runtime) {
    case "claude-code":
      return v["permission-mode"] === "bypassPermissions"
        ? "bypass"
        : v["permission-mode"] === "acceptEdits"
          ? "auto"
          : v["permission-mode"] === "plan"
            ? "plan"
            : "ask";
    case "codex":
      return v.approval_policy === "never" ? "bypass" : "ask";
    case "gemini-cli":
      return v["approval-mode"] === "yolo"
        ? "bypass"
        : v["approval-mode"] === "auto_edit"
          ? "auto"
          : v["approval-mode"] === "plan"
            ? "plan"
            : "ask";
    default:
      return "ask"; // no table for this runtime (see completePermission)
  }
}

/**
 * The canonical display string: the CLI's own values, nothing invented.
 * Single-axis runtimes show the bare value (`acceptEdits`, `yolo`); Codex shows
 * `key=value` pairs, omitting axes still at Codex's own default where that
 * default is unambiguous (reviewer `user`, collaboration mode `default`).
 */
export function formatPermission(p: RuntimePermission): string {
  const axes = RUNTIME_PERMISSIONS[p.runtime]?.axes ?? [];
  if (axes.length === 1) return p.values[axes[0].key] ?? "";
  const quiet: Record<string, string> = {
    approvals_reviewer: "user",
    collaboration_mode: "default",
  };
  return axes
    .filter(
      (a) => p.values[a.key] !== undefined && quiet[a.key] !== p.values[a.key],
    )
    .map((a) => `${a.key}=${p.values[a.key]}`)
    .join(" · ");
}

export type PermissionParseResult =
  | { ok: true; permission: RuntimePermission }
  | { ok: false; error: string };

/**
 * Parse a runtime's canonical value as an API caller gives it:
 * - single-axis runtimes: the bare value (`"acceptEdits"`, `"yolo"`);
 * - any runtime: `"key=value key=value"` (Codex's own `-c` spelling; spaces,
 *   commas or " · " between pairs) or an object `{ key: value }`.
 * Unnamed axes keep the runtime default. The error lists the valid values.
 */
export function parseRuntimePermission(
  runtime: Provider,
  input: string | Readonly<Record<string, unknown>>,
): PermissionParseResult {
  const axes = RUNTIME_PERMISSIONS[runtime].axes;
  let pairs: Record<string, string> = {};
  if (typeof input === "string") {
    const s = input.trim();
    if (!s.includes("=")) {
      if (axes.length !== 1)
        return { ok: false, error: validValuesMessage(runtime) };
      pairs = { [axes[0].key]: s };
    } else {
      for (const part of s.split(/\s*(?:·|,|\s)\s*/).filter(Boolean)) {
        const eq = part.indexOf("=");
        if (eq <= 0) return { ok: false, error: validValuesMessage(runtime) };
        pairs[part.slice(0, eq)] = part.slice(eq + 1);
      }
    }
  } else {
    for (const [k, v] of Object.entries(input)) {
      if (typeof v !== "string")
        return { ok: false, error: validValuesMessage(runtime) };
      pairs[k] = v;
    }
  }
  for (const [key, value] of Object.entries(pairs)) {
    const axis = axes.find((a) => a.key === key);
    if (!axis || !axis.values.some((v) => v.value === value)) {
      return { ok: false, error: validValuesMessage(runtime) };
    }
  }
  return { ok: true, permission: completePermission(runtime, pairs) };
}

/** "Valid permission values for codex: approval_policy=on-request|never; …" */
export function validValuesMessage(runtime: Provider): string {
  const axes = RUNTIME_PERMISSIONS[runtime].axes;
  const list = axes
    .map(
      (a) =>
        (axes.length === 1 ? "" : `${a.key}=`) +
        a.values.map((v) => v.value).join("|"),
    )
    .join("; ");
  return `Valid permission values for ${runtime}: ${list}`;
}

/**
 * A permission read back from disk, if it's still well-formed for `runtime`:
 * the right runtime, and every value still in the table. Missing axes are
 * filled from the default. Undefined means "rebuild it" (from the legacy mode).
 */
export function normalizeStoredPermission(
  runtime: Provider,
  raw: unknown,
): RuntimePermission | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { runtime?: unknown; values?: unknown };
  if (r.runtime !== runtime || !r.values || typeof r.values !== "object")
    return undefined;
  const parsed = parseRuntimePermission(
    runtime,
    r.values as Record<string, unknown>,
  );
  return parsed.ok ? parsed.permission : undefined;
}
