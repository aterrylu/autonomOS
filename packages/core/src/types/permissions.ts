/**
 * Permission modes — how much autonomy a spawned agent has over tool use.
 *
 * Replaces the old coarse `autonomousMode: boolean`. Provider-agnostic: each
 * provider's buildArgs() maps this common enum to its native permission flags:
 *   - Claude Code: `--permission-mode default|acceptEdits|plan` + the legacy
 *     `--dangerously-skip-permissions` for bypass
 *   - Gemini CLI:  `--approval-mode default|auto_edit|plan|yolo`
 *   - Codex:       `approval_policy=on-request|on-failure|never` (sandbox is
 *     always `danger-full-access` — autonomOS is the trust boundary, so Codex's
 *     OS sandbox is infra-locked, not a user choice). Codex has no plan mode.
 *
 * See ADR-045. The mapping is intentionally lossy where a provider lacks a mode
 * (Codex `plan`); those gaps are disabled in the UI and clamped + warned at the
 * spawn boundary rather than silently mis-mapped.
 */

import type { Provider } from "./agent";

export type PermissionMode = "default" | "auto" | "plan" | "bypass";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "auto",
  "plan",
  "bypass",
] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/**
 * Default mode when nothing is specified anywhere in the resolution chain.
 *
 * `default` — ask before each privileged action (fail-closed). The original
 * ADR-045 cut shipped `bypass` to mirror the old pervasive `?? true`, but that
 * proved fragile: `bypass` emits `--dangerously-skip-permissions`, which the
 * real claude binary refuses in CI / under root, and it silently grants FULL
 * autonomy to any spawn that forgets to set a mode. A safe default matters more
 * than mirroring the old autonomy — callers that WANT autonomy ask for it
 * explicitly (`bypass`). Migration of EXISTING records is unchanged: an old
 * `autonomousMode: true` still maps to `bypass` via permissionModeFromLegacy,
 * so already-configured installs keep their prior behavior; only fresh/
 * unspecified spawns get the safe default. See ADR-045.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/**
 * Migration helper (accept-and-discard): legacy `autonomousMode` boolean →
 * `permissionMode`. `true` preserved the skip-permissions behavior (→ bypass);
 * `false` kept prompts on (→ default). Used at every persisted layer that
 * stored the old boolean.
 */
export function permissionModeFromLegacy(
  autonomousMode: boolean | undefined,
): PermissionMode | undefined {
  if (autonomousMode === undefined) return undefined;
  return autonomousMode ? "bypass" : "default";
}

/** Human-facing descriptor for one permission mode, including per-provider
 *  behavior. Single source of truth shared by the server (provider mapping
 *  sanity) and the dashboard (the current-selection explainer). */
export interface PermissionModeDescriptor {
  mode: PermissionMode;
  /** Short label for the dropdown (e.g. "Auto-edit"). */
  label: string;
  /** One-line summary of the mode, provider-agnostic. */
  summary: string;
  /** Per-provider plain-language behavior, for the explainer popover. */
  perProvider: Record<Provider, string>;
  /** Providers that cannot represent this mode (clamped to `default`).
   *  Used to disable the option in that provider's UI. */
  unsupportedBy?: readonly Provider[];
}

export const PERMISSION_MODE_INFO: Record<
  PermissionMode,
  PermissionModeDescriptor
> = {
  default: {
    mode: "default",
    label: "Ask",
    summary: "Agent asks for approval before each privileged action.",
    perProvider: {
      "claude-code": "Prompts on each tool use",
      "gemini-cli": "Prompts on each tool use",
      codex: "Asks on request (approval_policy: on-request)",
    },
  },
  auto: {
    mode: "auto",
    label: "Accept edits",
    summary:
      "Auto-approves file edits; still gates riskier actions where the provider can.",
    perProvider: {
      "claude-code": "Auto-accepts edits (acceptEdits)",
      "gemini-cli": "Auto-accepts edits (auto_edit)",
      codex: "Runs commands, asks only on failure (on-failure)",
    },
  },
  plan: {
    mode: "plan",
    label: "Plan",
    summary: "Read-only investigation — the agent plans but does not act.",
    perProvider: {
      "claude-code": "Read-only plan mode",
      "gemini-cli": "Read-only plan mode",
      codex: "Not supported — falls back to Default",
    },
    unsupportedBy: ["codex"],
  },
  bypass: {
    mode: "bypass",
    label: "Bypass",
    summary: "Skips all permission prompts. Full autonomy.",
    perProvider: {
      "claude-code": "Skips all prompts (--dangerously-skip-permissions)",
      "gemini-cli": "Auto-approves everything (yolo)",
      codex: "No approvals (approval_policy: never)",
    },
  },
};
