import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

const ResetPasswordSchema = z.object({ password: z.string().min(4).max(200) });

/**
 * Super Admin reset of another user's password — same 4-character floor and
 * hashing as account creation (src/app/api/admin/users/route.ts). Always
 * forces a reset at next login: unlike creation, the admin picking a value
 * here is a recovery action ("they're locked out"), not handing over a
 * password the user chose to keep.
 */
export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const actor = await requireUser();
  policy.assertIsSuperAdmin(actor);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = ResetPasswordSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Password tidak valid.");

  const { rows } = await pool.query<{ user_id: string; username: string }>(
    `SELECT user_id, username FROM users WHERE user_id = $1`,
    [id],
  );
  if (rows.length === 0) throw Errors.notFound("User");

  const passwordHash = await hashPassword(body.data.password);
  await pool.query(
    `UPDATE users SET password_hash = $1, must_reset_password = TRUE, updated_at = now() WHERE user_id = $2`,
    [passwordHash, id],
  );

  await writeAuditEvent({
    action: "USER_PASSWORD_RESET",
    entityType: "users",
    entityId: id,
    actorUserId: actor.userId,
    actorRole: primaryAuditRole(actor),
    requestId,
    reason: "Password reset by Super Admin",
  });

  return NextResponse.json({ ok: true });
});
