import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { Errors } from "@/lib/errors";

const VoidSchema = z.object({ reason: z.string().min(1).max(1000) });

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const before = await loadCostingHeader(id);
  if (before.status !== "finalized" && before.status !== "revised") {
    throw Errors.validation("Hanya costing yang sudah final dapat dibatalkan.");
  }

  const body = VoidSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Alasan pembatalan wajib diisi.");

  const after = await withTransaction(async (client) => {
    const { rows } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers SET status = 'voided', voided_at = now(), void_reason = $1, updated_at = now()
       WHERE costing_id = $2
       RETURNING *`,
      [body.data.reason, id],
    );
    await writeAuditEvent(
      {
        action: "COSTING_VOIDED",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { status: before.status },
        afterJson: { status: "voided" },
        reason: body.data.reason,
      },
      client,
    );
    return rows[0];
  });

  return NextResponse.json(serializeCosting(after, user.userId));
});
