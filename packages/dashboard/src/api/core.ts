/**
 * API client core — the single seam between the dashboard and the server.
 *
 * Every REST call goes through {@link request} (consolidation ADR-078; the
 * audit found 45 raw `fetch()` sites with six coexisting error idioms, four
 * cancellation mechanisms, and no in-flight dedup). What this centralizes:
 *
 * - ERRORS: one shape. Non-2xx responses become a typed {@link ApiError}
 *   carrying the server envelope's `code`/`retryable`/`details` when present
 *   (agents routes emit it today; the rest converge in the validation slice).
 *   Queries surface it as state; mutations throw it — callers never invent a
 *   third idiom.
 * - DEDUP: concurrent GETs of the same URL share one in-flight promise, so a
 *   poll tick racing a user action can't land two responses out of order.
 * - CANCELLATION: an `AbortSignal` is accepted everywhere. On a DEDUPED GET
 *   it detaches the caller (dropped result) without aborting the fetch other
 *   callers share; on a non-deduped request (`fresh` or any mutation) it
 *   aborts the actual socket — a timed-out liveness probe must not leak
 *   connections into the browser's per-host cap.
 * - BASE URL / AUTH: relative paths against the page origin; auth rides the
 *   same-origin `autonomos_token` httpOnly cookie set by /auth. This module
 *   is deliberately the ONLY place a future cross-origin deployment (PWA
 *   thin-client) would add a base URL + Authorization header.
 */

/** Typed transport/HTTP failure for every API call. */
export class ApiError extends Error {
  /** HTTP status; 0 = network failure (server unreachable / CORS / abort). */
  readonly status: number;
  /** Stable machine code from the server envelope, when it sent one. */
  readonly code?: string;
  /** Server's own retry hint, when it sent one. */
  readonly retryable?: boolean;
  /** Envelope extras (e.g. currentVersion on a 409). */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    opts: {
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.details = opts.details;
  }

  /** True when the server was never reached (vs. answered with an error). */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialized as the body; sets Content-Type. */
  body?: unknown;
  /** Detaches THIS caller. A deduped in-flight GET keeps running for others. */
  signal?: AbortSignal;
  /** Bypass the GET dedup + ask intermediaries not to cache (the old
   * `cache: "no-store"` sites: post-save validation reads). */
  fresh?: boolean;
}

/** In-flight GET dedup: URL → the shared promise. Entries self-clear on
 * settle, so the window is exactly the request's own lifetime. */
const inflightGets = new Map<string, Promise<unknown>>();

async function execute<T>(path: string, opts: RequestOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      ...(opts.body !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts.body),
      }),
      ...(opts.fresh && { cache: "no-store" as const }),
      // Forwarded ONLY for non-deduped requests (request() strips it before a
      // shared GET): with no siblings awaiting the response, an abort must
      // kill the actual socket. Otherwise a timed-out liveness probe leaks a
      // connection per tick until the browser's per-host cap wedges every
      // later request behind the dead ones.
      ...(opts.signal && { signal: opts.signal }),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    throw new ApiError(
      aborted
        ? "Aborted"
        : err instanceof Error
          ? err.message
          : "Network request failed",
      0,
      aborted ? { code: "ABORTED" } : {},
    );
  }

  // Parse the body once. Non-JSON on an ERROR status is tolerated (dev-mode
  // plaintext 404s — the status carries the signal); a non-empty 2xx body
  // that isn't JSON (broken proxy, captive portal serving HTML with a 200)
  // must THROW, not resolve null: a null resolution reads as "empty data" at
  // most call sites, silently masking a real outage. Truly empty 2xx bodies
  // (e.g. /auth, markRead) still resolve null.
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok) {
        throw new ApiError(
          `Non-JSON response body on ${opts.method ?? "GET"} ${path}`,
          res.status,
          { code: "BAD_BODY" },
        );
      }
      body = null;
    }
  }

  if (!res.ok) {
    const env = (body ?? {}) as {
      error?: string;
      code?: string;
      retryable?: boolean;
      [k: string]: unknown;
    };
    const { error, code, retryable, ...rest } = env;
    throw new ApiError(
      typeof error === "string" && error
        ? error
        : `HTTP ${res.status} on ${opts.method ?? "GET"} ${path}`,
      res.status,
      {
        code: typeof code === "string" ? code : undefined,
        retryable: typeof retryable === "boolean" ? retryable : undefined,
        ...(Object.keys(rest).length > 0 && {
          details: rest as Record<string, unknown>,
        }),
      },
    );
  }

  return body as T;
}

/**
 * Perform an API request. Throws {@link ApiError} on any failure; resolves
 * with the parsed JSON body (typed by the caller's `T`).
 */
export function request<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";

  // Dedup plain GETs. The shared promise ignores per-caller signals — a
  // caller's abort must not cancel a response its siblings are awaiting — so
  // abort handling happens in the race below instead.
  let core: Promise<T>;
  if (method === "GET" && !opts.fresh) {
    const existing = inflightGets.get(path) as Promise<T> | undefined;
    if (existing) {
      core = existing;
    } else {
      core = execute<T>(path, { ...opts, signal: undefined });
      inflightGets.set(path, core as Promise<unknown>);
      core.finally(() => inflightGets.delete(path)).catch(() => {});
    }
  } else {
    core = execute<T>(path, opts);
  }

  const signal = opts.signal;
  if (!signal) return core;
  if (signal.aborted) {
    return Promise.reject(new ApiError("Aborted", 0, { code: "ABORTED" }));
  }
  // Non-deduped requests forwarded the signal into fetch itself — the abort
  // rejects out of execute() as a status-0 ApiError; normalize its code so
  // isAbort() holds for both paths.

  // Detach on abort: reject THIS caller, leave the shared fetch running.
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new ApiError("Aborted", 0, { code: "ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
    core.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** True for an ApiError whose cause was this caller's own AbortSignal —
 * callers use it to silently drop post-unmount results. */
export function isAbort(err: unknown): boolean {
  return err instanceof ApiError && err.code === "ABORTED";
}
