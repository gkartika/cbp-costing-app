import { pool } from "@/lib/db";
import type {
  GuideContext,
  MaterialRow,
  RawBarStockRow,
  DiesCostGuideRow,
  MaterialGradeMapRow,
  GradeProfileRuleRow,
  GradePriceAliasRow,
  MaterialSizeGuideRow,
  PricePerKgRow,
  CoatingPriceGuideRow,
  MinimumPriceRow,
  AdjustmentRuleRow,
  TradingItemRow,
  TradingPriceTierRow,
  CalculationFormulaRow,
  CostingRouteRuleRow,
} from "./types";

/**
 * Loads every active master row for one guide_version_id into memory once.
 * A single costing calculation touches many small lookup tables; batching
 * them into one context avoids dozens of per-line round trips and keeps the
 * pure resolution/pipeline functions independent of the database.
 */
export async function loadGuideContext(guideVersionId: string): Promise<GuideContext> {
  const [
    config,
    materials,
    rawBarStock,
    diesCostGuides,
    materialGradeMap,
    gradeProfileRules,
    gradePriceAliases,
    materialSizeGuides,
    pricePerKg,
    coatingPriceGuides,
    minimumPrices,
    adjustmentRules,
    tradingItems,
    tradingPriceTiers,
    calculationFormulas,
    costingRouteRules,
  ] = await Promise.all([
    pool.query<{ config_key: string; config_value: string }>(
      `SELECT config_key, config_value FROM app_config WHERE guide_version_id = $1 AND status = 'active'`,
      [guideVersionId],
    ),
    pool.query<{ material_id: string; source_key: string; density_kg_m3: string }>(
      `SELECT material_id, source_key, density_kg_m3 FROM materials WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ stock_id: string; material_id: string; diameter_mm: string; size_code: string | null }>(
      `SELECT stock_id, material_id, diameter_mm, size_code FROM raw_bar_stock WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ dies_cost_id: string; product_family: string; product_profile: string; size_label: string; diameter_mm: string; cost: string }>(
      `SELECT dies_cost_id, product_family, product_profile, size_label, diameter_mm, cost FROM dies_cost_guides WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ map_id: string; material_id: string; product_family: string; grade_or_spec: string }>(
      `SELECT map_id, material_id, product_family, grade_or_spec FROM material_grade_map WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ rule_id: string; product_family: string; grade_or_spec: string; default_product_profile: string; display_label: string | null }>(
      `SELECT rule_id, product_family, grade_or_spec, default_product_profile, display_label FROM grade_profile_rules WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ alias_id: string; product_family: string; input_grade: string; canonical_price_grade: string }>(
      `SELECT alias_id, product_family, input_grade, canonical_price_grade FROM grade_price_aliases WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{
      size_guide_id: string;
      product_profile: string;
      size_label: string;
      diameter_mm: string | null;
      raw_diameter_mm: string | null;
      width_flat: string | null;
      width_corner: string | null;
      head_thickness: string | null;
      washer_od: string | null;
      washer_thickness: string | null;
    }>(
      `SELECT size_guide_id, product_profile, size_label, diameter_mm, raw_diameter_mm,
              width_flat, width_corner, head_thickness, washer_od, washer_thickness
       FROM material_size_guides WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{
      price_id: string;
      product_family: string;
      grade_or_spec: string;
      size_label: string | null;
      diameter_mm: string | null;
      selling_price_per_kg: string;
      thread_condition: string | null;
      product_type: string | null;
    }>(
      `SELECT price_id, product_family, grade_or_spec, size_label, diameter_mm, selling_price_per_kg, thread_condition, product_type
       FROM price_per_kg WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ coating_rule_id: string; process_name: string; display_label: string | null; item_scope: string | null; min_diameter_mm: string | null; basis: string; rate: string }>(
      `SELECT coating_rule_id, process_name, display_label, item_scope, min_diameter_mm, basis, rate
       FROM coating_price_guides WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ minimum_price_id: string; product_family: string; material_class: string; minimum_price: string }>(
      `SELECT minimum_price_id, product_family, material_class, minimum_price
       FROM minimum_prices WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{
      adjustment_rule_id: string;
      costing_route: string;
      rule_group: string;
      scope: string;
      condition_field: string;
      threshold_min: string | null;
      threshold_max: string | null;
      adjustment_type: string;
      adjustment_value: string;
      applies_to_component: string;
      min_inclusive: boolean;
      max_inclusive: boolean;
    }>(
      `SELECT adjustment_rule_id, costing_route, rule_group, scope, condition_field, threshold_min, threshold_max,
              adjustment_type, adjustment_value, applies_to_component, min_inclusive, max_inclusive
       FROM adjustment_rules WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{
      trading_item_id: string;
      source_key: string;
      product_category: string;
      product_name: string;
      grade_or_spec: string | null;
      size_label: string;
    }>(
      `SELECT trading_item_id, source_key, product_category, product_name, grade_or_spec, size_label
       FROM trading_items WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ tier_id: string; trading_item_id: string; qty_min: number; qty_max: number | null; unit_price: string }>(
      `SELECT tier_id, trading_item_id, qty_min, qty_max, unit_price FROM trading_price_tiers WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ formula_id: string; product_family: string; formula_scope: string; formula_expression: string; required_inputs: string }>(
      `SELECT formula_id, product_family, formula_scope, formula_expression, required_inputs
       FROM calculation_formulas WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
    pool.query<{ route_rule_id: string; product_family: string; grade_or_spec: string; allowed_costing_route: string }>(
      `SELECT route_rule_id, product_family, grade_or_spec, allowed_costing_route FROM costing_route_rules WHERE guide_version_id = $1 AND active`,
      [guideVersionId],
    ),
  ]);

  const num = (v: string | null): number | null => (v === null ? null : Number(v));

  return {
    guideVersionId,
    config: new Map(config.rows.map((r) => [r.config_key, r.config_value])),
    materials: materials.rows.map(
      (r): MaterialRow => ({ materialId: r.material_id, sourceKey: r.source_key, densityKgM3: Number(r.density_kg_m3) }),
    ),
    rawBarStock: rawBarStock.rows.map(
      (r): RawBarStockRow => ({
        stockId: r.stock_id,
        materialId: r.material_id,
        diameterMm: Number(r.diameter_mm),
        sizeCode: r.size_code,
      }),
    ),
    diesCostGuides: diesCostGuides.rows.map(
      (r): DiesCostGuideRow => ({
        diesCostId: r.dies_cost_id,
        productFamily: r.product_family,
        productProfile: r.product_profile,
        sizeLabel: r.size_label,
        diameterMm: Number(r.diameter_mm),
        cost: Number(r.cost),
      }),
    ),
    materialGradeMap: materialGradeMap.rows.map(
      (r): MaterialGradeMapRow => ({ mapId: r.map_id, materialId: r.material_id, productFamily: r.product_family, gradeOrSpec: r.grade_or_spec }),
    ),
    gradeProfileRules: gradeProfileRules.rows.map(
      (r): GradeProfileRuleRow => ({
        ruleId: r.rule_id,
        productFamily: r.product_family,
        gradeOrSpec: r.grade_or_spec,
        defaultProductProfile: r.default_product_profile,
        displayLabel: r.display_label,
      }),
    ),
    gradePriceAliases: gradePriceAliases.rows.map(
      (r): GradePriceAliasRow => ({
        aliasId: r.alias_id,
        productFamily: r.product_family,
        inputGrade: r.input_grade,
        canonicalPriceGrade: r.canonical_price_grade,
      }),
    ),
    materialSizeGuides: materialSizeGuides.rows.map(
      (r): MaterialSizeGuideRow => ({
        sizeGuideId: r.size_guide_id,
        productProfile: r.product_profile,
        sizeLabel: r.size_label,
        diameterMm: num(r.diameter_mm),
        rawDiameterMm: num(r.raw_diameter_mm),
        widthFlat: num(r.width_flat),
        widthCorner: num(r.width_corner),
        headThickness: num(r.head_thickness),
        washerOd: num(r.washer_od),
        washerThickness: num(r.washer_thickness),
      }),
    ),
    pricePerKg: pricePerKg.rows.map(
      (r): PricePerKgRow => ({
        priceId: r.price_id,
        productFamily: r.product_family,
        gradeOrSpec: r.grade_or_spec,
        sizeLabel: r.size_label,
        diameterMm: num(r.diameter_mm),
        sellingPricePerKg: Number(r.selling_price_per_kg),
        threadCondition: r.thread_condition,
        productType: r.product_type,
      }),
    ),
    coatingPriceGuides: coatingPriceGuides.rows.map(
      (r): CoatingPriceGuideRow => ({
        coatingRuleId: r.coating_rule_id,
        processName: r.process_name,
        displayLabel: r.display_label,
        itemScope: r.item_scope,
        minDiameterMm: num(r.min_diameter_mm),
        basis: r.basis,
        rate: Number(r.rate),
      }),
    ),
    minimumPrices: minimumPrices.rows.map(
      (r): MinimumPriceRow => ({
        minimumPriceId: r.minimum_price_id,
        productFamily: r.product_family,
        materialClass: r.material_class as MinimumPriceRow["materialClass"],
        minimumPrice: Number(r.minimum_price),
      }),
    ),
    adjustmentRules: adjustmentRules.rows.map(
      (r): AdjustmentRuleRow => ({
        adjustmentRuleId: r.adjustment_rule_id,
        costingRoute: r.costing_route,
        ruleGroup: r.rule_group,
        scope: r.scope,
        conditionField: r.condition_field,
        thresholdMin: num(r.threshold_min),
        thresholdMax: num(r.threshold_max),
        adjustmentType: r.adjustment_type,
        adjustmentValue: Number(r.adjustment_value),
        appliesToComponent: r.applies_to_component,
        minInclusive: r.min_inclusive,
        maxInclusive: r.max_inclusive,
      }),
    ),
    tradingItems: tradingItems.rows.map(
      (r): TradingItemRow => ({
        tradingItemId: r.trading_item_id,
        sourceKey: r.source_key,
        productCategory: r.product_category,
        productName: r.product_name,
        gradeOrSpec: r.grade_or_spec,
        sizeLabel: r.size_label,
      }),
    ),
    tradingPriceTiers: tradingPriceTiers.rows.map(
      (r): TradingPriceTierRow => ({
        tierId: r.tier_id,
        tradingItemId: r.trading_item_id,
        qtyMin: r.qty_min,
        qtyMax: r.qty_max,
        unitPrice: Number(r.unit_price),
      }),
    ),
    calculationFormulas: calculationFormulas.rows.map(
      (r): CalculationFormulaRow => ({
        formulaId: r.formula_id,
        productFamily: r.product_family,
        formulaScope: r.formula_scope,
        formulaExpression: r.formula_expression,
        requiredInputs: r.required_inputs.split(",").map((s) => s.trim()),
      }),
    ),
    costingRouteRules: costingRouteRules.rows.map(
      (r): CostingRouteRuleRow => ({
        routeRuleId: r.route_rule_id,
        productFamily: r.product_family,
        gradeOrSpec: r.grade_or_spec,
        allowedCostingRoute: r.allowed_costing_route,
      }),
    ),
  };
}
