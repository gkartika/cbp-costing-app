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
  /** Line-item discount, applied before PPN and before the header's own total discount. */
  discountType: z.enum(["PERCENT", "AMOUNT"]).nullable().optional(),
  discountValue: z.number().min(0).nullable().optional(),
  /** Pitch/Thread: STANDARD has no price effect; CUSTOM adds +10% (see calculate/route.ts). */
  pitchType: z.enum(["STANDARD", "CUSTOM"]).nullable().optional(),
  pitchValue: z.string().max(50).nullable().optional(),
  /**
   * The user's pick between an already-computed Production or Trading price
   * (route merge) — handled separately from every other field below: picking
   * between two prices Calculate All already produced must not itself force
   * a recalculation, so it never touches updated_at or the costing's status.
   */
  chosenPriceKind: z.enum(["PRODUCTION", "TRADING"]).nullable().optional(),
  /**
   * Manual override of the quoted unit price — handled the same way as
   * chosenPriceKind: it's a quoting decision layered on top of an already
   * calculated line, not a calculation input, so it never touches updated_at
   * or forces a recalculation.
   */
  unitPriceOverride: z.number().min(0).nullable().optional(),
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
  discountType: "discount_type",
  discountValue: "discount_value",
  pitchType: "pitch_type",
  pitchValue: "pitch_value",
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

  if ("chosenPriceKind" in body.data) {
    const kind = body.data.chosenPriceKind;
    if (kind !== null) {
      const { rows: snapRows } = await pool.query(
        `SELECT 1 FROM line_calculation_snapshots WHERE costing_line_id = $1 AND price_kind = $2 LIMIT 1`,
        [lineId, kind],
      );
      if (snapRows.length === 0) {
        throw Errors.validation(`Belum ada harga ${kind === "TRADING" ? "Trading" : "Production"} untuk item ini.`);
      }
    }
    await pool.query(`UPDATE costing_lines SET chosen_price_kind = $1 WHERE costing_line_id = $2`, [kind, lineId]);
    await writeAuditEvent({
      action: "LINE_PRICE_KIND_CHOSEN",
      entityType: "costing_lines",
      entityId: lineId,
      actorUserId: user.userId,
      actorRole: primaryAuditRole(user),
      requestId,
      beforeJson: { chosenPriceKind: before.chosen_price_kind },
      afterJson: { chosenPriceKind: kind },
    });
  }

  if ("unitPriceOverride" in body.data) {
    const override = body.data.unitPriceOverride;
    await pool.query(`UPDATE costing_lines SET unit_price_override = $1 WHERE costing_line_id = $2`, [
      override,
      lineId,
    ]);
    await writeAuditEvent({
      action: "LINE_PRICE_OVERRIDDEN",
      entityType: "costing_lines",
      entityId: lineId,
      actorUserId: user.userId,
      actorRole: primaryAuditRole(user),
      requestId,
      beforeJson: { unitPriceOverride: before.unit_price_override },
      afterJson: { unitPriceOverride: override },
    });
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
    const current = await loadLine(id, lineId);
    return NextResponse.json(serializeCostingLine(current, false));
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
