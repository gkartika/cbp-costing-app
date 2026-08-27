import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { serializeCostingLine, type CostingLineRow } from "@/lib/costings/lines";
import { Errors } from "@/lib/errors";

export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const { id } = await ctx.params;
  await loadCostingHeader(id);

  const { rows } = await pool.query<CostingLineRow & { has_current_snapshot: boolean }>(
    `SELECT cl.*,
            EXISTS (
              SELECT 1 FROM line_calculation_snapshots s
              WHERE s.costing_line_id = cl.costing_line_id AND s.created_at >= cl.updated_at
            ) AS has_current_snapshot
     FROM costing_lines cl
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
     ORDER BY cl.line_no`,
    [id],
  );
  return NextResponse.json({
    lines: rows.map((r) => serializeCostingLine(r, r.has_current_snapshot)),
  });
});

const CreateLineSchema = z.object({
  /**
   * "item" is a standalone product (the default, and everything that existed
   * before DEC-017). "set" is a customer-facing assembly whose price comes
   * from its components. "component" is one part inside a set, and is the only
   * kind that carries parentLineId/qtyPerSet.
   */
  lineKind: z.enum(["item", "set", "component"]).optional(),
  parentLineId: z.string().optional(),
  qtyPerSet: z.number().int().min(1).optional(),
  route: z.enum(["TRADING", "CUSTOM"]).optional(),
  productFamily: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  gradeInput: z.string().max(100).optional(),
  threadCondition: z.string().max(20).optional(),
  sizeLabel: z.string().max(50).optional(),
  diameterMm: z.number().positive().optional(),
  lengthMm: z.number().positive().optional(),
  developedCutLengthMm: z.number().positive().optional(),
  qty: z.number().int().min(1).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  coatingCode: z.string().max(50).optional(),
  diesOption: z.enum(["yes", "no_lookup", "manual"]).optional(),
  diesTotalCost: z.number().min(0).optional(),
  weightTolerancePercent: z.number().min(0).max(1).optional(),
  marginPercent: z.number().min(0).max(0.999999).optional(),
  tradingItemId: z.string().optional(),
});

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const before = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: before.owner_user_id, status: before.status });

  const body = CreateLineSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data item tidak valid.");

  const lineKind = body.data.lineKind ?? "item";
  // The DB constraints enforce the same shape, but a 500 from a check
  // violation tells the user nothing; these say which field is wrong.
  if (lineKind === "component") {
    if (!body.data.parentLineId) throw Errors.validation("Komponen harus punya set induk.");
    if (!body.data.qtyPerSet) throw Errors.validation("Isi jumlah per set untuk komponen.");
  } else if (body.data.parentLineId || body.data.qtyPerSet) {
    throw Errors.validation("Hanya komponen yang punya set induk dan jumlah per set.");
  }

  const line = await withTransaction(async (client) => {
    if (lineKind === "component") {
      // A component may only hang off a set line in this same costing —
      // otherwise a crafted parentLineId could attach it to another user's
      // costing, or nest a set inside a set, which nothing here can price.
      const { rows: parentRows } = await client.query<{ line_kind: string }>(
        `SELECT line_kind FROM costing_lines
         WHERE costing_line_id = $1 AND costing_id = $2 AND deleted_at IS NULL`,
        [body.data.parentLineId, id],
      );
      if (parentRows.length === 0) throw Errors.notFound("Set induk");
      if (parentRows[0].line_kind !== "set") throw Errors.validation("Komponen hanya bisa ditambahkan ke sebuah set.");
    }

    const { rows: maxRow } = await client.query<{ max: number | null }>(
      `SELECT MAX(line_no) AS max FROM costing_lines WHERE costing_id = $1`,
      [id],
    );
    const lineNo = (maxRow[0].max ?? 0) + 1;
    const lineId = generateId("line");

    const { rows } = await client.query<CostingLineRow>(
      `INSERT INTO costing_lines
         (costing_line_id, costing_id, line_no, line_kind, parent_line_id, qty_per_set,
          route, product_family, description, grade_input, thread_condition,
          size_label, diameter_mm, length_mm, developed_cut_length_mm, qty, lead_time_days, coating_code,
          dies_option, dies_total_cost, weight_tolerance_percent, margin_percent, trading_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       RETURNING *`,
      [
        lineId,
        id,
        lineNo,
        lineKind,
        body.data.parentLineId ?? null,
        body.data.qtyPerSet ?? null,
        body.data.route ?? null,
        body.data.productFamily ?? null,
        body.data.description ?? null,
        body.data.gradeInput ?? null,
        body.data.threadCondition ?? null,
        body.data.sizeLabel ?? null,
        body.data.diameterMm ?? null,
        body.data.lengthMm ?? null,
        body.data.developedCutLengthMm ?? null,
        body.data.qty ?? null,
        body.data.leadTimeDays ?? null,
        body.data.coatingCode ?? null,
        body.data.diesOption ?? null,
        body.data.diesTotalCost ?? null,
        body.data.weightTolerancePercent ?? null,
        body.data.marginPercent ?? null,
        body.data.tradingItemId ?? null,
      ],
    );

    // A new component changes the set price above it, and staleness is judged
    // per line — so the parent must be marked too or finalize would accept the
    // set's pre-existing snapshot as current.
    if (lineKind === "component") {
      await client.query(`UPDATE costing_lines SET updated_at = now() WHERE costing_line_id = $1`, [
        body.data.parentLineId,
      ]);
    }

    // A new/changed line invalidates the costing's Calculated status until recalculated.
    if (before.status === "calculated") {
      await client.query(`UPDATE costing_headers SET status = 'draft', updated_at = now() WHERE costing_id = $1`, [id]);
    }

    await writeAuditEvent(
      {
        action: "LINE_CREATED",
        entityType: "costing_lines",
        entityId: lineId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: body.data,
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCostingLine(line, false), { status: 201 });
});
