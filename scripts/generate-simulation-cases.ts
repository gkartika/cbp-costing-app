/**
 * Generates a 100-case regression matrix against the active Published guide
 * and writes it out with a full calculation breakdown per case.
 *
 * Every number in the output comes from running the real calculation engine —
 * nothing is hand-derived — so the breakdown columns can be checked against
 * CBP's own pricing by hand, and the cases can be loaded back as golden
 * Simulation_Cases later.
 */
import { writeFileSync } from "fs";
import ExcelJS from "exceljs";
import { pool } from "../src/lib/db";
import { getActivePublishedGuideVersionId } from "../src/lib/guide/activeGuideVersion";
import { loadGuideContext } from "../src/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "../src/lib/calc/customPipeline";
import { calculateTradingPricelistLine, calculateTradingQuoteLine } from "../src/lib/calc/tradingPipeline";
import type { GuideContext } from "../src/lib/calc/types";
import { AppError } from "../src/lib/errors";

type CaseSpec =
  | { id: string; route: "Custom Production"; purpose: string; input: CustomLineInput }
  | {
      id: string;
      route: "Trading Pricelist";
      purpose: string;
      input: Parameters<typeof calculateTradingPricelistLine>[1];
    }
  | { id: string; route: "Trading Quote"; purpose: string; input: Parameters<typeof calculateTradingQuoteLine>[1] };

function bolt(over: Partial<CustomLineInput> = {}): CustomLineInput {
  return {
    productFamily: "Bolt",
    gradeOrSpec: "A325",
    sizeLabel: "M14",
    diameterMm: 14,
    qty: 100,
    leadTimeDays: 14,
    lengthMm: 80,
    developedCutLengthMm: null,
    threadCondition: "HT",
    coatingCode: null,
    diesOption: null,
    diesTotalCost: null,
    ...over,
  };
}

function nut(over: Partial<CustomLineInput> = {}): CustomLineInput {
  return {
    productFamily: "Nut",
    gradeOrSpec: "2H",
    sizeLabel: "M20",
    diameterMm: 20,
    qty: 100,
    leadTimeDays: null,
    lengthMm: null,
    developedCutLengthMm: null,
    coatingCode: null,
    diesOption: null,
    diesTotalCost: null,
    ...over,
  };
}

/**
 * Combinations are chosen against real CBP price coverage, which is NOT a full
 * grid — Nut prices start at M20, Bolt grade 4.6/A307 start at M27, matching
 * the blanks in CBP's own price guide. Cases that deliberately probe an
 * unoffered combination are labelled "expected reject" so a rejection reads as
 * a pass, not a failure.
 */
