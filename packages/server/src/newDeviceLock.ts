import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * New-device lock for a WEAK operator token (ADR-148).
 *
 * The per-address throttle (ADR-124) bounds the guess RATE, but a rate can't
 * make a short token safe: a 4-digit token falls in days even at 60 guesses an
 * hour, from enough addresses. So for a weak token there is also a CAP: after
 * LIMIT distinct wrong values from addresses that have never signed in, every
 * sign-in attempt from such an address is refused, before evaluation, until
 * the operator unlocks (`autonomos auth unlock`). An attacker's total chance
 * is then LIMIT / keyspace, whatever the time.
 *
 * Never locked out:
 *  - KNOWN addresses: any address a valid credential has come from. An
 *    attacker can't become known without the token. Remembered on disk, so a
 *    restart doesn't turn the operator's devices into strangers.
 *  - loopback: the CLI, a local dashboard, and anything behind a local reverse
 *    proxy (which can't be told apart; ADR-124 names that residual).
 *
 * The count and the lock persist (0600), so restarting the server doesn't hand
 * an attacker a fresh LIMIT. The count never decays: waiting doesn't help.
 * Nothing here ever stores or logs a credential.
 */

export const NEW_DEVICE_FAILURE_LIMIT = 20;
/** The cap, optionally lowered or raised by AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT
 *  (an integer 1..1000). Anything else falls back to the default. */
export function newDeviceFailureLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000
    ? n
    : NEW_DEVICE_FAILURE_LIMIT;
}

/** Bound on remembered addresses (least recently used dropped). */
export const MAX_KNOWN_ADDRESSES = 256;
/** A known address within this many of the newest isn't moved on a hit, so
 *  everyday use (a few devices taking turns) never rewrites the file. */
export const RECENT_KNOWN_WINDOW = 32;

interface Persisted {
  /** Distinct failures from unknown addresses since the last unlock. */
  failures: number;
  /** When the lock engaged (ms), or null when open. */
  lockedAt: number | null;
  /** Addresses a valid credential has come from, most recent last. */
  known: string[];
  /** The last counted failure: where from and when. Shown to the operator
   *  (behind auth) so they can tell a scanner from their own new phone. */
  lastFailure?: { address: string; at: number; login?: string };
  /** The Tailscale login seen with a known address (tailscale serve only):
   *  operator context, never used to decide anything. */
  knownLogins?: Record<string, string>;
}

export type LockState = {
  enabled: boolean;
  locked: boolean;
  failures: number;
  limit: number;
  lockedAt: number | null;
  /** The last counted failure's address and time, or null. */
  lastFailureFrom: string | null;
  lastFailureAt: number | null;
  /** Its Tailscale login, when it came through tailscale serve (ADR-140). */
  lastFailureLogin: string | null;
};

/** Where the lock persists, inside the config dir (0600). */
export function newDeviceLockPath(configDir: string): string {
  return join(configDir, "auth-lock.json");
}

export function isLoopbackAddress(addr: string): boolean {
  return addr === "::1" || addr === "localhost" || /^127\./.test(addr);
}

export class NewDeviceLock {
  private state: Persisted;

