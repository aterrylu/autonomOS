/**
 * Typed HTTP errors + the central handler (consolidation PR B, ADR-078 §errors).
 *
 * One envelope everywhere: `{ error, code?, retryable?, details? }`. Routes
 * THROW an HttpError (or a domain error the handler knows) instead of
 * hand-crafting `c.json({ error }, 4xx)` — the handler is the single place
 * that shapes a failure response, so a client can rely on the envelope no
 * matter which route failed.
 *
 * Deliberate exceptions (per the typed-errors convention): routes holding
 * in-flight state that must be flushed before the response (e.g. the agents
 * DELETE handler's pendingDeltas) still catch locally; router-level onError
 * (agents.ts) keeps its more specific logging and simply predates this
 * app-level net — Hono runs the nearest handler, so both compose.
 */

import type { Context, Env, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { CachePoisonedError } from "./agents/store.js";
import { ControlPlaneNotReadyError } from "./serverState.js";

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    message: string,
    opts: {
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.details = opts.details;
  }
}

export const badRequest = (
  message: string,
  opts?: { code?: string; details?: Record<string, unknown> },
): HttpError => new HttpError(400, message, { code: "BAD_REQUEST", ...opts });

export const notFound = (
  message: string,
  opts?: { code?: string; details?: Record<string, unknown> },
): HttpError => new HttpError(404, message, { code: "NOT_FOUND", ...opts });

export const conflict = (
  message: string,
  opts?: { code?: string; details?: Record<string, unknown> },
): HttpError => new HttpError(409, message, { code: "CONFLICT", ...opts });

/**
 * Envelope for one error. Exported because a router with its OWN onError
 * (agents.ts) is the nearest handler and never reaches the app-level one — it
 * has to be able to emit the same envelope rather than dropping an HttpError
 * into its generic 500 branch.
 */
export function httpErrorResponse<E extends Env>(
  c: Context<E>,
  err: HttpError,
): Response {
  return c.json(
    {
      error: err.message,
      ...(err.code && { code: err.code }),
      ...(err.retryable !== undefined && { retryable: err.retryable }),
      ...(err.details && { details: err.details }),
    },
    err.status,
  );
}

/**
 * Install the app-level onError + notFound pair. Called for BOTH listeners
 * (public TCP and the internal control socket) — an error envelope must not
 * depend on which surface a request arrived through.
 */
export function installErrorHandling<E extends Env>(
  app: Hono<E>,
  scope: string,
): void {
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      // 4xx are the caller's problem — no stack noise; 5xx get logged.
      if (err.status >= 500) {
        console.error(
          `[${scope}] ${err.code ?? err.name} on ${c.req.method} ${c.req.path}: ${err.message}`,
        );
      }
      return httpErrorResponse(c, err);
    }
    // A ZodError that escaped a route (parseBody throws HttpError, so this
    // is a schema used directly) still becomes a structured 400.
    if (err instanceof ZodError) {
      return httpErrorResponse(
        c,
        new HttpError(400, "Invalid request body", {
          code: "VALIDATION",
          details: { issues: err.issues },
        }),
      );
    }
    // Domain errors the whole server shares (see agents.ts for the richer
    // per-router variants of these two).
    if (err instanceof ControlPlaneNotReadyError) {
      return c.json(
        { error: err.message, code: err.code, retryable: true },
        503,
        { "Retry-After": "1" },
      );
    }
    if (err instanceof CachePoisonedError) {
      return c.json(
        { error: err.message, code: err.code, retryable: false },
        503,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${scope}] unhandled ${err instanceof Error ? err.name : "error"} on ${c.req.method} ${c.req.path}: ${message}`,
      err instanceof Error ? err.stack : undefined,
    );
    return c.json({ error: message }, 500);
  });

  app.notFound((c) =>
    c.json(
      {
        error: `No route for ${c.req.method} ${c.req.path}`,
        code: "NOT_FOUND",
      },
      404,
    ),
  );
}