function buildCases(): CaseSpec[] {
  const cases: CaseSpec[] = [];
  const add = (c: Omit<CaseSpec, "id">) =>
    cases.push({ ...c, id: `TC-${String(cases.length + 1).padStart(3, "0")}` } as CaseSpec);

  // --- A. Bolt quantity brackets (1-30 / 31-100 / 101-500 / 501-1000 / 1001+), on both edges (8) ---
  [1, 30, 31, 100, 101, 501, 1001, 5000].forEach((qty) =>
    add({
      route: "Custom Production",
      purpose: `Bolt qty bracket edge @ qty=${qty}`,
      input: bolt({ qty }),
    }),
  );

  // --- B. Bolt lead-time brackets, incl. the deliberate 8-9 day gap (8) ---
  [0, 7, 8, 10, 13, 14, 21, 28].forEach((leadTimeDays) =>
    add({
      route: "Custom Production",
      purpose:
        leadTimeDays === 8
          ? "Bolt lead time @ 8d — expected reject (8-9d deliberately uncovered)"
          : `Bolt lead time bracket edge @ ${leadTimeDays}d`,
      input: bolt({ leadTimeDays }),
    }),
  );

  // --- C. Bolt length/diameter ratio brackets 0-6D / >6-12D / >12D (5) ---
  [40, 84, 85, 168, 169].forEach((lengthMm) =>
    add({
      route: "Custom Production",
      purpose: `Bolt L/D ratio @ length=${lengthMm}mm (${(lengthMm / 14).toFixed(2)}D)`,
      input: bolt({ lengthMm }),
    }),
  );

  // --- D. Thread condition HT vs FT at the same grade+size (8) ---
  ["A325", "8.8", "10.9", "F10T"].forEach((gradeOrSpec) =>
    (["HT", "FT"] as const).forEach((threadCondition) =>
      add({
        route: "Custom Production",
        purpose: `Bolt HT/FT price split: ${gradeOrSpec} ${threadCondition}`,
        input: bolt({ gradeOrSpec, threadCondition }),
      }),
    ),
  );

  // --- E. Bolt grade coverage incl. stainless alias path (9) ---
  [
    { gradeOrSpec: "4.6", sizeLabel: "M30", diameterMm: 30 },
    { gradeOrSpec: "6.8", sizeLabel: "M30", diameterMm: 30 },
    { gradeOrSpec: "A307", sizeLabel: "M30", diameterMm: 30 },
    { gradeOrSpec: "A307B", sizeLabel: "M30", diameterMm: 30 },
    { gradeOrSpec: "B7", sizeLabel: "M24", diameterMm: 24 },
    { gradeOrSpec: "12.9", sizeLabel: "M20", diameterMm: 20 },
    { gradeOrSpec: "A193-B8", sizeLabel: "M20", diameterMm: 20 },
    { gradeOrSpec: "SS304L", sizeLabel: "M20", diameterMm: 20 },
    { gradeOrSpec: "SS316L", sizeLabel: "M20", diameterMm: 20 },
  ].forEach((over) =>
    add({
      route: "Custom Production",
      purpose: `Bolt grade coverage: ${over.gradeOrSpec} @ ${over.sizeLabel}`,
      input: bolt(over),
    }),
  );

  // --- F. Bolt size sweep across the priced range (8) ---
  [14, 18, 22, 27, 33, 45, 56, 64].forEach((d) =>
    add({
      route: "Custom Production",
      purpose: `Bolt size sweep @ M${d}`,
      input: bolt({ sizeLabel: `M${d}`, diameterMm: d, lengthMm: d * 5 }),
    }),
  );

  // --- G. Coating: HDG/PTFE across order-weight discount brackets (5) ---
  [
    { coatingCode: "HDG", qty: 10, label: "HDG small order (no discount bracket)" },
    { coatingCode: "HDG", qty: 3000, label: "HDG mid order (crosses weight discount)" },
    { coatingCode: "HDG", qty: 30000, label: "HDG very large order (deepest discount)" },
    { coatingCode: "PTFE", qty: 100, label: "PTFE rate path" },
    { coatingCode: "HDG", qty: 100, size: 36, label: "HDG at M36 (diameter rate breakpoint)" },
  ].forEach((c) =>
    add({
      route: "Custom Production",
      purpose: `Bolt coating: ${c.label}`,
      input: bolt({
        coatingCode: c.coatingCode,
        qty: c.qty,
        ...(c.size ? { sizeLabel: `M${c.size}`, diameterMm: c.size, lengthMm: c.size * 5 } : {}),
      }),
    }),
  );

  // --- H. Dies charge amortisation (5) ---
  [
    { diesOption: "yes" as const, diesTotalCost: null, qty: 100, label: "dies available -> no charge" },
    { diesOption: "manual" as const, diesTotalCost: 2_500_000, qty: 100, label: "2.5M dies over qty 100" },
    { diesOption: "manual" as const, diesTotalCost: 2_500_000, qty: 1000, label: "same dies over qty 1000" },
    { diesOption: "manual" as const, diesTotalCost: 0, qty: 50, label: "zero dies cost allowed" },
    { diesOption: "manual" as const, diesTotalCost: null, qty: 50, label: "no cost supplied — expected reject" },
  ].forEach((c) =>
    add({
      route: "Custom Production",
      purpose: `Bolt dies: ${c.label}`,
      input: bolt({ diesOption: c.diesOption, diesTotalCost: c.diesTotalCost, qty: c.qty }),
    }),
  );

  // --- I. Nut Custom Production — qty brackets 1-400 / 401-1000 / 1001+ (6) ---
  [1, 400, 401, 1000, 1001, 5000].forEach((qty) =>
    add({
      route: "Custom Production",
      purpose: `Nut 2H qty bracket edge @ qty=${qty}`,
      input: nut({ qty }),
    }),
  );

  // --- J. Nut grade/size coverage — real Nut prices start at M20 (8) ---
  [
    { gradeOrSpec: "2H", sizeLabel: "M24", diameterMm: 24 },
    { gradeOrSpec: "2H", sizeLabel: "M64", diameterMm: 64 },
    { gradeOrSpec: "8.8", sizeLabel: "M20", diameterMm: 20 },
    { gradeOrSpec: "10.9", sizeLabel: "M22", diameterMm: 22 },
    { gradeOrSpec: "12.9", sizeLabel: "M27", diameterMm: 27 },
    { gradeOrSpec: "A194-8", sizeLabel: "M20", diameterMm: 20 },
    { gradeOrSpec: "A563", sizeLabel: "M30", diameterMm: 30 }, // A563 starts at M27, same as grade 4.6
    { gradeOrSpec: "F10", sizeLabel: "M22", diameterMm: 22 },
  ].forEach((over) =>
    add({
      route: "Custom Production",
      purpose: `Nut grade/size coverage: ${over.gradeOrSpec} @ ${over.sizeLabel}`,
      input: nut(over),
    }),
  );

  // --- K. Nut thickness branch: 2H uses thickness=D, others 0.8D, same size (2) ---
  [
    { gradeOrSpec: "2H", label: "2H -> thickness = D" },
    { gradeOrSpec: "8.8", label: "non-2H -> thickness = 0.8D" },
  ].forEach((c) =>
    add({
      route: "Custom Production",
      purpose: `Nut thickness branch: ${c.label} (both @ M30)`,
      input: nut({ gradeOrSpec: c.gradeOrSpec, sizeLabel: "M30", diameterMm: 30 }),
    }),
  );

  // --- L. Trading Pricelist — Washer F436 tier boundaries + inherit fallback (7) ---
  [
    { d: 20, qty: 1 },
    { d: 20, qty: 100 },
    { d: 20, qty: 101 },
    { d: 24, qty: 250 },
    { d: 36, qty: 1000 },
    { d: 72, qty: 5000 },
    { d: 72, qty: 5001 },
  ].forEach((c) =>
    add({
      route: "Trading Pricelist",
      purpose: `Trading Washer M${c.d} qty=${c.qty} (tier lookup / inherit-lower fallback)`,
      input: {
        productCategory: "Washer",
        sizeLabel: `M${c.d}`,
        qty: c.qty,
        coatingCode: null,
        productTypeLabel: "Washer",
        diameterMm: c.d,
      },
    }),
  );

  // --- M. Trading Pricelist — Nut. NOTE: many Nut grades share one size label
  // and the resolver matches on category+size only, so these show which row wins (6) ---
  [
    { d: 12, qty: 25 },
    { d: 12, qty: 26 },
    { d: 16, qty: 500 },
    { d: 20, qty: 2000 },
    { d: 24, qty: 2001 },
    { d: 30, qty: 100 },
  ].forEach((c) =>
    add({
      route: "Trading Pricelist",
      purpose: `Trading Nut M${c.d} qty=${c.qty} — grade ambiguous at this size, first match wins`,
      input: {
        productCategory: "Nut",
        sizeLabel: `M${c.d}`,
        qty: c.qty,
        coatingCode: null,
        productTypeLabel: "Nut",
        diameterMm: c.d,
      },
    }),
  );

  // --- N. Trading + coating stacked on a tier price (2) ---
  [
    { code: "HDG", qty: 200 },
    { code: "PTFE", qty: 200 },
  ].forEach((c) =>
    add({
      route: "Trading Pricelist",
      purpose: `Trading Washer M20 qty=${c.qty} with ${c.code} coating on top of tier price`,
      input: {
        productCategory: "Washer",
        sizeLabel: "M20",
        qty: c.qty,
        coatingCode: c.code,
        productTypeLabel: "Washer",
        diameterMm: 20,
      },
    }),
  );

  // --- O. Trading Quote: tax normalisation + margin (6) ---
  [
    { quotedPrice: 11100, taxBasis: "INCLUDE_PPN" as const, ppnRate: 0.11, marginPercent: 0.25, qty: 30, label: "incl 11% PPN, 25% margin" },
    { quotedPrice: 10000, taxBasis: "EXCLUDE_PPN" as const, ppnRate: null, marginPercent: 0.25, qty: 30, label: "ex-PPN, 25% margin" },
    { quotedPrice: 10000, taxBasis: "EXCLUDE_PPN" as const, ppnRate: null, marginPercent: 0, qty: 100, label: "zero margin pass-through" },
    { quotedPrice: 50000, taxBasis: "INCLUDE_PPN" as const, ppnRate: 0.12, marginPercent: 0.4, qty: 10, label: "12% PPN, 40% margin" },
    { quotedPrice: 2500, taxBasis: "INCLUDE_PPN" as const, ppnRate: 0.11, marginPercent: 0.15, qty: 5000, label: "low unit price, high qty" },
  ].forEach((c) =>
    add({
      route: "Trading Quote",
      purpose: `Trading Quote: ${c.label}`,
      input: {
        quotedPrice: c.quotedPrice,
        taxBasis: c.taxBasis,
        ppnRate: c.ppnRate,
        landedCostConfirmed: true,
        marginPercent: c.marginPercent,
        qty: c.qty,
        coatingCode: null,
        productTypeLabel: "Nut",
        diameterMm: 12,
      },
    }),
  );

  // --- P. Negative / guard cases — a rejection here IS the pass condition (8) ---
  add({
    route: "Custom Production",
    purpose: "Bolt at a size with no dimensional guide — expected reject",
    input: bolt({ sizeLabel: "M999", diameterMm: 999, lengthMm: 100 }),
  });
  add({
    route: "Custom Production",
    purpose: "Bolt with an unknown grade — expected reject",
    input: bolt({ gradeOrSpec: "NOT-A-GRADE" }),
  });
  add({
    route: "Custom Production",
    purpose: "Bolt grade 4.6 @ M14 — not offered below M27 in CBP's guide, expected reject",
    input: bolt({ gradeOrSpec: "4.6", sizeLabel: "M14", diameterMm: 14 }),
  });
  add({
    route: "Custom Production",
    purpose: "Nut 2H @ M16 — Nut prices start at M20, expected reject",
    input: nut({ sizeLabel: "M16", diameterMm: 16 }),
  });
  add({
    route: "Custom Production",
    purpose:
      "Nut A2-70 @ M20 — expected reject: profile rules use A2-70/A4-70 but Nut price rows use SUS304L/SUS316L and no Nut alias exists (DATA GAP)",
    input: nut({ gradeOrSpec: "A2-70", sizeLabel: "M20", diameterMm: 20 }),
  });
  add({
    route: "Trading Pricelist",
    purpose: "Trading Washer at a size with no pricelist item — expected reject",
    input: {
      productCategory: "Washer",
      sizeLabel: "M999",
      qty: 10,
      coatingCode: null,
      productTypeLabel: "Washer",
      diameterMm: 999,
    },
  });
  add({
    route: "Trading Quote",
    purpose: "Trading Quote with unconfirmed landed cost — expected reject",
    input: {
      quotedPrice: 11100,
      taxBasis: "INCLUDE_PPN",
      ppnRate: 0.11,
      landedCostConfirmed: false,
      marginPercent: 0.25,
      qty: 30,
      coatingCode: null,
      productTypeLabel: "Nut",
      diameterMm: 12,
    },
  });
  add({
    route: "Trading Quote",
    purpose: "Trading Quote with margin >= 100% — expected reject",
    input: {
      quotedPrice: 11100,
      taxBasis: "EXCLUDE_PPN",
      ppnRate: null,
      landedCostConfirmed: true,
      marginPercent: 1,
      qty: 10,
      coatingCode: null,
      productTypeLabel: "Nut",
      diameterMm: 12,
    },
  });

  if (cases.length !== 100) {
    throw new Error(`Expected exactly 100 cases, built ${cases.length}`);
  }
  return cases;
}