  constructor(
    private readonly opts: {
      /** Only a weak token gets a lock: a strong one needs no cap, and the lock
       *  would then be nothing but a denial-of-service lever. */
      enabled: boolean;
      /** Where count, lock and known addresses persist (0600). */
      path: string;
      limit?: number;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    const { state, damaged } = loadStateDetailed(opts.path);
    this.state = state;
    if (damaged && opts.enabled) {
      this.state.lockedAt = (opts.now ?? Date.now)();
      (opts.log ?? console.warn)(
        `[auth] the new-device lock file (${opts.path}) is damaged, so new devices are locked out to be safe. Devices already signed in, and this machine, keep working. Unlock with \`autonomos auth unlock\`.`,
      );
      this.save();
    }
  }

  private get limit(): number {
    return this.opts.limit ?? NEW_DEVICE_FAILURE_LIMIT;
  }

  isKnown(address: string): boolean {
    return isLoopbackAddress(address) || this.state.known.includes(address);
  }

  /** Should this address's credential be refused unevaluated? */
  refuses(address: string): boolean {
    return (
      this.opts.enabled &&
      this.state.lockedAt !== null &&
      !this.isKnown(address)
    );
  }

  /** A credential from this address was valid: remember the address. */
  noteSuccess(address: string, login?: string): void {
    if (isLoopbackAddress(address)) return;
    const logins = this.state.knownLogins ?? {};
    const newLogin = login !== undefined && logins[address] !== login;
    const at = this.state.known.indexOf(address);
    // Keep "most recent last" true, so the cap drops the device least recently
    // used, not the operator's oldest everyday one (nox, #475). A hit among
    // the newest RECENT_KNOWN_WINDOW isn't moved, so everyday use never writes.
    const stale = at >= 0 && at < this.state.known.length - RECENT_KNOWN_WINDOW;
    if (at >= 0 && !stale && !newLogin) return;
    if (stale) this.state.known.splice(at, 1);
    if (at < 0 || stale) this.state.known.push(address);
    if (login !== undefined) logins[address] = login;
    while (this.state.known.length > MAX_KNOWN_ADDRESSES) {
      const dropped = this.state.known.shift();
      if (dropped !== undefined) delete logins[dropped];
    }
    this.state.knownLogins = logins;
    this.save();
  }

  /** A NEW wrong value (not a repeat) came from this address. */
  noteDistinctFailure(address: string, login?: string): void {
    if (!this.opts.enabled || this.isKnown(address)) return;
    if (this.state.lockedAt !== null) return; // already locked: refused anyway
    this.state.failures += 1;
    this.state.lastFailure = {
      address,
      at: (this.opts.now ?? Date.now)(),
      ...(login ? { login } : {}),
    };
    if (this.state.failures >= this.limit) {
      this.state.lockedAt = (this.opts.now ?? Date.now)();
      (this.opts.log ?? console.warn)(
        `[auth] ${this.state.failures} failed sign-ins from devices that have never signed in (the last from ${address}${login ? `, Tailscale user ${login}` : ""}). New devices are now locked out; devices already signed in, and this machine, keep working. Unlock with \`autonomos auth unlock\`.`,
      );
    }
    this.save();
  }

  unlock(): void {
    this.state.failures = 0;
    this.state.lockedAt = null;
    this.state.lastFailure = undefined;
    this.save();
  }

  status(): LockState {
    return {
      enabled: this.opts.enabled,
      locked: this.opts.enabled && this.state.lockedAt !== null,
      failures: this.state.failures,
      limit: this.limit,
      lockedAt: this.state.lockedAt,
      lastFailureFrom: this.state.lastFailure?.address ?? null,
      lastFailureAt: this.state.lastFailure?.at ?? null,
      lastFailureLogin: this.state.lastFailure?.login ?? null,
    };
  }

  private save(): void {
    try {
      saveState(this.opts.path, this.state);
    } catch (err) {
      // The in-memory lock still holds this process; only persistence failed.
      (this.opts.log ?? console.warn)(
        `[auth] couldn't save the new-device lock state: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Read the persisted state. A MISSING file is "open" (a fresh install). A file
 * that exists but can't be read or parsed fails CLOSED: locked, because a
 * damaged file must not hand out a fresh cap (SecurityAudit, #475). The
 * operator unlocks as usual.
 */
export function loadStateDetailed(path: string): {
  state: Persisted;
  damaged: boolean;
} {
  if (!existsSync(path))
    return {
      state: { failures: 0, lockedAt: null, known: [] },
      damaged: false,
    };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Persisted>;
    if (typeof raw !== "object" || raw === null)
      throw new Error("not an object");
    // A field that is PRESENT but the wrong type is damage too: reading it as
    // absent would turn a locked file into an open one (SecurityAudit, #475).
    if (
      "lockedAt" in raw &&
      raw.lockedAt !== null &&
      typeof raw.lockedAt !== "number"
    )
      throw new Error("lockedAt is not a number");
    if ("failures" in raw && !Number.isInteger(raw.failures))
      throw new Error("failures is not an integer");
    return {
      state: {
        failures: Number.isInteger(raw.failures) ? (raw.failures as number) : 0,
        lockedAt: typeof raw.lockedAt === "number" ? raw.lockedAt : null,
        known: Array.isArray(raw.known)
          ? raw.known.filter((a): a is string => typeof a === "string")
          : [],
        lastFailure:
          raw.lastFailure &&
          typeof raw.lastFailure.address === "string" &&
          typeof raw.lastFailure.at === "number"
            ? {
                address: raw.lastFailure.address,
                at: raw.lastFailure.at,
                ...(typeof raw.lastFailure.login === "string"
                  ? { login: raw.lastFailure.login }
                  : {}),
              }
            : undefined,
        knownLogins:
          raw.knownLogins && typeof raw.knownLogins === "object"
            ? Object.fromEntries(
                Object.entries(raw.knownLogins).filter(
                  ([, v]) => typeof v === "string",
                ),
              )
            : undefined,
      },
      damaged: false,
    };
  } catch {
    return {
      state: { failures: 0, lockedAt: 0, known: [] },
      damaged: true,
    };
  }
}

/** The persisted state, damaged → locked (see loadStateDetailed). */
export function loadState(path: string): Persisted {
  return loadStateDetailed(path).state;
}

export function saveState(path: string, state: Persisted): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Clear the lock in the persisted file (the CLI, when the server is down). */
export function unlockOnDisk(path: string): void {
  const s = loadState(path);
  saveState(path, {
    ...s,
    failures: 0,
    lockedAt: null,
    lastFailure: undefined,
  });
}
