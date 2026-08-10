/**
 * Channel validation — shared between the `/api/channels/status` route
 * and the `/api/settings` PUT guard. Pure so it's unit-testable without
 * spawning subprocesses.
 *
 * Only `server:*` channels exist — autonomOS-owned MCP subprocesses
 * defined inline by the provider. Plugin channels (Telegram/Discord)
 * were removed; stale `plugin:*` entries in older settings.json files
 * are dropped by the getSettings() sanitizer.
 */

export const KNOWN_CHANNELS = [
  {
    id: "server:autonomos",
    label: "autonomOS Gateway",
    icon: "radio-tower",
  },
] as const;

export type KnownChannelId = (typeof KNOWN_CHANNELS)[number]["id"];

/**
 * Mirrors Claude Code's own tag-syntax check — malformed entries
 * cause CC to error at spawn. Validating at save time prevents a
 * config typo from breaking every future session.
 */
export const CHANNEL_ID_RE = /^server:[^:@\s]+$/;

export function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}
