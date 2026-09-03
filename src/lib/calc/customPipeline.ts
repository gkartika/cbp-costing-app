import { Errors } from "@/lib/errors";
import type { GuideContext, ResolvedRuleRef, MaterialSizeGuideRow } from "./types";
import type { Value } from "./formulaDsl";
import {
  resolveProfile,
  resolveCanonicalPriceGrade,
  resolveSizeGuide,
  resolveEffectiveWidthCorner,
  resolveRawBarDiameter,
  resolvePricePerKg,
  resolveAdjustmentRule,
  resolveDiesCost,
  resolveMinimumPrice,
} from "./resolvers";
import { evaluateFormula } from "./formulaDsl";
import { getConfigNumber } from "./appConfig";
import { computeCoatingPrice } from "./coating";
import { ceilingToIncrement } from "./rounding";

export type CustomLineInput = {
  productFamily: "Bolt" | "Nut" | "Washer" | "Stud / Anchor";
  gradeOrSpec: string;
  sizeLabel: string;
  diameterMm: number;
  qty: number;
  leadTimeDays: number | null;
  lengthMm: number | null;
  developedCutLengthMm: number | null;
  /** Only meaningful for Bolt, where the guide prices HT and FT separately at the same grade+size. */
  threadCondition?: string | null;
  coatingCode: string | null;
  /**
   * "yes" -> dies already available, no additional cost. "no_lookup" -> dies
   * not available, cost comes from the dies_cost_guides reference (by
   * product_family/product_profile/size). "manual" -> dies not available,
   * cost comes from diesTotalCost (user-entered, "Lainnya"). null -> not set.
   */
  diesOption: "yes" | "no_lookup" | "manual" | null;
  /** Only meaningful when diesOption is "manual". */
  diesTotalCost: number | null;
  /** Overrides app_config.CUSTOM_WEIGHT_TOLERANCE for this line when set; null/omitted means "use the guide's default". */
  weightTolerancePercent?: number | null;
};

export type CustomLineResult = {
  profileResolved: string;
  rawWeightPerItemKg: number;
  costingWeightPerItemKg: number;
  pricePerKg: number;
  basePricePerItem: number;
  coatingPricePerItem: number;
  diesPricePerItem: number;
  unitPriceBeforeRounding: number;
  unitSellingPrice: number;
  orderTotal: number;
  resolvedRuleRefs: ResolvedRuleRef[];
  formulaId: string;
  formulaInputs: Record<string, Value>;
};

function productTypeLabel(input: CustomLineInput): "Bolt" | "Nut" | "Washer" | "Stud" | "Anchor" {
  if (input.productFamily !== "Stud / Anchor") return input.productFamily;
  if (input.developedCutLengthMm !== null) return "Anchor";
  if (input.lengthMm !== null) return "Stud";
  throw Errors.anchorDevelopedLengthRequired();
}

const BOLT_LEAD_TIME_CARBON_LOW = new Set(["4.6", "5.6", "A307", "6.8", "A307B"]);
const BOLT_LEAD_TIME_STAINLESS_LOW = new Set([
  "SS304",
  "SS304L",
  "SUS304L",
  "A2-70",
  "A193-B8",
  "SS316",
  "SS316L",
  "SUS316L",
  "A4-70",
  "A193-B8M",
]);
const BOLT_LEAD_TIME_STAINLESS_HIGH = new Set(["SUS310", "SS310"]);

/**
 * CBP's real lead-time surcharge card (confirmed by the business, 2026-08-24)
 * is grade-tiered, not flat per family: carbon/alloy grades split into a
 * low-strength group (4.6/A307/6.8/A307B) and a high-strength group (8.8 and
 * up), and stainless has its own separate, higher-surcharge card where SUS310
 * carries a steeper rate than the 304/316 family. HT vs FT does not affect
 * the rate, only grade does.
 */
function boltLeadTimeScope(gradeOrSpec: string): string {
  const g = gradeOrSpec.trim().toUpperCase();
  if (BOLT_LEAD_TIME_STAINLESS_HIGH.has(g)) return "Bolt|StainlessHigh";
  if (BOLT_LEAD_TIME_STAINLESS_LOW.has(g)) return "Bolt|StainlessLow";
  if (BOLT_LEAD_TIME_CARBON_LOW.has(g)) return "Bolt|CarbonLow";
  return "Bolt|CarbonHigh";
}

const BOLT_STAINLESS_GRADES = new Set([...BOLT_LEAD_TIME_STAINLESS_LOW, ...BOLT_LEAD_TIME_STAINLESS_HIGH]);

