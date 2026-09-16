import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import type { CostingLineRow } from "@/lib/costings/lines";
import { Errors } from "@/lib/errors";

/**
 * UX-017/AUD-006: only the owner of a Finalized/Revised costing may open a
 * new editable revision. Inputs are copied; snapshots and audit history are
 * not — the new revision must be recalculated and refinalized independently.
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const source = await loadCostingHeader(id);
  if (source.owner_user_id !== user.userId) throw Errors.costingReadOnly();
  if (source.status !== "finalized" && source.status !== "revised") {
    throw Errors.validation("Hanya costing yang sudah final dapat direvisi.");
  }

  const newHeader = await withTransaction(async (client) => {
    await client.query(`UPDATE costing_headers SET status = 'revised', updated_at = now() WHERE costing_id = $1`, [id]);

    const newCostingId = generateId("cst");
    const { rows } = await client.query<CostingHeaderRow>(
      `INSERT INTO costing_headers
         (costing_id, customer_id, customer_name_snapshot, customer_code_snapshot, owner_user_id,
          revision_no, parent_costing_id, currency, tax_output_mode, validity_days, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        newCostingId,
        source.customer_id,
        source.customer_name_snapshot,
        source.customer_code_snapshot,
        source.owner_user_id,
        source.revision_no + 1,
        source.costing_id,
        source.currency,
        source.tax_output_mode,
        source.validity_days,
        user.userId,
      ],
    );

    const { rows: sourceLines } = await client.query<CostingLineRow>(
      `SELECT * FROM costing_lines WHERE costing_id = $1 AND deleted_at IS NULL ORDER BY line_no`,
      [id],
    );
    for (const line of sourceLines) {
      await client.query(
        `INSERT INTO costing_lines
           (costing_line_id, costing_id, line_no, route, product_family, description, grade_input,
            size_label, diameter_mm, length_mm, developed_cut_length_mm, qty, lead_time_days, coating_code,
            dies_option, dies_total_cost, weight_tolerance_percent, margin_percent, trading_item_id, thread_condition,
            discount_type, discount_value, pitch_type, pitch_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 $21, $22, $23, $24)`,
        [
          generateId("line"),
          newCostingId,
          line.line_no,
          line.route,
          line.product_family,
          line.description,
          line.grade_input,
          line.size_label,
          line.diameter_mm,
          line.length_mm,
          line.developed_cut_length_mm,
          line.qty,
          line.lead_time_days,
          line.coating_code,
          line.dies_option,
          line.dies_total_cost,
          line.weight_tolerance_percent,
          line.margin_percent,
          line.trading_item_id,
          line.thread_condition,
          line.discount_type,
          line.discount_value,
          line.pitch_type,
          line.pitch_value,
        ],
      );
    }

    await writeAuditEvent(
      {
        action: "COSTING_REVISION_CREATED",
        entityType: "costing_headers",
        entityId: newCostingId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { sourceCostingId: id, revisionNo: source.revision_no + 1, lineCount: sourceLines.length },
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCosting(newHeader, user.userId), { status: 201 });
});
