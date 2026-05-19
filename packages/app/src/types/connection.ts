/**
 * A `Connection` represents a single autonomos-server daemon the desktop
 * knows how to connect to. May be:
 *
 *   - `local`: a server installed on THIS machine via Phase 1C's
 *     `autonomos install-service` (LaunchAgent on macOS, systemd-user on
 *     Linux). The local Connection is *synthesized* at runtime from
 *     `~/.autonomos/server-state.json` and is NOT stored in the JSON
 *     config (see ADR-028).
 *
 *   - `remote`: a server installed on a different machine (forge, VPS,
 *     LAN host). Stored in the JSON config as part of `AppConfig.connections`.
 *
 * Tokens are NEVER persisted in plaintext alongside the rest of the
 * Connection. They live in a separate file encrypted via Electron's
 * `safeStorage` (Keychain on macOS, libsecret on Linux, DPAPI on Windows).
 * See `main/config/tokens.ts`.
 */
export interface Connection {
  /** Stable identifier. The string "local" is reserved for the synthesized
   *  local-machine connection. Remote connections use cryptographic randomness
   *  (e.g. `crypto.randomUUID()`). */
  id: string;

  /** Display name shown in the sidebar. For local: "Local Mac" or similar.
   *  For remote: user-provided at connection-add time, or derived from the
   *  hostname if the user didn't supply one. */
  name: string;

  /** `local` is special-cased in many paths (uses launchd state file,
   *  cannot be removed by the user, restart-server menu item is enabled).
   *  `remote` is everything else. */
  type: "local" | "remote";

  /** Base URL of the autonomos-server. Includes scheme, host, port.
   *  Examples: "http://127.0.0.1:5050", "https://forge.terrylu.cloud:7421".
   *  Must NOT include a trailing slash. */
  url: string;

  /** ISO timestamp of the last successful connection. Used for sorting
   *  recent connections. Optional because freshly-added connections haven't
   *  connected yet. */
  lastConnectedAt?: string;
}

/** A Connection without the `id`. Used for the "add a new connection" flow
 *  where the desktop assigns the id. */
export type ConnectionInput = Omit<Connection, "id" | "lastConnectedAt">;

/** Reserved Connection id for the synthesized local-machine connection. */
export const LOCAL_CONNECTION_ID = "local" as const;