/**
 * CBP's real Bolt quantity-break card (confirmed 2026-08-24) is only
 * carbon-vs-stainless — unlike Lead Time, it does NOT split by strength
 * class within each material family (e.g. 4.6 and 12.9 share one schedule),
 * and stainless has no separate SUS310 rate here either.
 */
function boltQuantityScope(gradeOrSpec: string): string {
  const g = gradeOrSpec.trim().toUpperCase();
  return BOLT_STAINLESS_GRADES.has(g) ? "Bolt|Stainless" : "Bolt|Carbon";
}

// Nut's tier boundary sits one property class over from Bolt's: 8.8/2H is
// low tier for Nut (high tier for Bolt), and A563 (the general heavy-hex
// grade, mapped to SCM440) is confirmed low tier too. Stainless has no
// SUS310 premium for Nut, unlike Bolt — a single flat stainless scope.
const NUT_LEAD_TIME_CARBON_LOW = new Set(["4.6", "6.8", "8.8", "2H", "A563"]);
const NUT_LEAD_TIME_STAINLESS = new Set([
  "SS304",
  "SS304L",
  "SUS304",
  "SUS304L",
  "A2-70",
  "A194-8",
  "SS316",
  "SS316L",
  "SUS316",
  "SUS316L",
  "A4-70",
  "A194-8M",
  "SUS310",
  "SS310",
]);

/**
 * Stainless vs Non-Stainless for one grade, reusing the same grade sets the
 * Lead Time and Quantity cards already classify by — CBP's minimum-price card
 * splits on exactly this axis, so a second, independently-maintained list of
 * stainless grades would be a source of silent drift.
 */
export function materialClassFor(productFamily: string, gradeOrSpec: string): "Stainless" | "Non-Stainless" {
  const g = gradeOrSpec.trim().toUpperCase();
  const stainless = productFamily === "Nut" ? NUT_LEAD_TIME_STAINLESS.has(g) : BOLT_STAINLESS_GRADES.has(g);
  return stainless ? "Stainless" : "Non-Stainless";
}

function nutLeadTimeScope(gradeOrSpec: string): string {
  const g = gradeOrSpec.trim().toUpperCase();
  if (NUT_LEAD_TIME_STAINLESS.has(g)) return "Nut|Stainless";
  if (NUT_LEAD_TIME_CARBON_LOW.has(g)) return "Nut|CarbonLow";
  return "Nut|CarbonHigh";
}

