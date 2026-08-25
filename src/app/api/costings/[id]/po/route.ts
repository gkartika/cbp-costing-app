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

const MarkPoSchema = z.object({
  isPo: z.boolean(),
  /** Required when marking; ignored when clearing. */
  poNumber: z.string().trim().min(1).max(100).optional(),
});

/**
 * Marks whether an issued quotation converted into a purchase order.
 *
 * Its own route rather than a field on PATCH /costings/[id] because the rules
 * differ in a way that matters: PATCH requires the costing to be unlocked and
 * takes an optimistic-lock token, whereas a PO can only arrive *after*
 * finalization — exactly when the costing is locked. Folding it into PATCH
 * would have made the flag unsettable in the only state it is ever used.
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = MarkPoSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Status PO tidak valid.");

  const before = await loadCostingHeader(id);
  policy.assertCanMarkPo(user, { ownerUserId: before.owner_user_id, status: before.status });

  const isPo = body.data.isPo;
  const poNumber = body.data.poNumber?.trim() ?? null;

  // The customer's PO number is the confirmation step: requiring a real
  // document reference is what stops a stray click on the checkbox from
  // recording a win that never happened.
  if (isPo && !poNumber) throw Errors.poNumberRequired();

  if (isPo === before.is_po && (!isPo || poNumber === before.po_number)) {
    return NextResponse.json(serializeCosting(before, user.userId));
  }

  const after = await withTransaction(async (client) => {
    const { rows } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers
         SET is_po = $1,
             po_number = CASE WHEN $1 THEN $2::text ELSE NULL END,
             po_marked_at = CASE WHEN $1 THEN now() ELSE NULL END,
             po_marked_by = CASE WHEN $1 THEN $3::text ELSE NULL END
       WHERE costing_id = $4
       RETURNING *`,
      [isPo, poNumber, user.userId, id],
    );

    // Deliberately does not touch updated_at: marking a PO is commercial
    // tracking, not a calculation input, so it must not flip a Calculated
    // costing back to "needs recalculation".
    await writeAuditEvent(
      {
        action: isPo ? "COSTING_MARKED_PO" : "COSTING_UNMARKED_PO",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { isPo: before.is_po, poNumber: before.po_number },
        afterJson: { isPo, poNumber: isPo ? poNumber : null },
        changedFields: ["isPo", "poNumber"],
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCosting(after, user.userId));
});
