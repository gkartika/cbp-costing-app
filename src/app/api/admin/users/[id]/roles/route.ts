import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy, ROLES } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

const RolesSchema = z.object({
  roles: z.array(z.enum([ROLES.COSTING_USER, ROLES.COSTING_HEAD, ROLES.SUPER_ADMIN, ROLES.AUDITOR])).min(1),
});

/**
 * Super Admin changes another (or their own) user's role assignment. End-dates
 * any active role not in the new set and adds any new role not already active
 * — same valid_from/valid_to history model as creation, so past assignments
 * stay intact for audit.
 */
export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const actor = await requireUser();
  policy.assertIsSuperAdmin(actor);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = RolesSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Role tidak valid.");
  const nextRoles = body.data.roles;

  // A Super Admin who strips their own super_admin role would lock themselves
  // out with no one left to undo it from the UI.
  if (id === actor.userId && !nextRoles.includes(ROLES.SUPER_ADMIN)) {
    throw Errors.validation("Anda tidak bisa mencabut role Super Admin dari akun sendiri.");
  }

  const userRow = await pool.query<{ user_id: string }>(`SELECT user_id FROM users WHERE user_id = $1`, [id]);
  if (userRow.rows.length === 0) throw Errors.notFound("User");

  const currentRoles = await withTransaction(async (client) => {
    const before = await client.query<{ role_name: string }>(
      `SELECT r.role_name FROM user_roles ur
       JOIN roles r ON r.role_id = ur.role_id
       WHERE ur.user_id = $1 AND ur.valid_to IS NULL`,
      [id],
    );
    const beforeRoles = before.rows.map((r) => r.role_name);

    const toRemove = beforeRoles.filter((r) => !nextRoles.includes(r as (typeof nextRoles)[number]));
    const toAdd = nextRoles.filter((r) => !beforeRoles.includes(r));

    if (toRemove.length > 0) {
      await client.query(
        `UPDATE user_roles SET valid_to = now()
         WHERE user_id = $1 AND valid_to IS NULL
           AND role_id IN (SELECT role_id FROM roles WHERE role_name = ANY($2::text[]))`,
        [id, toRemove],
      );
    }

    if (toAdd.length > 0) {
      const roleRows = await client.query<{ role_id: string }>(`SELECT role_id FROM roles WHERE role_name = ANY($1::text[])`, [toAdd]);
      for (const role of roleRows.rows) {
        await client.query(`INSERT INTO user_roles (user_role_id, user_id, role_id, created_by) VALUES ($1, $2, $3, $4)`, [
          generateId("urole"),
          id,
          role.role_id,
          actor.userId,
        ]);
      }
    }

    await writeAuditEvent(
      {
        action: "USER_ROLE_CHANGED",
        entityType: "users",
        entityId: id,
        actorUserId: actor.userId,
        actorRole: primaryAuditRole(actor),
        requestId,
        beforeJson: { roles: beforeRoles },
        afterJson: { roles: nextRoles },
        reason: "Role changed by Super Admin",
      },
      client,
    );

    return nextRoles;
  });

  return NextResponse.json({ ok: true, roles: currentRoles });
});
