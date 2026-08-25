import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { nextQuotationNumber } from "@/lib/costings/quotationNumber";
import { Errors } from "@/lib/errors";

const FinalizeSchema = z.object({ expectedUpdatedAt: z.string() });

/**
 * VAL-021: every active line must have a snapshot no older than the line's
 * last edit. A line changed after Calculate but before Finalize invalidates
 * the whole finalization, not just that one line.
 */
async function hasAnyStaleLine(costingId: string): Promise<boolean> {
  const { rows } = await pool.query<{ stale_count: string }>(
    `SELECT COUNT(*) AS stale_count
     FROM costing_lines cl
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM line_calculation_snapshots s
         WHERE s.costing_line_id = cl.costing_line_id AND s.created_at >= cl.updated_at
       )`,
    [costingId],
  );
  return Number(rows[0].stale_count) > 0;
}

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const before = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: before.owner_user_id, status: before.status });

  const body = FinalizeSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data tidak valid.");
  if (new Date(body.data.expectedUpdatedAt).getTime() !== before.updated_at.getTime()) {
    throw Errors.staleUpdate();
  }

  if (before.status !== "calculated") {
    throw Errors.recalculationRequired();
  }
  if (await hasAnyStaleLine(id)) {
    throw Errors.recalculationRequired();
  }
  // Customer isn't required to start a Draft, but a finalized quotation must
  // show who it's for (field dictionary: "required" fields need only be set
  // before the state transition that depends on them, not at creation).
  if (!before.customer_name_snapshot.trim()) {
    throw Errors.validation("Pilih customer sebelum finalisasi.");
  }

  const after = await withTransaction(async (client) => {
    const snapshotIds = await client.query<{ snapshot_id: string; costing_line_id: string }>(
      `SELECT DISTINCT ON (s.costing_line_id) s.snapshot_id, s.costing_line_id
       FROM line_calculation_snapshots s
       JOIN costing_lines cl ON cl.costing_line_id = s.costing_line_id
       WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
       ORDER BY s.costing_line_id, s.created_at DESC`,
      [id],
    );

    const quotationNo = await nextQuotationNumber(client, new Date().getFullYear());

    const { rows, rowCount } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers
         SET status = 'finalized', quotation_no = $1, finalized_at = now(), updated_at = now()
       WHERE costing_id = $2 AND updated_at = $3
       RETURNING *`,
      [quotationNo, id, before.updated_at],
    );
    if (rowCount === 0) throw Errors.staleUpdate();

    await writeAuditEvent(
      {
        action: "COSTING_FINALIZED",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { status: before.status },
        afterJson: { status: "finalized", quotationNo, snapshotIds: snapshotIds.rows.map((r) => r.snapshot_id) },
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCosting(after, user.userId));
});
