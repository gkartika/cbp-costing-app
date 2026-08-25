import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, primaryRoleFromRoles } from "@/lib/http/requestContext";
import { authenticateWithPassword, getActiveRoleNames } from "@/lib/auth/authenticate";
import { createSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";
import { isLoginRateLimited, recordLoginFailure, clearLoginFailures, loginRateLimitKey } from "@/lib/auth/rateLimiter";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const requestId = getRequestId(req);
  const body = LoginSchema.safeParse(await req.json());
  if (!body.success) {
    throw Errors.validation("Username dan password wajib diisi.");
  }
  const { username, password } = body.data;
  const rateLimitKey = loginRateLimitKey(username, clientIp(req));

  if (isLoginRateLimited(rateLimitKey)) {
    await writeAuditEvent({
      action: "LOGIN_RATE_LIMITED",
      entityType: "users",
      entityId: username,
      actorUserId: null,
      actorRole: "anonymous",
      requestId,
    });
    throw Errors.loginRateLimited();
  }

  const user = await authenticateWithPassword(username, password);
  if (!user) {
    recordLoginFailure(rateLimitKey);
    await writeAuditEvent({
      action: "LOGIN_FAILED",
      entityType: "users",
      entityId: username,
      actorUserId: null,
      actorRole: "anonymous",
      requestId,
    });
    throw Errors.invalidCredentials();
  }
  clearLoginFailures(rateLimitKey);
  if (!user.active) {
    const inactiveUserRoles = await getActiveRoleNames(user.userId);
    await writeAuditEvent({
      action: "LOGIN_BLOCKED_INACTIVE",
      entityType: "users",
      entityId: user.userId,
      actorUserId: user.userId,
      actorRole: primaryRoleFromRoles(inactiveUserRoles),
      requestId,
    });
    throw Errors.accountInactive();
  }

  const { token, expiresAt } = await createSession(user.userId);
  const roles = await getActiveRoleNames(user.userId);
  await writeAuditEvent({
    action: "LOGIN_SUCCEEDED",
    entityType: "users",
    entityId: user.userId,
    actorUserId: user.userId,
    actorRole: primaryRoleFromRoles(roles),
    requestId,
  });

  const res = NextResponse.json({
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    mustResetPassword: user.mustResetPassword,
  });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return res;
});
