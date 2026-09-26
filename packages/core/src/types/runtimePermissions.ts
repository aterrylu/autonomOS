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
