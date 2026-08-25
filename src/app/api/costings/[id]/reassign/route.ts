import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { Errors } from "@/lib/errors";

const ReassignSchema = z.object({ newOwnerId: z.string().min(1), reason: z.string().min(1).max(1000) });

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const before = await loadCostingHeader(id);

  const body = ReassignSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("new_owner_id dan alasan wajib diisi.");

  const newOwner = await pool.query(`SELECT 1 FROM users WHERE user_id = $1 AND active`, [body.data.newOwnerId]);
  if (newOwner.rows.length === 0) throw Errors.notFound("User");

  const after = await withTransaction(async (client) => {
    const { rows } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers SET owner_user_id = $1, updated_at = now() WHERE costing_id = $2 RETURNING *`,
      [body.data.newOwnerId, id],
    );
    await writeAuditEvent(
      {
        action: "COSTING_REASSIGNED",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { ownerUserId: before.owner_user_id },
        afterJson: { ownerUserId: body.data.newOwnerId },
        reason: body.data.reason,
      },
      client,
    );
    return rows[0];
  });

  return NextResponse.json(serializeCosting(after, user.userId));
});
