import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { pool } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(4).max(200),
});

/** Self-service password change — any logged-in user, given their current password. */
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const requestId = getRequestId(req);

  const body = ChangePasswordSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Password tidak valid.");

  const { rows } = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE user_id = $1`,
    [user.userId],
  );
  if (rows.length === 0) throw Errors.notFound("User");

  const ok = await verifyPassword(rows[0].password_hash, body.data.currentPassword);
  if (!ok) throw Errors.invalidCredentials();

  const passwordHash = await hashPassword(body.data.newPassword);
  await pool.query(
    `UPDATE users SET password_hash = $1, must_reset_password = FALSE, updated_at = now() WHERE user_id = $2`,
    [passwordHash, user.userId],
  );

  await writeAuditEvent({
    action: "USER_PASSWORD_CHANGED",
    entityType: "users",
    entityId: user.userId,
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
    reason: "Self-service password change",
  });

  return NextResponse.json({ ok: true });
});
