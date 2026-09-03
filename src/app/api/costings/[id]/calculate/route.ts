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
import { effectiveComponentQty, sumSet, type PricedComponent } from "@/lib/costings/sets";
import { loadGuideContext } from "@/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "@/lib/calc/customPipeline";
import { calculateTradingPricelistLine, calculateTradingQuoteLine } from "@/lib/calc/tradingPipeline";
import { getConfigNumber } from "@/lib/calc/appConfig";
import { ceilingToIncrement } from "@/lib/calc/rounding";
import type { ResolvedRuleRef } from "@/lib/calc/types";
import { Errors, toAppError } from "@/lib/errors";

type LineCalcOutcome = {
  lineId: string;
  /** The quantity orderTotal was computed from — needed to re-derive orderTotal after a post-hoc price adjustment (customer markup) without re-deriving it from the line row. */
  qty: number;
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

  // A per-customer markup (business decision 2026-09-04) is a commercial
  // relationship attribute, not a pricing-guide rule, so it lives on
  // customers rather than in the versioned guide — but it is still applied
  // and explained like every other adjustment, just resolved once per
  // calculate-all pass instead of per line.
  let customerMarkup: { percent: number; customerId: string } | null = null;
  if (header.customer_id) {
    const { rows } = await pool.query<{ customer_id: string; markup_percent: string | null }>(
      `SELECT customer_id, markup_percent FROM customers WHERE customer_id = $1 AND active = TRUE`,
      [header.customer_id],
    );
    if (rows.length > 0 && rows[0].markup_percent !== null) {
      customerMarkup = { percent: Number(rows[0].markup_percent), customerId: rows[0].customer_id };
    }
  }

  const { rows: lines } = await pool.query<CostingLineRow>(
    `SELECT * FROM costing_lines WHERE costing_id = $1 AND deleted_at IS NULL ORDER BY line_no`,
    [id],
  );
  if (lines.length === 0) throw Errors.validation("Tambahkan minimal satu item sebelum menghitung.");

  // All-or-nothing: a calculation is not valid until persisted, and a
  // partially-calculated costing must never exist (AUD-018).
  const outcomes: LineCalcOutcome[] = [];
  const lineErrors: { lineId: string; code: string; message: string }[] = [];

  // Components carry the priced item; the set line above them is arithmetic
  // over the results, so components must be priced first. Both end up in
  // line_calculation_snapshots — the component rows are what make a set's
  // price explainable, the set row is what every total already reads.
  const componentsByParent = new Map<string, CostingLineRow[]>();
  for (const line of lines) {
    if (line.parent_line_id === null) continue;
    const siblings = componentsByParent.get(line.parent_line_id);
    if (siblings) siblings.push(line);
    else componentsByParent.set(line.parent_line_id, [line]);
  }

  const pricedById = new Map<string, LineCalcOutcome>();
  for (const line of lines) {
    if (line.line_kind === "set") continue;
    try {
      const setQty = line.parent_line_id ? (lines.find((l) => l.costing_line_id === line.parent_line_id)?.qty ?? 0) : 0;
      const outcome = await calculateOneLine(guideCtx, line, setQty, customerMarkup);
      pricedById.set(line.costing_line_id, outcome);
      outcomes.push(outcome);
    } catch (err) {
      const appError = toAppError(err);
      lineErrors.push({ lineId: line.costing_line_id, code: appError.code, message: appError.userMessage });
    }
  }

  for (const line of lines) {
    if (line.line_kind !== "set") continue;
    try {
      outcomes.push(rollUpSet(line, componentsByParent.get(line.costing_line_id) ?? [], pricedById));
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

/**
 * A set's price is the sum of its priced components, each multiplied by how
 * many go in one set. It gets a snapshot row like any other line, so the
 * dashboard, reports, quotation and finalize checks read it through the same
 * latest-snapshot join they already use — with the aggregating queries
 * restricted to top-level lines so components are not counted a second time.
 *
 * There is no rounding step here: each component is already on the rounding
 * grid, so their total is too.
 */
function rollUpSet(
  line: CostingLineRow,
  components: CostingLineRow[],
  pricedById: Map<string, LineCalcOutcome>,
): LineCalcOutcome {
  if (!line.qty || line.qty < 1) throw Errors.qtyInvalid();
  const setQty = line.qty;
  if (components.length === 0) {
    throw Errors.validation(`Set #${line.line_no} belum punya komponen — tambahkan minimal satu.`);
  }

  const priced: PricedComponent[] = [];
  for (const c of components) {
    const outcome = pricedById.get(c.costing_line_id);
    // A component that failed to price already recorded its own lineError, so
    // the request is failing regardless; bail rather than quote a partial set.
    if (!outcome) throw Errors.validation(`Komponen pada set #${line.line_no} gagal dihitung.`);
    priced.push({
      qtyPerSet: c.qty_per_set ?? 1,
      basePricePerItem: outcome.basePricePerItem,
      coatingPricePerItem: outcome.coatingPricePerItem,
      diesPricePerItem: outcome.diesPricePerItem,
      unitSellingPrice: outcome.unitSellingPrice,
    });
  }

  const totals = sumSet(priced, setQty);
  const componentRefs = components.flatMap((c) => pricedById.get(c.costing_line_id)?.resolvedRuleRefs ?? []);

  return {
    lineId: line.costing_line_id,
    qty: setQty,
    profileResolved: null,
    // Weight is per-item and a set has no single item; the component snapshots
    // carry their own weights, and inventing a summed one here would put a
    // number on the Explain panel that means nothing.
    rawWeightPerItemKg: null,
    costingWeightPerItemKg: null,
    basePricePerItem: totals.basePricePerSet,
    coatingPricePerItem: totals.coatingPricePerSet,
    diesPricePerItem: totals.diesPricePerSet,
    unitPriceBeforeRounding: totals.pricePerSet,
    unitSellingPrice: totals.pricePerSet,
    orderTotal: totals.orderTotal,
    resolvedRuleRefs: componentRefs,
    inputSnapshot: {
      lineKind: "set",
      setQty,
      components: components.map((c) => ({
        costingLineId: c.costing_line_id,
        description: c.description,
        productFamily: c.product_family,
        gradeInput: c.grade_input,
        sizeLabel: c.size_label,
        qtyPerSet: c.qty_per_set,
        manufacturedQty: effectiveComponentQty(c.qty_per_set ?? 1, setQty),
        unitSellingPrice: pricedById.get(c.costing_line_id)?.unitSellingPrice ?? null,
      })),
    },
  };
}

/**
 * Prices one line, then applies the costing's customer markup (if any) as a
 * final multiplier and re-rounds — deliberately outside priceOneLine, and
 * after it rather than woven into any one route's steps, so every route
 * (Custom, Trading pricelist, Trading quote) gets the same treatment without
 * three separate copies of "multiply by 1+markup, round again." A set's
 * components each pass through here individually, so a set's total already
 * carries the markup transitively by the time rollUpSet sums them — applying
 * it a second time at the set level would double it.
 */
async function calculateOneLine(
  guideCtx: Awaited<ReturnType<typeof loadGuideContext>>,
  line: CostingLineRow,
  setQty: number,
  customerMarkup: { percent: number; customerId: string } | null,
): Promise<LineCalcOutcome> {
  const priced = await priceOneLine(guideCtx, line, setQty);
  if (!customerMarkup || customerMarkup.percent === 0) return priced;

  const unitPriceBeforeRounding = priced.unitPriceBeforeRounding * (1 + customerMarkup.percent);
  const roundingIncrement = getConfigNumber(guideCtx, "ROUNDING_INCREMENT");
  const unitSellingPrice = ceilingToIncrement(unitPriceBeforeRounding, roundingIncrement);

  return {
    ...priced,
    unitPriceBeforeRounding,
    unitSellingPrice,
    orderTotal: unitSellingPrice * priced.qty,
    resolvedRuleRefs: [
      ...priced.resolvedRuleRefs,
      {
        table: "customers",
        id: customerMarkup.customerId,
        note: `Kenaikan harga customer: +${(customerMarkup.percent * 100).toFixed(2)}%.`,
      },
    ],
  };
}

async function priceOneLine(
  guideCtx: Awaited<ReturnType<typeof loadGuideContext>>,
  line: CostingLineRow,
  setQty: number,
): Promise<LineCalcOutcome> {
  if (!line.route) throw Errors.routeRequired();
  // A component's own qty column is unused: what gets made is qty_per_set
  // times the number of sets ordered, and that is the figure the quantity
  // break and dies amortisation must both see.
  const effectiveQty =
    line.line_kind === "component" ? effectiveComponentQty(line.qty_per_set ?? 1, setQty) : (line.qty ?? 0);
  if (effectiveQty < 1) throw Errors.qtyInvalid();

  const diameterMm = line.diameter_mm !== null ? Number(line.diameter_mm) : null;
  const qty = effectiveQty;
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
      qty,
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
      qty,
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
      qty,
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
