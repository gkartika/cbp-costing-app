import { NextRequest, NextResponse } from "next/server";
import { toAppError } from "@/lib/errors";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

/**
 * Wraps a route handler so every thrown error becomes a consistent JSON
 * error response `{ error: { code, message } }` with the right HTTP status,
 * and so unexpected errors are sanitized before reaching the client
 * (10_VALIDATION_RULES: no stack traces or secrets in user-visible output).
 */
export function apiHandler(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const appError = toAppError(err);
      if (appError.code === "INTERNAL_ERROR") {
        console.error(`[api] ${req.method} ${req.nextUrl.pathname}:`, appError.message);
      }
      return NextResponse.json(
        { error: { code: appError.code, message: appError.userMessage } },
        { status: appError.status },
      );
    }
  };
}
