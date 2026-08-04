/**
 * Env presets — named, reusable sets of environment variables applied to an
 * agent at spawn time to override its model backend.
 *
 * The motivating case is running Kimi (Moonshot) or any Anthropic-compatible
 * backend through the *real* Claude Code binary: a preset carries
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` (non-secret) plus a secret
 * `ANTHROPIC_AUTH_TOKEN`, and spawning a `claude-code` agent with that preset
 * injects them into only that agent's process. No new provider is needed — the
 * override is entirely env.
 *
 * Presets live at ~/.autonomos/env-presets/{name}.json, mode 0600.
 *
 * ── The credential boundary (ADR-067) ──────────────────────────────────────
 * A preset splits its variables in two:
 *   - `env`        — NON-secret. Returned in plaintext by every read.
 *   - `secretKeys` — the NAMES of secret vars this preset needs (e.g.
 *                    ["ANTHROPIC_AUTH_TOKEN"]). Agent-declared.
 *   - `secrets`    — the secret VALUES. Set only by a human via the dashboard
 *                    UI, and REDACTED on every read boundary (REST GET, MCP
 *                    list). No caller — agent or human — ever reads a secret
 *                    value back once written.
 *
 * The division of labour is deliberate: an autonomOS agent configures a preset
 * end-to-end via MCP (name, endpoint, model, and which secret key is required)
 * but CANNOT set the secret value; the human pastes the API key in the UI.
 * Agents are instructed not to solicit tokens in chat.
 */

import type { Provider } from "./agent";

export interface EnvPreset {
  /** Filename key. lowercase letters, digits, hyphens (SAFE_NAME_RE). */
  name: string;

  /** Human-readable description of what this preset points at. */
  description?: string;

  /** Which base provider this override is meant for (default "claude-code").
   *  Advisory — the injection mechanism is provider-agnostic; this drives
   *  validation hints and the agents-row indicator. */
  provider?: Provider;

  /** Short label for the per-agent indicator in the Agents tab (e.g.
   *  "Kimi K2.7-code"). Falls back to `name` when absent. */
  label?: string;

  /** Non-secret env vars, injected verbatim at spawn. Returned in plaintext. */
  env: Record<string, string>;

  /** Names of the secret env vars this preset requires (e.g.
   *  ["ANTHROPIC_AUTH_TOKEN"]). Agent-declared; the human fills their values. */
  secretKeys: string[];

  /** Secret env var VALUES, keyed by name. Set only via the dashboard UI and
   *  REDACTED on every read boundary — never returned in plaintext. A key in
   *  `secretKeys` with no non-empty value here is "unset" (blocks spawn). */
  secrets: Record<string, string>;

  /** Creation timestamp (ms). */
  createdAt: number;

  /** Last-mutation timestamp (ms). */
  updatedAt: number;
}

/** The placeholder a masked read substitutes for a set secret value. The
 *  redactor (routes/settings.ts style) may append last-4; this is the prefix
 *  clients can rely on to detect "set but hidden". */
export const SECRET_MASK = "••••";
