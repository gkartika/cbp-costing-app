import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import type { CostingLineRow } from "@/lib/costings/lines";
import { Errors } from "@/lib/errors";

/**
 * UX-004/UX-019/AUD-009: any reader may duplicate a visible costing into a new
 * Draft they own. Header inputs and line items are copied — but not
 * snapshots, audit history, or identifiers, and the source record is left
 * untouched. The new costing has no prices until Calculate All runs, exactly
 * like a costing built by hand.
 */
export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertCanDuplicateCosting(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers WHERE costing_id = $1 AND deleted_at IS NULL`,
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

    // Copy every line (including a set's components), but nothing priced:
    // no snapshots, no trading_quote_id (that quote belongs to the source
    // line), so the duplicate must go through Calculate All like any new
    // costing (UX-019). Ordered by line_no so a set's own row — which always
    // sorts before its components (they share the costing's line_no
    // sequence) — is inserted, and its new id known, before its components
    // need to reference it.
    const { rows: sourceLines } = await client.query<CostingLineRow>(
      `SELECT * FROM costing_lines WHERE costing_id = $1 AND deleted_at IS NULL ORDER BY line_no`,
      [id],
    );
    const oldToNewLineId = new Map<string, string>();
    for (const line of sourceLines) {
      const newLineId = generateId("line");
      oldToNewLineId.set(line.costing_line_id, newLineId);
      const newParentLineId = line.parent_line_id ? oldToNewLineId.get(line.parent_line_id) ?? null : null;

      await client.query(
        `INSERT INTO costing_lines
           (costing_line_id, costing_id, line_no, line_kind, parent_line_id, qty_per_set, route,
            product_family, description, grade_input, size_label, diameter_mm, length_mm,
            developed_cut_length_mm, qty, lead_time_days, coating_code, dies_option, dies_total_cost,
            weight_tolerance_percent, margin_percent, trading_item_id, thread_condition,
            discount_type, discount_value, pitch_type, pitch_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                 $20, $21, $22, $23, $24, $25, $26, $27)`,
        [
          newLineId,
          newCostingId,
          line.line_no,
          line.line_kind,
          newParentLineId,
          line.qty_per_set,
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
        action: "COSTING_DUPLICATED",
        entityType: "costing_headers",
        entityId: newCostingId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { sourceCostingId: source.costing_id, ownerUserId: user.userId, lineCount: sourceLines.length },
      },
      client,
    );

    return inserted[0];
  });

  return NextResponse.json(serializeCosting(newCosting, user.userId), { status: 201 });
});
