/**
 * Permission modes — how much autonomy a spawned agent has over tool use.
 *
 * Replaces the old coarse `autonomousMode: boolean`. Provider-agnostic: each
 * provider's buildArgs() maps this common enum to its native permission flags.
 * Our value names are OURS — a provider's own vocabulary may differ, and often
 * still uses the word "default" for what we call `ask`:
 *   - Claude Code: `--permission-mode acceptEdits|plan` + the legacy
 *     `--dangerously-skip-permissions` for bypass. `ask` emits NO flag — it is
 *     Claude Code's built-in behavior (see claudePermissionArgs for why passing
 *     `--permission-mode default` explicitly is actively harmful).
 *   - Gemini CLI:  `--approval-mode default|auto_edit|plan|yolo` (its
 *     `default` is our `ask`)
 *   - Codex:       `approval_policy=on-request|on-failure|never` (sandbox is
 *     always `danger-full-access` — autonomOS is the trust boundary, so Codex's
 *     OS sandbox is infra-locked, not a user choice). Codex has no plan mode.
 *
 * See ADR-045. The mapping is intentionally lossy where a provider lacks a mode
 * (Codex `plan`); those gaps are disabled in the UI and clamped + warned at the
 * spawn boundary rather than silently mis-mapped.
 */

import type { Provider } from "./agent";

/**
 * The canonical value list — the ONE place a mode is declared.
 *
 * A literal tuple rather than `PermissionMode[]` so schema definitions can
 * DERIVE from it: `z.enum()` and JSON Schema both need a non-empty tuple. The
 * four values used to be hand-copied into two Zod enums and one JSON Schema
 * with nothing tying the copies together; adding a fifth mode meant finding
 * all four by grep. Now the type itself is derived from this array, so a new
 * entry here propagates everywhere and an omission is a compile error.
 */
export const PERMISSION_MODES = ["ask", "auto", "plan", "bypass"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/**
 * Pre-rename spellings still found in persisted data, mapped to current values.
 *
 * `"default"` was this enum's name for ask-before-acting until the value was
 * renamed to `"ask"`. The old name collided with the ordinary word "default" —
 * the MCP schema literally read "Default: default", and the dashboard had
 * already relabeled the option to "Ask" (PR #265), so the value and its own
 * label disagreed. Renaming the value fixed both.
 *
 * Every persisted layer (agent records, templates, dashboard localStorage) may
 * still hold the old spelling, so all of them normalize on read via
 * `permissionModeFromStored`.
 */
const LEGACY_PERMISSION_MODE_ALIASES: Readonly<Record<string, PermissionMode>> =
  {
    default: "ask",
  };

/**
 * Normalize a persisted permission mode to a current enum value.
 *
 * Returns `undefined` for anything unrecognized — callers decide whether that
 * means "apply the default" or "reject". Deliberately narrower than a
 * passthrough: normalizing at the load boundary keeps exactly ONE spelling
 * alive past it, so no downstream comparison has to check for two.
 */
export function permissionModeFromStored(
  value: unknown,
): PermissionMode | undefined {
  if (isPermissionMode(value)) return value;
  if (typeof value === "string") return LEGACY_PERMISSION_MODE_ALIASES[value];
  return undefined;
}

/**
 * Mode applied when nothing is specified anywhere in the resolution chain.
 *
 * `ask` — prompt before each privileged action (fail-closed). The original
 * ADR-045 cut shipped `bypass` to mirror the old pervasive `?? true`, but that
 * proved fragile: `bypass` emits `--dangerously-skip-permissions`, which the
 * real claude binary refuses in CI / under root, and it silently grants FULL
 * autonomy to any spawn that forgets to set a mode. A safe fallback matters
 * more than mirroring the old autonomy — callers that WANT autonomy ask for it
 * explicitly (`bypass`). Migration of EXISTING records is unchanged: an old
 * `autonomousMode: true` still maps to `bypass` via permissionModeFromLegacy,
 * so already-configured installs keep their prior behavior; only fresh/
 * unspecified spawns get the safe fallback. See ADR-045.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

/**
 * Migration helper (accept-and-discard): legacy `autonomousMode` boolean →
 * `permissionMode`. `true` preserved the skip-permissions behavior (→ bypass);
 * `false` kept prompts on (→ ask). Used at every persisted layer that stored
 * the old boolean.
 */
export function permissionModeFromLegacy(
  autonomousMode: boolean | undefined,
): PermissionMode | undefined {
  if (autonomousMode === undefined) return undefined;
  return autonomousMode ? "bypass" : "ask";
}

/** Human-facing descriptor for one permission mode, including per-provider
 *  behavior. Single source of truth shared by the server (provider mapping
 *  sanity) and the dashboard (the current-selection explainer). */
export interface PermissionModeDescriptor {
  mode: PermissionMode;
  /** Short label for the dropdown (e.g. "Accept edits"). */
  label: string;
  /** One-line summary of the mode, provider-agnostic. */
  summary: string;
  /** Per-provider plain-language behavior, for the explainer popover. */
  perProvider: Record<Provider, string>;
  /** Providers that cannot represent this mode (clamped to `ask`).
   *  Used to disable the option in that provider's UI. */
  unsupportedBy?: readonly Provider[];
}

export const PERMISSION_MODE_INFO: Record<
  PermissionMode,
  PermissionModeDescriptor
> = {
  ask: {
    mode: "ask",
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
      codex: "Not supported — falls back to Ask",
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
