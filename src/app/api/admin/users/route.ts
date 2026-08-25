import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy, ROLES } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { hashPassword } from "@/lib/auth/password";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { Errors } from "@/lib/errors";

const CreateUserSchema = z.object({
  username: z.string().min(3).max(64),
  displayName: z.string().min(1).max(200),
  roles: z.array(z.enum([ROLES.COSTING_USER, ROLES.SUPER_ADMIN, ROLES.AUDITOR])).min(1),
});

export const GET = apiHandler(async () => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);

  const { rows } = await pool.query<{
    user_id: string;
    username: string;
    display_name: string;
    active: boolean;
    roles: string[] | null;
  }>(
    `SELECT u.user_id, u.username, u.display_name, u.active,
            array_remove(array_agg(r.role_name), NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.valid_to IS NULL
     LEFT JOIN roles r ON r.role_id = ur.role_id
     GROUP BY u.user_id
     ORDER BY u.username`,
  );
  return NextResponse.json({
    users: rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      active: r.active,
      roles: r.roles ?? [],
    })),
  });
});

export const POST = apiHandler(async (req: NextRequest) => {
  const actor = await requireUser();
  policy.assertIsSuperAdmin(actor);
  const requestId = getRequestId(req);

  const body = CreateUserSchema.safeParse(await req.json());
  if (!body.success) {
    throw Errors.validation("Data user tidak valid.");
  }
  const { username, displayName, roles } = body.data;

  const tempPassword = randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(tempPassword);
  const userId = generateId("usr");

  await withTransaction(async (client) => {
    const existing = await client.query("SELECT 1 FROM users WHERE username = $1", [username]);
    if (existing.rows.length > 0) {
      throw Errors.validation("Username sudah digunakan.");
    }

    await client.query(
      `INSERT INTO users (user_id, username, password_hash, display_name, must_reset_password, created_by)
       VALUES ($1, $2, $3, $4, TRUE, $5)`,
      [userId, username, passwordHash, displayName, actor.userId],
    );

    const roleRows = await client.query<{ role_id: string; role_name: string }>(
      `SELECT role_id, role_name FROM roles WHERE role_name = ANY($1::text[])`,
      [roles],
    );
    for (const role of roleRows.rows) {
      await client.query(
        `INSERT INTO user_roles (user_role_id, user_id, role_id, created_by) VALUES ($1, $2, $3, $4)`,
        [generateId("urole"), userId, role.role_id, actor.userId],
      );
    }

    await writeAuditEvent(
      {
        action: "USER_ROLE_CHANGED",
        entityType: "users",
        entityId: userId,
        actorUserId: actor.userId,
        actorRole: primaryAuditRole(actor),
        requestId,
        afterJson: { username, displayName, roles },
        reason: "User created by Super Admin",
      },
      client,
    );
  });

  return NextResponse.json(
    { userId, username, displayName, roles, temporaryPassword: tempPassword },
    { status: 201 },
  );
});
