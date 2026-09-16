import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { nextQuotationNumber, revisionSuffix } from "@/lib/costings/quotationNumber";
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
           AND s.price_kind = COALESCE(cl.chosen_price_kind, 'PRODUCTION')
       )`,
    [costingId],
  );
  return Number(rows[0].stale_count) > 0;
}

/**
 * A line with both a Production and a Trading snapshot needs the owner to
 * have picked one (costing_lines.chosen_price_kind) before Finalize can lock
 * in a single price — a line with only one kind never needs a pick (Calculate
 * All already resolves that case automatically).
 */
async function hasAnyUnresolvedPriceKind(costingId: string): Promise<boolean> {
  const { rows } = await pool.query<{ unresolved_count: string }>(
    `SELECT COUNT(*) AS unresolved_count
     FROM costing_lines cl
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL AND cl.chosen_price_kind IS NULL
       AND EXISTS (SELECT 1 FROM line_calculation_snapshots s WHERE s.costing_line_id = cl.costing_line_id AND s.price_kind = 'TRADING')`,
    [costingId],
  );
  return Number(rows[0].unresolved_count) > 0;
}

/**
 * Walks parent_costing_id up to the root (revision_no = 0) header and
 * returns its quotation_no — the base number a revision's own number is
 * suffixed onto, so nested revisions never stack suffixes onto suffixes.
 */
type ParentLookupRow = { quotation_no: string | null; parent_costing_id: string | null };

async function rootQuotationNo(parentCostingId: string): Promise<string | null> {
  let currentId: string | null = parentCostingId;
  let quotationNo: string | null = null;
  while (currentId) {
    const queryResult: { rows: ParentLookupRow[] } = await pool.query<ParentLookupRow>(
      `SELECT quotation_no, parent_costing_id FROM costing_headers WHERE costing_id = $1`,
      [currentId],
    );
    if (queryResult.rows.length === 0) break;
    quotationNo = queryResult.rows[0].quotation_no;
    currentId = queryResult.rows[0].parent_costing_id;
  }
  return quotationNo;
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
  if (await hasAnyUnresolvedPriceKind(id)) {
    throw Errors.priceKindRequired();
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
         AND s.price_kind = COALESCE(cl.chosen_price_kind, 'PRODUCTION')
       ORDER BY s.costing_line_id, s.created_at DESC`,
      [id],
    );

    let quotationNo: string;
    if (before.parent_costing_id) {
      const baseNo = await rootQuotationNo(before.parent_costing_id);
      if (!baseNo) throw Errors.validation("Quotation asal untuk revisi ini tidak ditemukan.");
      quotationNo = `${baseNo}-${revisionSuffix(before.revision_no)}`;
    } else {
      const now = new Date();
      quotationNo = await nextQuotationNumber(client, now.getFullYear(), now.getMonth() + 1);
    }

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
