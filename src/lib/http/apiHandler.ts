import { NextRequest, NextResponse } from "next/server";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/http/requestContext";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

/**
 * Wraps a route handler so every thrown error becomes a consistent JSON
 * error response `{ error: { code, message } }` with the right HTTP status,
 * and so unexpected errors are sanitized before reaching the client
 * (10_VALIDATION_RULES: no stack traces or secrets in user-visible output).
 *
 * Also the single place every request is logged from, so a reported problem
 * ("this quote priced wrong at 14:05") can be traced by requestId across the
 * request line, the error line, and the audit_events row, which all carry it.
 */
export function apiHandler(handler: Handler): Handler {
  return async (req, ctx) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const route = { method: req.method, path: req.nextUrl.pathname, requestId };

    try {
      const res = await handler(req, ctx);
      logger.info("request.completed", { ...route, status: res.status, durationMs: Date.now() - startedAt });
      return res;
    } catch (err) {
      const appError = toAppError(err);
      const durationMs = Date.now() - startedAt;

      if (appError.code === "INTERNAL_ERROR") {
        // Unexpected: keep the real message and stack, they are the only
        // record of what actually broke (the client only sees a generic one).
        logger.error("request.failed", {
          ...route,
          status: appError.status,
          durationMs,
          code: appError.code,
          error: appError.message,
          stack: err instanceof Error ? err.stack : undefined,
        });
      } else {
        // Expected rejections (validation, auth, locked costing) are normal
        // operation, not faults — warn so they stay searchable without
        // drowning out real errors.
        logger.warn("request.rejected", { ...route, status: appError.status, durationMs, code: appError.code });
      }

      return NextResponse.json(
        { error: { code: appError.code, message: appError.userMessage } },
        { status: appError.status, headers: { "x-request-id": requestId } },
      );
    }
  };
}