export function calculateCustomLine(ctx: GuideContext, input: CustomLineInput): CustomLineResult {
  const refs: ResolvedRuleRef[] = [];
  const typeLabel = productTypeLabel(input);

  // costing_route_rules exists precisely for cases like Washer F436, whose
  // price lives in Trading (a fixed pricelist), not in Price_Per_Kg — picking
  // Custom Production for it used to fail deep inside profile/size/price
  // resolution with a generic error that gave no hint the route itself was
  // wrong. Checked before any of that resolution runs, so the failure names
  // the actual problem.
  const routeRule = ctx.costingRouteRules.find(
    (r) => r.productFamily === input.productFamily && r.gradeOrSpec === input.gradeOrSpec,
  );
  if (routeRule && routeRule.allowedCostingRoute !== "Custom Production") {
    throw Errors.wrongCostingRoute(input.gradeOrSpec, routeRule.allowedCostingRoute);
  }

  const { profile, ref: profileRef } = resolveProfile(ctx, input.productFamily, input.gradeOrSpec);
  refs.push(profileRef);

  const { row: sizeGuide, ref: sizeRef } = resolveSizeGuide(ctx, profile, input.sizeLabel);
  refs.push(sizeRef);

  const materialMap = ctx.materialGradeMap.find(
    (m) => m.productFamily === input.productFamily && m.gradeOrSpec === input.gradeOrSpec,
  );
  if (!materialMap) throw Errors.rawSizeInvalid();
  const material = ctx.materials.find((m) => m.materialId === materialMap.materialId);
  if (!material) throw Errors.rawSizeInvalid();
  refs.push({ table: "material_grade_map", id: materialMap.mapId });

  // Raw bar diameter is material-dependent (DEC-039) — only Bolt/Stud/Anchor
  // formulas consume it, so resolving it for Nut/Washer would be pointless
  // and could wrongly reject a line whose material happens to have stock
  // rows that don't reach this nominal size, even though that line never
  // needed a raw bar at all.
  let resolvedRawDiameterMm: number | null = null;
  if (typeLabel === "Bolt" || typeLabel === "Stud" || typeLabel === "Anchor") {
    const rawBar = resolveRawBarDiameter(ctx, material.materialId, input.diameterMm, sizeGuide.rawDiameterMm);
    resolvedRawDiameterMm = rawBar.rawDiameterMm;
    if (rawBar.ref) refs.push(rawBar.ref);
  }

  const formulaScope =
    typeLabel === "Anchor"
      ? "raw_cut_weight_developed_length"
      : typeLabel === "Stud"
        ? "raw_cut_weight_finished_length"
        : "raw_cut_weight_per_item";
  const formula = ctx.calculationFormulas.find(
    (f) => f.productFamily === input.productFamily && f.formulaScope === formulaScope,
  );
  if (!formula) throw new Error(`No calculation formula for ${input.productFamily}/${formulaScope}`);

  const formulaInputs = buildFormulaInputs(typeLabel, input, sizeGuide, material.densityKgM3, profile, resolvedRawDiameterMm);
  const env = evaluateFormula(formula.formulaExpression, formulaInputs);
  const rawWeightPerItemKg = env.raw_weight;
  if (typeof rawWeightPerItemKg !== "number" || !Number.isFinite(rawWeightPerItemKg) || rawWeightPerItemKg <= 0) {
    throw Errors.weightInvalid();
  }
  refs.push({ table: "calculation_formulas", id: formula.formulaId });

  const tolerance = input.weightTolerancePercent ?? getConfigNumber(ctx, "CUSTOM_WEIGHT_TOLERANCE");
  const costingWeightPerItemKg = rawWeightPerItemKg * (1 + tolerance);

  const { canonicalGrade, ref: aliasRef } = resolveCanonicalPriceGrade(ctx, input.productFamily, input.gradeOrSpec);
  if (aliasRef) refs.push(aliasRef);
  const { pricePerKg, ref: priceRef } = resolvePricePerKg(ctx, input.productFamily, canonicalGrade, input.sizeLabel, {
    threadCondition: input.productFamily === "Bolt" ? (input.threadCondition ?? null) : undefined,
    productTypeLabel: input.productFamily === "Stud / Anchor" ? typeLabel : undefined,
    nominalDiameterMm: input.diameterMm,
  });
  refs.push(priceRef);

  const rawBasePrice = costingWeightPerItemKg * pricePerKg;

  let basePricePerItem = rawBasePrice;
  const qtyAdj = resolveAdjustmentRule(ctx, {
    costingRoute: "Custom Production",
    ruleGroup: "Quantity",
    scope: typeLabel === "Bolt" ? boltQuantityScope(input.gradeOrSpec) : typeLabel,
    value: input.qty,
  });
  if (qtyAdj) {
    basePricePerItem *= 1 + qtyAdj.rule.adjustmentValue;
    refs.push(qtyAdj.ref);
  }

  if (input.leadTimeDays !== null) {
    const leadTimeScope =
      typeLabel === "Bolt"
        ? boltLeadTimeScope(input.gradeOrSpec)
        : typeLabel === "Nut"
          ? nutLeadTimeScope(input.gradeOrSpec)
          : typeLabel;
    const leadAdj = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Lead Time",
      scope: leadTimeScope,
      value: input.leadTimeDays,
    });
    if (leadAdj) {
      basePricePerItem *= 1 + leadAdj.rule.adjustmentValue;
      refs.push(leadAdj.ref);
    }
  }

  const effectiveLength = input.lengthMm ?? input.developedCutLengthMm;
  if (effectiveLength !== null) {
    const lengthDiameterRatio = effectiveLength / input.diameterMm;
    const lengthAdj = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Length Ratio",
      scope: typeLabel,
      value: lengthDiameterRatio,
    });
    if (lengthAdj) {
      basePricePerItem *= 1 + lengthAdj.rule.adjustmentValue;
      refs.push(lengthAdj.ref);
    }
  }

  // CBP's minimum selling price is a floor on the item itself, applied after
  // every quantity/lead-time/length adjustment but BEFORE coating and dies are
  // added (confirmed 2026-08-25) — so a coated cheap item clears the floor on
  // its own merits and then still pays for its coating on top.
  const minimum = resolveMinimumPrice(ctx, input.productFamily, materialClassFor(input.productFamily, input.gradeOrSpec));
  if (minimum && basePricePerItem < minimum.minimumPrice) {
    basePricePerItem = minimum.minimumPrice;
    refs.push(minimum.ref);
  }

  const coating = computeCoatingPrice(ctx, {
    coatingCode: input.coatingCode,
    productTypeLabel: typeLabel,
    diameterMm: input.diameterMm,
    costingWeightPerItemKg,
    qty: input.qty,
    lengthMm: input.lengthMm,
  });
  refs.push(...coating.refs);

  let diesPricePerItem = 0;
  if (input.diesOption === "manual") {
    if (input.diesTotalCost === null || input.diesTotalCost < 0) throw Errors.diesCostRequired();
    if (input.qty < 1) throw Errors.qtyInvalid();
    diesPricePerItem = input.diesTotalCost / input.qty;
  } else if (input.diesOption === "no_lookup") {
    if (input.qty < 1) throw Errors.qtyInvalid();
    const dies = resolveDiesCost(ctx, { productFamily: input.productFamily, productProfile: profile, diameterMm: input.diameterMm });
    refs.push(dies.ref);
    diesPricePerItem = dies.cost / input.qty;
  }

  const unitPriceBeforeRounding = basePricePerItem + coating.coatingPricePerItem + diesPricePerItem;
  const roundingIncrement = getConfigNumber(ctx, "ROUNDING_INCREMENT");
  const unitSellingPrice = ceilingToIncrement(unitPriceBeforeRounding, roundingIncrement);
  const orderTotal = unitSellingPrice * input.qty;

  return {
    profileResolved: profile,
    rawWeightPerItemKg,
    costingWeightPerItemKg,
    pricePerKg,
    basePricePerItem,
    coatingPricePerItem: coating.coatingPricePerItem,
    diesPricePerItem,
    unitPriceBeforeRounding,
    unitSellingPrice,
    orderTotal,
    resolvedRuleRefs: refs,
    formulaId: formula.formulaId,
    formulaInputs,
  };
}

