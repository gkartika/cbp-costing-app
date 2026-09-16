import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

const DisplayNameSchema = z.object({ displayName: z.string().trim().min(1).max(200) });

/** Super Admin rename of another user's display name (the name shown around the app; login username is unaffected). */
export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const actor = await requireUser();
  policy.assertIsSuperAdmin(actor);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = DisplayNameSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Nama tampilan tidak valid.");

  const { rows } = await pool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE user_id = $1`, [id]);
  if (rows.length === 0) throw Errors.notFound("User");
  const before = rows[0].display_name;

  await pool.query(`UPDATE users SET display_name = $1, updated_at = now() WHERE user_id = $2`, [body.data.displayName, id]);

  await writeAuditEvent({
    action: "USER_DISPLAY_NAME_CHANGED",
    entityType: "users",
    entityId: id,
    actorUserId: actor.userId,
    actorRole: primaryAuditRole(actor),
    requestId,
    beforeJson: { displayName: before },
    afterJson: { displayName: body.data.displayName },
  });

  return NextResponse.json({ ok: true, displayName: body.data.displayName });
});
