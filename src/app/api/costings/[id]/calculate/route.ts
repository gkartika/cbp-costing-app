import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { loadCostingHeader } from "@/lib/costings/loadCosting";
import { deriveSizeLabel, type CostingLineRow } from "@/lib/costings/lines";
import { loadGuideContext } from "@/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "@/lib/calc/customPipeline";
import { calculateTradingPricelistLine, calculateTradingQuoteLine } from "@/lib/calc/tradingPipeline";
import type { ResolvedRuleRef } from "@/lib/calc/types";
import { Errors, toAppError } from "@/lib/errors";

type LineCalcOutcome = {
  lineId: string;
  profileResolved: string | null;
  rawWeightPerItemKg: number | null;
  costingWeightPerItemKg: number | null;
  basePricePerItem: number;
  coatingPricePerItem: number;
  diesPricePerItem: number;
  unitPriceBeforeRounding: number;
  unitSellingPrice: number;
  orderTotal: number;
  resolvedRuleRefs: ResolvedRuleRef[];
  inputSnapshot: Record<string, unknown>;
};

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const header = await loadCostingHeader(id);
  policy.assertCanEditCosting(user, { ownerUserId: header.owner_user_id, status: header.status });

  const { rows: publishedVersions } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (publishedVersions.length === 0) throw Errors.guideNotActive();
  const guideVersionId = publishedVersions[0].guide_version_id;
  const guideCtx = await loadGuideContext(guideVersionId);

  const { rows: lines } = await pool.query<CostingLineRow>(
    `SELECT * FROM costing_lines WHERE costing_id = $1 AND deleted_at IS NULL ORDER BY line_no`,
    [id],
  );
  if (lines.length === 0) throw Errors.validation("Tambahkan minimal satu item sebelum menghitung.");

  // All-or-nothing: a calculation is not valid until persisted, and a
  // partially-calculated costing must never exist (AUD-018).
  const outcomes: LineCalcOutcome[] = [];
  const lineErrors: { lineId: string; code: string; message: string }[] = [];

  for (const line of lines) {
    try {
      outcomes.push(await calculateOneLine(guideCtx, line));
    } catch (err) {
      const appError = toAppError(err);
      lineErrors.push({ lineId: line.costing_line_id, code: appError.code, message: appError.userMessage });
    }
  }

  if (lineErrors.length > 0) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Beberapa item gagal dihitung.", lineErrors } },
      { status: 422 },
    );
  }

  const result = await withTransaction(async (client) => {
    for (const outcome of outcomes) {
      const canonicalPayload = JSON.stringify({ input: outcome.inputSnapshot, refs: outcome.resolvedRuleRefs });
      const resultHash = createHash("sha256").update(canonicalPayload).digest("hex");

      await client.query(
        `INSERT INTO line_calculation_snapshots
           (snapshot_id, costing_line_id, guide_version_id, input_snapshot_json, resolved_rule_ids,
            raw_weight_per_item_kg, costing_weight_per_item_kg, base_price_per_item, coating_price_per_item,
            dies_price_per_item, unit_price_before_rounding, unit_selling_price, order_total, result_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          generateId("snap"),
          outcome.lineId,
          guideVersionId,
          JSON.stringify(outcome.inputSnapshot),
          JSON.stringify(outcome.resolvedRuleRefs),
          outcome.rawWeightPerItemKg,
          outcome.costingWeightPerItemKg,
          outcome.basePricePerItem,
          outcome.coatingPricePerItem,
          outcome.diesPricePerItem,
          outcome.unitPriceBeforeRounding,
          outcome.unitSellingPrice,
          outcome.orderTotal,
          resultHash,
        ],
      );
      if (outcome.profileResolved) {
        await client.query(`UPDATE costing_lines SET profile_resolved = $1 WHERE costing_line_id = $2`, [
          outcome.profileResolved,
          outcome.lineId,
        ]);
      }
    }

    await client.query(
      `UPDATE costing_headers SET status = 'calculated', guide_version_id = $1, updated_at = now() WHERE costing_id = $2`,
      [guideVersionId, id],
    );

    await writeAuditEvent(
      {
        action: "COSTING_CALCULATED",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { guideVersionId, lineCount: outcomes.length },
      },
      client,
    );

    return { guideVersionId, lineCount: outcomes.length };
  });

  return NextResponse.json(result);
});

async function calculateOneLine(
  guideCtx: Awaited<ReturnType<typeof loadGuideContext>>,
  line: CostingLineRow,
): Promise<LineCalcOutcome> {
  if (!line.route) throw Errors.routeRequired();
  if (!line.qty || line.qty < 1) throw Errors.qtyInvalid();

  const diameterMm = line.diameter_mm !== null ? Number(line.diameter_mm) : null;
  const qty = line.qty;
  const leadTimeDays = line.lead_time_days;
  const lengthMm = line.length_mm !== null ? Number(line.length_mm) : null;
  const developedCutLengthMm = line.developed_cut_length_mm !== null ? Number(line.developed_cut_length_mm) : null;
  const diesOption = line.dies_option;
  const diesTotalCost = line.dies_total_cost !== null ? Number(line.dies_total_cost) : null;
  const weightTolerancePercent = line.weight_tolerance_percent !== null ? Number(line.weight_tolerance_percent) : null;
  const coatingCode = line.coating_code;

  if (line.route === "CUSTOM") {
    if (diameterMm === null) throw Errors.rawSizeInvalid();
    if (!line.product_family) throw Errors.validation("Pilih product family.");
    if (!line.grade_input) throw Errors.validation("Pilih grade.");

    const input: CustomLineInput = {
      productFamily: line.product_family as CustomLineInput["productFamily"],
      gradeOrSpec: line.grade_input,
      // A line saved before size_label existed (or a legacy Metric-only line)
      // falls back to the old "M<diameter>" synthesis, which only ever
      // matched real Metric labels anyway — an Inch line always has
      // size_label set now (see Workspace.tsx's size dropdown).
      sizeLabel: line.size_label ?? deriveSizeLabel(diameterMm),
      diameterMm,
      qty,
      leadTimeDays,
      lengthMm,
      developedCutLengthMm,
      threadCondition: line.thread_condition,
      coatingCode,
      diesOption,
      diesTotalCost,
      weightTolerancePercent,
    };
    const result = calculateCustomLine(guideCtx, input);
    return {
      lineId: line.costing_line_id,
      profileResolved: result.profileResolved,
      rawWeightPerItemKg: result.rawWeightPerItemKg,
      costingWeightPerItemKg: result.costingWeightPerItemKg,
      basePricePerItem: result.basePricePerItem,
      coatingPricePerItem: result.coatingPricePerItem,
      diesPricePerItem: result.diesPricePerItem,
      unitPriceBeforeRounding: result.unitPriceBeforeRounding,
      unitSellingPrice: result.unitSellingPrice,
      orderTotal: result.orderTotal,
      resolvedRuleRefs: result.resolvedRuleRefs,
      inputSnapshot: input,
    };
  }

  // TRADING route: fixed pricelist when an item is resolved, otherwise a user-selected quote.
  if (line.trading_item_id) {
    if (diameterMm === null || !line.product_family) throw Errors.validation("Data trading tidak lengkap.");
    const pricelistInput = {
      productCategory: line.product_family,
      sizeLabel: deriveSizeLabel(diameterMm),
      qty,
      coatingCode,
      productTypeLabel: line.product_family,
      diameterMm,
      tradingItemId: line.trading_item_id,
    };
    const result = calculateTradingPricelistLine(guideCtx, pricelistInput);
    return {
      lineId: line.costing_line_id,
      profileResolved: null,
      rawWeightPerItemKg: null,
      costingWeightPerItemKg: null,
      basePricePerItem: result.basePricePerItem,
      coatingPricePerItem: result.coatingPricePerItem,
      diesPricePerItem: 0,
      unitPriceBeforeRounding: result.unitPriceBeforeRounding,
      unitSellingPrice: result.unitSellingPrice,
      orderTotal: result.orderTotal,
      resolvedRuleRefs: result.resolvedRuleRefs,
      inputSnapshot: pricelistInput,
    };
  }

  if (line.trading_quote_id) {
    const { rows } = await pool.query<{
      quoted_price: string;
      tax_basis: "INCLUDE_PPN" | "EXCLUDE_PPN";
      ppn_rate: string | null;
      landed_cost_confirmed: boolean;
    }>(
      `SELECT quoted_price, tax_basis, ppn_rate, landed_cost_confirmed FROM trading_quotes WHERE trading_quote_id = $1`,
      [line.trading_quote_id],
    );
    if (rows.length === 0) throw Errors.notFound("Trading quote");
    const quote = rows[0];

    const quoteInput = {
      quotedPrice: Number(quote.quoted_price),
      taxBasis: quote.tax_basis,
      ppnRate: quote.ppn_rate !== null ? Number(quote.ppn_rate) : null,
      landedCostConfirmed: quote.landed_cost_confirmed,
      marginPercent: line.margin_percent !== null ? Number(line.margin_percent) : null,
      qty,
      coatingCode,
      productTypeLabel: line.product_family ?? "",
      diameterMm: diameterMm ?? 0,
    };
    const result = calculateTradingQuoteLine(guideCtx, quoteInput);
    return {
      lineId: line.costing_line_id,
      profileResolved: null,
      rawWeightPerItemKg: null,
      costingWeightPerItemKg: null,
      basePricePerItem: result.basePricePerItem,
      coatingPricePerItem: result.coatingPricePerItem,
      diesPricePerItem: 0,
      unitPriceBeforeRounding: result.unitPriceBeforeRounding,
      unitSellingPrice: result.unitSellingPrice,
      orderTotal: result.orderTotal,
      resolvedRuleRefs: result.resolvedRuleRefs,
      inputSnapshot: quoteInput,
    };
  }

  throw Errors.tradingTierNotFound();
}
