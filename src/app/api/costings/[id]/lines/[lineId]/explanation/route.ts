import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool } from "@/lib/db";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { explainResolvedRules } from "@/lib/calc/explainSnapshot";
import type { ResolvedRuleRef } from "@/lib/calc/types";
import { Errors } from "@/lib/errors";

export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const { id, lineId } = await ctx.params;
  await loadCostingHeader(id);

  const { rows } = await pool.query<{
    snapshot_id: string;
    guide_version_id: string;
    input_snapshot_json: unknown;
    resolved_rule_ids: ResolvedRuleRef[];
    raw_weight_per_item_kg: string | null;
    costing_weight_per_item_kg: string | null;
    base_price_per_item: string;
    coating_price_per_item: string;
    dies_price_per_item: string;
    unit_price_before_rounding: string;
    unit_selling_price: string;
    order_total: string;
    result_hash: string;
    created_at: Date;
  }>(
    `SELECT s.* FROM line_calculation_snapshots s
     JOIN costing_lines cl ON cl.costing_line_id = s.costing_line_id
     WHERE cl.costing_id = $1 AND s.costing_line_id = $2
     ORDER BY s.created_at DESC LIMIT 1`,
    [id, lineId],
  );
  if (rows.length === 0) throw Errors.notFound("Calculation snapshot");
  const snapshot = rows[0];

  const explainedRules = await explainResolvedRules(snapshot.resolved_rule_ids);

  return NextResponse.json({
    snapshotId: snapshot.snapshot_id,
    guideVersionId: snapshot.guide_version_id,
    inputSnapshot: snapshot.input_snapshot_json,
    rawWeightPerItemKg: snapshot.raw_weight_per_item_kg !== null ? Number(snapshot.raw_weight_per_item_kg) : null,
    costingWeightPerItemKg:
      snapshot.costing_weight_per_item_kg !== null ? Number(snapshot.costing_weight_per_item_kg) : null,
    basePricePerItem: Number(snapshot.base_price_per_item),
    coatingPricePerItem: Number(snapshot.coating_price_per_item),
    diesPricePerItem: Number(snapshot.dies_price_per_item),
    unitPriceBeforeRounding: Number(snapshot.unit_price_before_rounding),
    unitSellingPrice: Number(snapshot.unit_selling_price),
    orderTotal: Number(snapshot.order_total),
    resultHash: snapshot.result_hash,
    calculatedAt: snapshot.created_at,
    explainedRules,
  });
});
