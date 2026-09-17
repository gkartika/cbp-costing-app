import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { Errors } from "@/lib/errors";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";

/** Idempotency/trace correlation id for one request (09_API_CONTRACTS). Uses the client-supplied header when present so retries with the same key are traceable. */
export function getRequestId(req: NextRequest): string {
  return req.headers.get("x-request-id") ?? randomUUID();
}

/** Loads the authenticated user for this request or throws AUTH_REQUIRED. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw Errors.authRequired();
  return user;
}

/** The role recorded on audit events reflects the user's role at the time of the action (AUD-015 note). Super Admin outranks Auditor outranks Costing Head outranks Costing User when a user holds more than one. */
export function primaryRoleFromRoles(roles: string[]): string {
  if (roles.includes("super_admin")) return "super_admin";
  if (roles.includes("auditor")) return "auditor";
  if (roles.includes("costing_head")) return "costing_head";
  if (roles.includes("costing_user")) return "costing_user";
  return "unknown";
}

export function primaryAuditRole(user: SessionUser): string {
  return primaryRoleFromRoles(user.roles);
}