function buildFormulaInputs(
  typeLabel: "Bolt" | "Nut" | "Washer" | "Stud" | "Anchor",
  input: CustomLineInput,
  sizeGuide: MaterialSizeGuideRow,
  densityKgM3: number,
  profile: string,
  resolvedRawDiameterMm: number | null,
): Record<string, Value> {
  switch (typeLabel) {
    case "Bolt": {
      if (resolvedRawDiameterMm === null || resolvedRawDiameterMm <= 0) throw Errors.rawSizeInvalid();
      if (sizeGuide.headThickness === null || sizeGuide.headThickness <= 0) throw Errors.rawSizeInvalid();
      if (input.lengthMm === null || input.lengthMm <= 0) throw Errors.rawSizeInvalid();
      resolveEffectiveWidthCorner(sizeGuide); // pre-check: throws HEX_WIDTH_MISSING if both absent
      return {
        raw_diameter: resolvedRawDiameterMm,
        width_corner: sizeGuide.widthCorner ?? (null as unknown as number),
        width_flat: sizeGuide.widthFlat ?? (null as unknown as number),
        head_thickness: sizeGuide.headThickness,
        finished_length: input.lengthMm,
        density: densityKgM3,
      };
    }
    case "Nut": {
      if (input.diameterMm <= 0) throw Errors.rawSizeInvalid();
      resolveEffectiveWidthCorner(sizeGuide);
      return {
        profile,
        diameter: input.diameterMm,
        width_corner: sizeGuide.widthCorner ?? (null as unknown as number),
        width_flat: sizeGuide.widthFlat ?? (null as unknown as number),
        density: densityKgM3,
      };
    }
    case "Washer": {
      if (sizeGuide.washerOd === null || sizeGuide.washerOd <= 0) throw Errors.rawSizeInvalid();
      if (sizeGuide.washerThickness === null || sizeGuide.washerThickness <= 0) throw Errors.rawSizeInvalid();
      return { washer_od: sizeGuide.washerOd, washer_thickness: sizeGuide.washerThickness, density: densityKgM3 };
    }
    case "Stud": {
      if (resolvedRawDiameterMm === null || resolvedRawDiameterMm <= 0) throw Errors.rawSizeInvalid();
      if (input.lengthMm === null || input.lengthMm <= 0) throw Errors.rawSizeInvalid();
      return { raw_diameter: resolvedRawDiameterMm, finished_length: input.lengthMm, density: densityKgM3 };
    }
    case "Anchor": {
      if (resolvedRawDiameterMm === null || resolvedRawDiameterMm <= 0) throw Errors.rawSizeInvalid();
      if (input.developedCutLengthMm === null || input.developedCutLengthMm <= 0) {
        throw Errors.anchorDevelopedLengthRequired();
      }
      return {
        raw_diameter: resolvedRawDiameterMm,
        developed_cut_length: input.developedCutLengthMm,
        density: densityKgM3,
      };
    }
  }
}