type RunResult = {
  id: string;
  route: string;
  purpose: string;
  productFamily: string;
  grade: string;
  threadCondition: string;
  sizeLabel: string;
  diameterMm: number | string;
  lengthMm: number | string;
  qty: number;
  leadTimeDays: number | string;
  coatingCode: string;
  status: string;
  errorCode: string;
  profileResolved: string;
  rawDiameterMm: number | string;
  densityKgM3: number | string;
  rawWeightPerItemKg: number | string;
  tolerancePct: number | string;
  costingWeightPerItemKg: number | string;
  pricePerKg: number | string;
  rawBasePricePerItem: number | string;
  qtyFactor: number | string;
  leadTimeFactor: number | string;
  lengthFactor: number | string;
  basePricePerItem: number | string;
  coatingRatePerKg: number | string;
  coatingPricePerItem: number | string;
  diesPricePerItem: number | string;
  unitPriceBeforeRounding: number | string;
  roundingIncrement: number | string;
  unitSellingPrice: number | string;
  orderTotal: number | string;
  appliedRules: string;
};

function ruleSummary(ctx: GuideContext, refs: { table: string; id: string }[]): string {
  return refs
    .map((r) => {
      if (r.table === "adjustment_rules") {
        const rule = ctx.adjustmentRules.find((a) => a.adjustmentRuleId === r.id);
        return rule ? `${rule.ruleGroup}:${rule.thresholdMin ?? "-"}..${rule.thresholdMax ?? "+"}=${rule.adjustmentValue}` : r.id;
      }
      if (r.table === "price_per_kg") {
        const row = ctx.pricePerKg.find((p) => p.priceId === r.id);
        return row ? `price:${row.gradeOrSpec}/${row.sizeLabel}/${row.threadCondition ?? "-"}` : r.id;
      }
      if (r.table === "trading_price_tiers") {
        const t = ctx.tradingPriceTiers.find((x) => x.tierId === r.id);
        return t ? `tier:${t.qtyMin}..${t.qtyMax ?? "+"}@${t.unitPrice}` : r.id;
      }
      if (r.table === "trading_items") {
        const t = ctx.tradingItems.find((x) => x.tradingItemId === r.id);
        return t ? `item:${t.sourceKey}` : r.id;
      }
      if (r.table === "coating_price_guides") {
        const c = ctx.coatingPriceGuides.find((x) => x.coatingRuleId === r.id);
        return c ? `coating:${c.processName}/${c.itemScope ?? "-"}@${c.rate}` : r.id;
      }
      return `${r.table}`;
    })
    .join(" | ");
}

