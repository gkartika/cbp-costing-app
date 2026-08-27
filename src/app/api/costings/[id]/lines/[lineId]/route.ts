import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCostingLine, type CostingLineRow } from "@/lib/costings/lines";
import { Errors } from "@/lib/errors";

async function loadLine(costingId: string, lineId: string): Promise<CostingLineRow> {
  const { rows } = await pool.query<CostingLineRow>(
    `SELECT * FROM costing_lines WHERE costing_id = $1 AND costing_line_id = $2 AND deleted_at IS NULL`,
    [costingId, lineId],
  );
  if (rows.length === 0) throw Errors.notFound("Line");
  return rows[0];
}

// Calculation-input fields are nullable-and-optional: omitting a key leaves
// the stored value untouched, but an explicit `null` clears it. This matters
// beyond cosmetics — a leftover developedCutLengthMm on a Stud/Anchor line
// would silently reroute the calculation to the Anchor formula, so the UI
// must be able to actually clear a field, not just overwrite it.
const PatchLineSchema = z.object({
  expectedUpdatedAt: z.string(),
  /** Components only — how many of this part go into one set (DEC-017). */
  qtyPerSet: z.number().int().min(1).optional(),
  route: z.enum(["TRADING", "CUSTOM"]).nullable().optional(),
  productFamily: z.string().min(1).max(100).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  gradeInput: z.string().max(100).nullable().optional(),
  threadCondition: z.string().max(20).nullable().optional(),
  sizeLabel: z.string().max(50).nullable().optional(),
  diameterMm: z.number().positive().nullable().optional(),
  lengthMm: z.number().positive().nullable().optional(),
  developedCutLengthMm: z.number().positive().nullable().optional(),
  qty: z.number().int().min(1).nullable().optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
  coatingCode: z.string().max(50).nullable().optional(),
  diesOption: z.enum(["yes", "no_lookup", "manual"]).nullable().optional(),
  diesTotalCost: z.number().min(0).nullable().optional(),
  weightTolerancePercent: z.number().min(0).max(1).nullable().optional(),
  marginPercent: z.number().min(0).max(0.999999).nullable().optional(),
  tradingItemId: z.string().nullable().optional(),
});

const EDITABLE_COLUMNS: Record<string, string> = {
  qtyPerSet: "qty_per_set",
  route: "route",
  productFamily: "product_family",
  description: "description",
  gradeInput: "grade_input",
  threadCondition: "thread_condition",
  sizeLabel: "size_label",
  diameterMm: "diameter_mm",
  lengthMm: "length_mm",
  developedCutLengthMm: "developed_cut_length_mm",
  qty: "qty",
  leadTimeDays: "lead_time_days",
  coatingCode: "coating_code",
  diesOption: "dies_option",
  diesTotalCost: "dies_total_cost",
  weightTolerancePercent: "weight_tolerance_percent",
  marginPercent: "margin_percent",
  tradingItemId: "trading_item_id",
};

export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id, lineId } = await ctx.params;

  const header = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: header.owner_user_id, status: header.status });

  const body = PatchLineSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data item tidak valid.");

  const before = await loadLine(id, lineId);
  if (new Date(body.data.expectedUpdatedAt).getTime() !== before.updated_at.getTime()) {
    throw Errors.staleUpdate();
  }
  if ("qtyPerSet" in body.data && before.line_kind !== "component") {
    throw Errors.validation("Jumlah per set hanya berlaku untuk komponen.");
  }

  const changedFields: string[] = [];
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(EDITABLE_COLUMNS)) {
    if (!(key in body.data)) continue;
    const value = (body.data as Record<string, unknown>)[key];
    changedFields.push(key);
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json(serializeCostingLine(before, false));
  }

  const after = await withTransaction(async (client) => {
    values.push(lineId, before.updated_at);
    const { rows, rowCount } = await client.query<CostingLineRow>(
      `UPDATE costing_lines SET ${setClauses.join(", ")}, updated_at = now()
       WHERE costing_line_id = $${values.length - 1} AND updated_at = $${values.length}
       RETURNING *`,
      values,
    );
    if (rowCount === 0) throw Errors.staleUpdate();

    // A set's price is derived from its components, so changing one makes the
    // set's own snapshot stale. Staleness is judged by `snapshot.created_at >=
    // line.updated_at`, which only looks at the line itself — without touching
    // the parent here, an edited component would leave the set line looking
    // current and finalize would issue a quotation at the old set price.
    if (before.parent_line_id) {
      await client.query(`UPDATE costing_lines SET updated_at = now() WHERE costing_line_id = $1`, [
        before.parent_line_id,
      ]);
    }

    // Any calculation-input change invalidates a prior Calculated status (AT-STATE-001).
    if (header.status === "calculated") {
      await client.query(`UPDATE costing_headers SET status = 'draft', updated_at = now() WHERE costing_id = $1`, [id]);
    }

    await writeAuditEvent(
      {
        action: "LINE_UPDATED",
        entityType: "costing_lines",
        entityId: lineId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: Object.fromEntries(changedFields.map((f) => [f, (before as unknown as Record<string, unknown>)[EDITABLE_COLUMNS[f]]])),
        afterJson: Object.fromEntries(changedFields.map((f) => [f, (body.data as Record<string, unknown>)[f]])),
        changedFields,
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCostingLine(after, false));
});

const DeleteLineSchema = z.object({ reason: z.string().max(500).optional() });

export const DELETE = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id, lineId } = await ctx.params;

  const header = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: header.owner_user_id, status: header.status });

  const body = DeleteLineSchema.safeParse(await req.json().catch(() => ({})));
  const reason = body.success ? body.data.reason : undefined;

  const before = await loadLine(id, lineId);

  await withTransaction(async (client) => {
    await client.query(`UPDATE costing_lines SET deleted_at = now(), updated_at = now() WHERE costing_line_id = $1`, [
      lineId,
    ]);

    // Deleting a set takes its components with it. They are only reachable
    // through their parent, so leaving them behind would strand rows that no
    // screen shows but every "does this costing have unpriced lines" check
    // still counts.
    if (before.line_kind === "set") {
      await client.query(
        `UPDATE costing_lines SET deleted_at = now(), updated_at = now()
         WHERE parent_line_id = $1 AND deleted_at IS NULL`,
        [lineId],
      );
    }
    // Removing a component changes the set price above it (see PATCH).
    if (before.parent_line_id) {
      await client.query(`UPDATE costing_lines SET updated_at = now() WHERE costing_line_id = $1`, [
        before.parent_line_id,
      ]);
    }

    if (header.status === "calculated") {
      await client.query(`UPDATE costing_headers SET status = 'draft', updated_at = now() WHERE costing_id = $1`, [id]);
    }
    await writeAuditEvent(
      {
        action: "LINE_DELETED",
        entityType: "costing_lines",
        entityId: lineId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { deletedAt: before.deleted_at },
        reason,
      },
      client,
    );
  });

  return NextResponse.json({ ok: true });
});
