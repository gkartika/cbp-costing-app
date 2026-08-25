import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { Errors } from "@/lib/errors";

/**
 * UX-004/UX-019/AUD-009: any reader may duplicate a visible costing into a new
 * Draft they own. Only header inputs are copied — no snapshots, audit history,
 * or identifiers are reused, and the source record is left untouched.
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertCanDuplicateCosting(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers WHERE costing_id = $1`,
    [id],
  );
  if (rows.length === 0) throw Errors.notFound("Costing");
  const source = rows[0];

  const newCosting = await withTransaction(async (client) => {
    const newCostingId = generateId("cst");
    const { rows: inserted } = await client.query<CostingHeaderRow>(
      `INSERT INTO costing_headers
         (costing_id, customer_id, customer_name_snapshot, customer_code_snapshot,
          owner_user_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [newCostingId, source.customer_id, source.customer_name_snapshot, source.customer_code_snapshot, user.userId],
    );

    await writeAuditEvent(
      {
        action: "COSTING_DUPLICATED",
        entityType: "costing_headers",
        entityId: newCostingId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { sourceCostingId: source.costing_id, ownerUserId: user.userId },
      },
      client,
    );

    return inserted[0];
  });

  return NextResponse.json(serializeCosting(newCosting, user.userId), { status: 201 });
});