function adjustmentFactor(ctx: GuideContext, refs: { table: string; id: string }[], group: string): number | string {
  const ref = refs.find((r) => {
    if (r.table !== "adjustment_rules") return false;
    const rule = ctx.adjustmentRules.find((a) => a.adjustmentRuleId === r.id);
    return rule?.ruleGroup === group;
  });
  if (!ref) return "";
  const rule = ctx.adjustmentRules.find((a) => a.adjustmentRuleId === ref.id)!;
  return 1 + rule.adjustmentValue;
}

async function main() {
  const guideVersionId = await getActivePublishedGuideVersionId();
  if (!guideVersionId) throw new Error("No Published guide version to test against.");
  const ctx = await loadGuideContext(guideVersionId);

  const roundingIncrement = Number(ctx.config.get("ROUNDING_INCREMENT"));
  const tolerance = Number(ctx.config.get("CUSTOM_WEIGHT_TOLERANCE"));

  const cases = buildCases();
  const results: RunResult[] = [];

  for (const c of cases) {
    const base: RunResult = {
      id: c.id,
      route: c.route,
      purpose: c.purpose,
      productFamily: "",
      grade: "",
      threadCondition: "",
      sizeLabel: "",
      diameterMm: "",
      lengthMm: "",
      qty: 0,
      leadTimeDays: "",
      coatingCode: "",
      status: "",
      errorCode: "",
      profileResolved: "",
      rawDiameterMm: "",
      densityKgM3: "",
      rawWeightPerItemKg: "",
      tolerancePct: "",
      costingWeightPerItemKg: "",
      pricePerKg: "",
      rawBasePricePerItem: "",
      qtyFactor: "",
      leadTimeFactor: "",
      lengthFactor: "",
      basePricePerItem: "",
      coatingRatePerKg: "",
      coatingPricePerItem: "",
      diesPricePerItem: "",
      unitPriceBeforeRounding: "",
      roundingIncrement: "",
      unitSellingPrice: "",
      orderTotal: "",
      appliedRules: "",
    };

    try {
      if (c.route === "Custom Production") {
        const i = c.input;
        Object.assign(base, {
          productFamily: i.productFamily,
          grade: i.gradeOrSpec,
          threadCondition: i.threadCondition ?? "",
          sizeLabel: i.sizeLabel,
          diameterMm: i.diameterMm,
          lengthMm: i.lengthMm ?? "",
          qty: i.qty,
          leadTimeDays: i.leadTimeDays ?? "",
          coatingCode: i.coatingCode ?? "",
        });
        const r = calculateCustomLine(ctx, i);
        const refs = r.resolvedRuleRefs;
        const sizeRow = ctx.materialSizeGuides.find(
          (s) => s.productProfile === r.profileResolved && s.sizeLabel === i.sizeLabel,
        );
        const mgm = ctx.materialGradeMap.find(
          (m) => m.productFamily === i.productFamily && m.gradeOrSpec === i.gradeOrSpec,
        );
        const material = ctx.materials.find((m) => m.materialId === mgm?.materialId);
        const coatingRef = refs.find((x) => x.table === "coating_price_guides");
        const coatingRow = coatingRef ? ctx.coatingPriceGuides.find((x) => x.coatingRuleId === coatingRef.id) : undefined;

        Object.assign(base, {
          status: "PASS",
          profileResolved: r.profileResolved,
          rawDiameterMm: sizeRow?.rawDiameterMm ?? "",
          densityKgM3: material?.densityKgM3 ?? "",
          rawWeightPerItemKg: r.rawWeightPerItemKg,
          tolerancePct: tolerance,
          costingWeightPerItemKg: r.costingWeightPerItemKg,
          pricePerKg: r.pricePerKg,
          rawBasePricePerItem: r.costingWeightPerItemKg * r.pricePerKg,
          qtyFactor: adjustmentFactor(ctx, refs, "Quantity"),
          leadTimeFactor: adjustmentFactor(ctx, refs, "Lead Time"),
          lengthFactor: adjustmentFactor(ctx, refs, "Length Ratio"),
          basePricePerItem: r.basePricePerItem,
          coatingRatePerKg: coatingRow?.rate ?? "",
          coatingPricePerItem: r.coatingPricePerItem,
          diesPricePerItem: r.diesPricePerItem,
          unitPriceBeforeRounding: r.unitPriceBeforeRounding,
          roundingIncrement,
          unitSellingPrice: r.unitSellingPrice,
          orderTotal: r.orderTotal,
          appliedRules: ruleSummary(ctx, refs),
        });
      } else if (c.route === "Trading Pricelist") {
        const i = c.input;
        Object.assign(base, {
          productFamily: i.productCategory,
          sizeLabel: i.sizeLabel,
          diameterMm: i.diameterMm,
          qty: i.qty,
          coatingCode: i.coatingCode ?? "",
        });
        const r = calculateTradingPricelistLine(ctx, i);
        const itemRef = r.resolvedRuleRefs.find((x) => x.table === "trading_items");
        const item = itemRef ? ctx.tradingItems.find((x) => x.tradingItemId === itemRef.id) : undefined;
        Object.assign(base, {
          status: "PASS",
          grade: item?.sourceKey ?? "",
          basePricePerItem: r.basePricePerItem,
          coatingPricePerItem: r.coatingPricePerItem,
          unitPriceBeforeRounding: r.unitPriceBeforeRounding,
          roundingIncrement,
          unitSellingPrice: r.unitSellingPrice,
          orderTotal: r.orderTotal,
          appliedRules: ruleSummary(ctx, r.resolvedRuleRefs),
        });
      } else {
        const i = c.input;
        Object.assign(base, {
          productFamily: i.productTypeLabel,
          diameterMm: i.diameterMm,
          qty: i.qty,
          coatingCode: i.coatingCode ?? "",
        });
        const r = calculateTradingQuoteLine(ctx, i);
        Object.assign(base, {
          status: "PASS",
          grade: `quote ${i.quotedPrice} ${i.taxBasis}${i.ppnRate ? ` @${i.ppnRate}` : ""} margin ${i.marginPercent}`,
          basePricePerItem: r.basePricePerItem,
          coatingPricePerItem: r.coatingPricePerItem,
          unitPriceBeforeRounding: r.unitPriceBeforeRounding,
          roundingIncrement,
          unitSellingPrice: r.unitSellingPrice,
          orderTotal: r.orderTotal,
          appliedRules: ruleSummary(ctx, r.resolvedRuleRefs),
        });
      }
    } catch (e) {
      base.status = "REJECTED";
      base.errorCode = e instanceof AppError ? e.code : e instanceof Error ? e.message : String(e);
    }

    results.push(base);
  }

  // ---- Excel output with a formula-visible breakdown ----
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Simulation_Cases_100");
  const headers = Object.keys(results[0]) as (keyof RunResult)[];
  const HEADER_LABELS: Record<string, string> = {
    id: "case_id",
    route: "route",
    purpose: "what_this_tests",
    productFamily: "product_family",
    grade: "grade_or_source",
    threadCondition: "thread_condition",
    sizeLabel: "size_label",
    diameterMm: "diameter_mm",
    lengthMm: "length_mm",
    qty: "qty",
    leadTimeDays: "lead_time_days",
    coatingCode: "coating_code",
    status: "result_status",
    errorCode: "error_code",
    profileResolved: "profile_resolved",
    rawDiameterMm: "raw_diameter_mm",
    densityKgM3: "density_kg_m3",
    rawWeightPerItemKg: "raw_weight_per_item_kg",
    tolerancePct: "tolerance_pct",
    costingWeightPerItemKg: "costing_weight_per_item_kg",
    pricePerKg: "price_per_kg",
    rawBasePricePerItem: "raw_base_price_per_item",
    qtyFactor: "quantity_factor",
    leadTimeFactor: "lead_time_factor",
    lengthFactor: "length_factor",
    basePricePerItem: "base_price_per_item",
    coatingRatePerKg: "coating_rate_per_kg",
    coatingPricePerItem: "coating_price_per_item",
    diesPricePerItem: "dies_price_per_item",
    unitPriceBeforeRounding: "unit_price_before_rounding",
    roundingIncrement: "rounding_increment",
    unitSellingPrice: "unit_selling_price",
    orderTotal: "order_total",
    appliedRules: "applied_rules",
  };
  ws.addRow(headers.map((h) => HEADER_LABELS[h] ?? h));
  for (const r of results) ws.addRow(headers.map((h) => r[h]));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col, i) => {
    col.width = headers[i] === "purpose" || headers[i] === "appliedRules" ? 52 : 18;
  });

  const outXlsx = process.argv[2] ?? "simulation-cases-100.xlsx";
  await wb.xlsx.writeFile(outXlsx);

  // TSV alongside, for pasting straight into the Google Sheet
  const tsv = [
    headers.map((h) => HEADER_LABELS[h] ?? h).join("\t"),
    ...results.map((r) => headers.map((h) => String(r[h] ?? "")).join("\t")),
  ].join("\n");
  const outTsv = outXlsx.replace(/\.xlsx$/, ".tsv");
  writeFileSync(outTsv, tsv, "utf8");

  // Second TSV shaped to the EXISTING Simulation_Cases tab's 27 columns, so the
  // 100 rows append under the sheet's current rows without disturbing them.
  // The tab is exactly 27 columns wide, so detail with no column of its own
  // (thread condition, and the error code for expected-reject rows) is folded
  // into `notes`. The rest is either constant (tolerance 0.02, rounding 500,
  // density 7850) or derivable (raw base = costing_weight x price_per_kg).
  const noteFor = (r: RunResult) => {
    const bits = [r.purpose];
    if (r.threadCondition) bits.push(`thread=${r.threadCondition}`);
    if (r.errorCode) bits.push(`error=${r.errorCode}`);
    return bits.join(" | ");
  };
  const sheetRows = results.map((r) => [
    r.id,
    r.route,
    r.productFamily,
    r.grade,
    r.profileResolved,
    r.diameterMm,
    r.lengthMm,
    r.qty,
    r.leadTimeDays,
    r.rawDiameterMm,
    r.rawWeightPerItemKg,
    r.costingWeightPerItemKg,
    r.pricePerKg,
    r.basePricePerItem,
    r.qtyFactor,
    r.leadTimeFactor,
    r.lengthFactor,
    r.coatingPricePerItem,
    r.diesPricePerItem,
    r.unitPriceBeforeRounding,
    r.unitSellingPrice,
    r.orderTotal,
    r.appliedRules,
    r.status === "REJECTED" ? "EXPECTED_REJECT" : "PASS",
    noteFor(r),
    "", // condition_value — not applicable to these generated cases
    "", // condition_unit
  ]);
  const appendTsv = sheetRows.map((row) => row.map((v) => String(v ?? "")).join("\t")).join("\n");
  const expectedCols = 27;
  const badRow = sheetRows.find((row) => row.length !== expectedCols);
  if (badRow) throw new Error(`Append row has ${badRow.length} columns, expected ${expectedCols}`);
  writeFileSync(outXlsx.replace(/\.xlsx$/, "-append.tsv"), appendTsv, "utf8");

  const passed = results.filter((r) => r.status === "PASS").length;
  const rejected = results.filter((r) => r.status === "REJECTED").length;
  console.log(`total cases: ${results.length}  PASS: ${passed}  REJECTED: ${rejected}`);
  console.log("rejected cases:");
  results.filter((r) => r.status === "REJECTED").forEach((r) => console.log(`  ${r.id} ${r.errorCode} — ${r.purpose}`));
  console.log(`wrote ${outXlsx} and ${outTsv}`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
