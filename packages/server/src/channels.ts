/**
 * Channel validation + status derivation — shared between the
 * `/api/channels/status` route and the `/api/settings` PUT guard.
 * Pure so it's unit-testable without spawning subprocesses.
 */

export const KNOWN_CHANNELS = [
  {
    id: "server:autonomos",
    label: "autonomOS Gateway",
    icon: "radio-tower",
  },
  {
    id: "plugin:telegram@claude-plugins-official",
    label: "Telegram",
    icon: "send",
  },
  {
    id: "plugin:discord@claude-plugins-official",
    label: "Discord",
    icon: "comment-discussion",
  },
] as const;

export type KnownChannelId = (typeof KNOWN_CHANNELS)[number]["id"];

/**
 * Mirrors Claude Code's own tag-syntax check — malformed entries
 * cause CC to error at spawn ("--channels entries must be tagged").
 * Validating at save time prevents a config typo from breaking every
 * future session.
 */
export const CHANNEL_ID_RE = /^(plugin:[^@:\s]+@[^@:\s]+|server:[^:@\s]+)$/;

export function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}

export type ChannelStatus = "ok" | "disabled" | "not-installed" | "unknown";

export interface InstalledPlugin {
  id: string;
  enabled: boolean;
}

/**
 * `server:*` channels short-circuit to "ok" — they are autonomOS-owned
 * MCP subprocesses defined inline by the provider, not plugins that
 * `claude plugin list` would ever report. `installed === null` means
 * detection failed; caller should fall back to permissive behavior.
 */
export function channelStatus(
  channelId: string,
  installed: InstalledPlugin[] | null,
): ChannelStatus {
  // server:* short-circuits ahead of the null check — its state is
  // independent of `claude plugin list` output, so a detection failure
  // shouldn't make the gateway look broken.
  if (channelId.startsWith("server:")) return "ok";
  if (installed === null) return "unknown";
  const pluginId = channelId.replace(/^plugin:/, "");
  const match = installed.find((p) => p.id === pluginId);
  if (!match) return "not-installed";
  if (!match.enabled) return "disabled";
  return "ok";
}
